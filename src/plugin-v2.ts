import type { Credential, Model, Plugin, Provider } from '@opencode/plugin'
import type {
  IntegrationOAuthMethod,
  IntegrationOAuthMethodRegistration
} from '@opencode/plugin/promise/integration'
import {
  validateIdcRegion,
  validateProfileArn,
  validateStartUrl
} from './core/auth/auth-handler.js'
import { IdcAuthMethod } from './core/auth/idc-auth-method.js'
import type { KiroConfig } from './plugin/config/index.js'
import * as logger from './plugin/logger.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import {
  createKiroRuntime,
  isWebSearchAvailable,
  KIRO_PROVIDER_ID,
  runWebSearch,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_QUERY_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  type KiroRuntime,
  type ToastFunction
} from './runtime.js'
import { createKiroSDK } from './v2-sdk.js'

/**
 * OpenCode V2 routes `aisdk:` packages through an AI SDK provider. The plugin
 * builds that provider itself (see the `sdk` hook) so it can install the custom
 * fetch that translates OpenAI-compatible requests into Kiro API calls.
 *
 * The package names v2-sdk.js by file URL rather than `@ai-sdk/openai-compatible`:
 * V2 rewrites that npm name onto its native openai-compatible route whenever the
 * provider or a model is updated (a user `providers.kiro` override always does),
 * and the native route never calls the `sdk` hook.
 */
export const KIRO_V2_PACKAGE = `aisdk:${new URL('./v2-sdk.js', import.meta.url).href}`

type FormFields = NonNullable<IntegrationOAuthMethod['form']>
// V2 has no server-side toast API, so user-facing notices go to the plugin log.
const logToast: ToastFunction = (message, variant) => {
  if (variant === 'error') logger.error(message)
  else if (variant === 'warning') logger.warn(message)
  else logger.log(message)
}

/**
 * Convert the plugin's model registry into V2 model definitions.
 *
 * V2 has no `reasoning` / `interleaved` model flags: the AI SDK provider reads
 * the `reasoning_content` deltas the plugin emits on its own. Thinking variants
 * become V2 variant `settings`, which the AI SDK forwards as provider options
 * into the request body, where the request handler reads `thinkingConfig`.
 */
export function buildV2Models(providerID: string = KIRO_PROVIDER_ID): Model.Info[] {
  return Object.entries(buildModelRegistry()).map(([id, entry]) => {
    const spec = entry as {
      name: string
      limit: { context: number; output: number }
      modalities: { input: string[]; output: string[] }
      variants?: Record<string, Record<string, unknown>>
    }
    return {
      id,
      modelID: id,
      providerID,
      // Set per model, not only on the provider: V2 applies user config after
      // plugins, and a legacy `provider.kiro.npm` / `providers.kiro.package`
      // replaces the provider package. A model-level package survives that.
      package: KIRO_V2_PACKAGE,
      name: spec.name,
      capabilities: {
        tools: true,
        input: [...spec.modalities.input],
        output: [...spec.modalities.output]
      },
      variants: Object.entries(spec.variants ?? {}).map(([variantID, settings]) => ({
        id: variantID,
        settings
      })),
      time: { released: 0 },
      cost: [],
      status: 'active',
      enabled: true,
      limit: { ...spec.limit }
    } as unknown as Model.Info
  })
}

export function buildV2ProviderInfo(baseURL: string): Provider.Info {
  return {
    id: KIRO_PROVIDER_ID,
    name: 'Kiro',
    // Credentials live in kiro.db (synced from kiro-cli or the login flow below),
    // so the provider is usable without an OpenCode connection.
    activation: 'enabled',
    package: KIRO_V2_PACKAGE,
    settings: { baseURL }
  } as unknown as Provider.Info
}

// Blank is allowed for every field; validators in auth-handler.ts remain the backstop.
export const START_URL_PATTERN = '^\\s*(https?://\\S+)?\\s*$'
export const REGION_PATTERN = '^\\s*([a-z]{2}(-gov)?-[a-z]+-\\d+)?\\s*$'
export const PROFILE_ARN_PATTERN = '^\\s*(arn:aws:(codewhisperer|qdeveloper):\\S+)?\\s*$'

const answerText = (answer: Record<string, unknown>, key: string): string =>
  typeof answer[key] === 'string' ? (answer[key] as string).trim() : ''

/**
 * Adapt the V1 device-code login to a V2 integration OAuth method. The account
 * is still stored in kiro.db by IdcAuthMethod; the OpenCode credential only
 * records that a login happened, so it carries no token.
 */
function oauthMethod(
  runtime: KiroRuntime,
  method: { id: string; label: string; requireProfileArn: boolean },
  onLogin: () => void
): IntegrationOAuthMethodRegistration {
  const { config } = runtime
  const idc = new IdcAuthMethod(config, runtime.repository, runtime.accountManager)

  const fields: Array<Record<string, unknown>> = [
    {
      type: 'string',
      key: 'start_url',
      title: 'IAM Identity Center Start URL',
      description: config.idc_start_url
        ? `Leave blank to keep ${config.idc_start_url}`
        : 'Leave blank to sign in with AWS Builder ID',
      placeholder: 'https://your-company.awsapps.com/start',
      // V2 checks patterns before calling authorize, so bad input gets a
      // readable error instead of an internal one.
      pattern: START_URL_PATTERN,
      required: false
    },
    {
      type: 'string',
      key: 'idc_region',
      title: 'IAM Identity Center region (sso_region)',
      description: `Leave blank for ${config.idc_region || 'us-east-1'}`,
      placeholder: 'us-east-1',
      pattern: REGION_PATTERN,
      required: false
    }
  ]
  if (method.requireProfileArn) {
    fields.push({
      type: 'string',
      key: 'profile_arn',
      title: 'Profile ARN',
      description: config.idc_profile_arn
        ? `Leave blank to keep ${config.idc_profile_arn}`
        : 'e.g. arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX',
      placeholder: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX',
      pattern: PROFILE_ARN_PATTERN,
      required: !config.idc_profile_arn
    })
  }

  return {
    integrationID: KIRO_PROVIDER_ID,
    method: {
      id: method.id,
      type: 'oauth',
      label: method.label,
      form: fields as unknown as FormFields
    },
    label: (credential) =>
      typeof credential.metadata?.email === 'string' ? credential.metadata.email : undefined,
    authorize: async (answer) => {
      const inputs = {
        start_url: answerText(answer, 'start_url'),
        idc_region: answerText(answer, 'idc_region'),
        profile_arn: answerText(answer, 'profile_arn')
      }
      const invalid =
        validateStartUrl(inputs.start_url) ??
        validateIdcRegion(inputs.idc_region) ??
        (method.requireProfileArn
          ? validateProfileArn(inputs.profile_arn, config.idc_profile_arn)
          : undefined)
      if (invalid) throw new Error(invalid)

      const authorization = await idc.authorize(inputs)
      if (authorization.method !== 'auto') throw new Error('Unexpected Kiro authorization mode')

      const callback = authorization.callback().then(async (result): Promise<Credential.OAuth> => {
        if (result.type !== 'success') throw new Error('Kiro authorization failed')
        runtime.repository.invalidateCache()
        const accounts = await runtime.repository.findAll()
        const email = accounts.find((a) => a.accessToken === (result as any).key)?.email
        onLogin()
        return {
          type: 'oauth',
          methodID: method.id,
          refresh: '',
          access: '',
          expires: 0,
          ...(email ? { metadata: { email } } : {})
        } as unknown as Credential.OAuth
      })
      // OpenCode awaits this promise itself; keep an early rejection from being
      // reported as unhandled before it attaches its handler.
      callback.catch(() => {})

      return {
        mode: 'auto',
        url: authorization.url,
        instructions: authorization.instructions,
        callback
      }
    }
  }
}

function registerWebSearch(ctx: Plugin.Context, config: KiroConfig, runtime: KiroRuntime) {
  return ctx.tool.transform((editor) => {
    if (!isWebSearchAvailable(config, runtime.accountManager)) return
    editor.add({
      name: WEB_SEARCH_TOOL_NAME,
      description: WEB_SEARCH_DESCRIPTION,
      input: {
        type: 'object',
        properties: { query: { type: 'string', description: WEB_SEARCH_QUERY_DESCRIPTION } },
        required: ['query'],
        additionalProperties: false
      },
      execute: async (input: unknown) => ({
        content: await runWebSearch(runtime.accountManager, (input as { query: string }).query)
      })
    } as any)
  })
}

/** OpenCode V2 entrypoint, called with the V2 plugin context. */
export async function setupKiroV2(
  ctx: Plugin.Context,
  createRuntime: (directory: string) => Promise<KiroRuntime> = createKiroRuntime
): Promise<void> {
  const runtime = await createRuntime(ctx.location.directory)
  const { config, authHandler, requestHandler, baseURL } = runtime
  const models = buildV2Models()

  // Kiro CLI sync can take a moment; requests wait for it instead of setup.
  const ready = authHandler.initialize(logToast).catch((e) => {
    logger.error('Kiro auth initialization failed', e)
  })

  const kiroFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    await ready
    return requestHandler.handle(input, init, logToast)
  }

  // A new account can make web search available (it needs a Pro profileArn).
  const reloadTools = () => void ctx.tool.reload().catch(() => {})

  await ctx.integration.transform((editor) => {
    editor.update(KIRO_PROVIDER_ID, (integration) => {
      integration.name = 'Kiro'
    })
    editor.method.update(
      oauthMethod(
        runtime,
        {
          id: 'idc',
          label: 'AWS Builder ID / IAM Identity Center',
          requireProfileArn: false
        },
        reloadTools
      )
    )
    editor.method.update(
      oauthMethod(
        runtime,
        {
          id: 'idc-profile',
          label: 'IAM Identity Center with Profile ARN',
          requireProfileArn: true
        },
        reloadTools
      )
    )
  })

  // User `providers.kiro` config is applied by a builtin plugin that runs after
  // this one, so it overlays these definitions rather than being replaced.
  await ctx.provider.transform((editor) => {
    editor.add({ info: buildV2ProviderInfo(baseURL), models })
  })

  await ctx.aisdk.hook(
    'sdk',
    (event) => {
      if (event.model.providerID !== KIRO_PROVIDER_ID) return
      // OpenCode caches one SDK per provider settings/body combination, so the
      // body overlay captured here (model plus selected variant) stays stable.
      event.sdk = createKiroSDK(event.options, {
        baseURL,
        fetch: kiroFetch,
        overlay: event.model.body
      })
    },
    { providerID: KIRO_PROVIDER_ID }
  )

  await registerWebSearch(ctx, config, runtime)
  // Accounts synced from kiro-cli can make web search available after setup.
  void ready.then(reloadTools)
}
