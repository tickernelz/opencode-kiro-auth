import { exec } from 'node:child_process'
import { KIRO_CONSTANTS } from './constants'
import { accessTokenExpired } from './kiro/auth'
import type { KiroIDCTokenResult } from './kiro/oauth-idc'
import { authorizeKiroIDC } from './kiro/oauth-idc'
import { AccountManager, createDeterministicAccountId } from './plugin/accounts'
import { promptAddAnotherAccount, promptLoginMode } from './plugin/cli'
import { loadConfig } from './plugin/config'
import { KiroTokenRefreshError } from './plugin/errors'
import * as logger from './plugin/logger'
import { transformToCodeWhisperer } from './plugin/request'
import { parseEventStream } from './plugin/response'
import { startIDCAuthServer } from './plugin/server'
import { migrateJsonToSqlite } from './plugin/storage/migration'
import { kiroDb } from './plugin/storage/sqlite'
import { transformKiroStream } from './plugin/streaming'
import { syncFromKiroCli } from './plugin/sync/kiro-cli'
import { refreshAccessToken } from './plugin/token'
import type { ManagedAccount } from './plugin/types'
import { fetchUsageLimits, updateAccountQuota } from './plugin/usage'

const KIRO_PROVIDER_ID = 'kiro'
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isNetworkError = (e: any) =>
  e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
const extractModel = (url: string) => url.match(/models\/([^/:]+)/)?.[1] || null
const formatUsageMessage = (usedCount: number, limitCount: number, email: string): string => {
  if (limitCount > 0) {
    const percentage = Math.round((usedCount / limitCount) * 100)
    return `Usage (${email}): ${usedCount}/${limitCount} (${percentage}%)`
  }
  return `Usage (${email}): ${usedCount}`
}
const openBrowser = (url: string) => {
  const escapedUrl = url.replace(/"/g, '\\"')
  const platform = process.platform
  const cmd =
    platform === 'win32'
      ? `cmd /c start "" "${escapedUrl}"`
      : platform === 'darwin'
        ? `open "${escapedUrl}"`
        : `xdg-open "${escapedUrl}"`
  exec(cmd, (error) => {
    if (error) logger.warn(`Browser error: ${error.message}`)
  })
}
export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)
    const showToast = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }
    return {
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await migrateJsonToSqlite()
          if (config.auto_sync_kiro_cli) await syncFromKiroCli()
          const am = await AccountManager.loadFromDisk(config.account_selection_strategy)
          const allAccs = am.getAccounts()
          for (const acc of allAccs) {
            if (acc.isHealthy && (!acc.lastSync || Date.now() - acc.lastSync > 3600000)) {
              try {
                const auth = am.toAuthDetails(acc)
                const u = await fetchUsageLimits(auth)
                am.updateUsage(acc.id, {
                  usedCount: u.usedCount,
                  limitCount: u.limitCount,
                  email: u.email
                })
              } catch {}
            }
          }
          await am.saveToDisk()
          return {
            apiKey: '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
              '{{region}}',
              config.default_region || 'us-east-1'
            ),
            async fetch(input: any, init?: any): Promise<Response> {
              const url = typeof input === 'string' ? input : input.url
              if (!KIRO_API_PATTERN.test(url)) return fetch(input, init)
              const body = init?.body ? JSON.parse(init.body) : {}
              const model = extractModel(url) || body.model || 'claude-sonnet-4-5'
              const think = model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig
              const budget = body.providerOptions?.thinkingConfig?.thinkingBudget || 20000
              let retry = 0,
                iterations = 0,
                reductionFactor = 1.0
              let triedEmptySync = false
              const startTime = Date.now(),
                maxIterations = config.max_request_iterations,
                timeoutMs = config.request_timeout_ms
              while (true) {
                iterations++
                if (iterations > maxIterations)
                  throw new Error(`Exceeded max iterations (${maxIterations})`)
                if (Date.now() - startTime > timeoutMs) throw new Error('Request timeout')
                let count = am.getAccountCount()
                if (count === 0 && config.auto_sync_kiro_cli && !triedEmptySync) {
                  triedEmptySync = true
                  await syncFromKiroCli()
                  const refreshedAm = await AccountManager.loadFromDisk(
                    config.account_selection_strategy
                  )
                  for (const a of refreshedAm.getAccounts()) am.addAccount(a)
                  count = am.getAccountCount()
                }
                if (count === 0) throw new Error('No accounts')
                let acc = am.getCurrentOrNext()
                if (!acc) {
                  const wait = am.getMinWaitTime()
                  if (wait > 0 && wait < 30000) {
                    if (am.shouldShowToast())
                      showToast(
                        `All accounts rate-limited. Waiting ${Math.ceil(wait / 1000)}s...`,
                        'warning'
                      )
                    await sleep(wait)
                    continue
                  }
                  throw new Error('All accounts are unhealthy or rate-limited')
                }
                if (am.shouldShowToast())
                  showToast(
                    `Using ${acc.email} (${am.getAccounts().indexOf(acc) + 1}/${count})`,
                    'info'
                  )
                if (
                  am.shouldShowUsageToast() &&
                  acc.usedCount !== undefined &&
                  acc.limitCount !== undefined
                ) {
                  const p = acc.limitCount > 0 ? (acc.usedCount / acc.limitCount) * 100 : 0
                  showToast(
                    formatUsageMessage(acc.usedCount, acc.limitCount, acc.email),
                    p >= 80 ? 'warning' : 'info'
                  )
                }
                const auth = am.toAuthDetails(acc)
                if (accessTokenExpired(auth, config.token_expiry_buffer_ms)) {
                  try {
                    const newAuth = await refreshAccessToken(auth)
                    am.updateFromAuth(acc, newAuth)
                    await am.saveToDisk()
                  } catch (e: any) {
                    if (config.auto_sync_kiro_cli) await syncFromKiroCli()
                    const refreshedAm = await AccountManager.loadFromDisk(
                      config.account_selection_strategy
                    )
                    const stillAcc = refreshedAm.getAccounts().find((a) => a.id === acc!.id)
                    if (
                      stillAcc &&
                      !accessTokenExpired(
                        refreshedAm.toAuthDetails(stillAcc),
                        config.token_expiry_buffer_ms
                      )
                    ) {
                      showToast('Credentials recovered from Kiro CLI sync.', 'info')
                      acc = stillAcc
                      continue
                    }
                    if (
                      e instanceof KiroTokenRefreshError &&
                      (e.code === 'ExpiredTokenException' ||
                        e.code === 'InvalidTokenException' ||
                        e.code === 'HTTP_401' ||
                        e.code === 'HTTP_403')
                    ) {
                      am.markUnhealthy(acc, e.message)
                      await am.saveToDisk()
                      continue
                    }
                    throw e
                  }
                }
                const prepRequest = (f: number) =>
                  transformToCodeWhisperer(url, init?.body, model, auth, think, budget, f)
                let prep = prepRequest(reductionFactor)
                const apiTimestamp = config.enable_log_api_request ? logger.getTimestamp() : null
                if (config.enable_log_api_request && apiTimestamp) {
                  let b = null
                  try {
                    b = prep.init.body ? JSON.parse(prep.init.body as string) : null
                  } catch {}
                  logger.logApiRequest(
                    {
                      url: prep.url,
                      method: prep.init.method,
                      headers: prep.init.headers,
                      body: b,
                      conversationId: prep.conversationId,
                      model: prep.effectiveModel,
                      email: acc.email
                    },
                    apiTimestamp
                  )
                }
                try {
                  const res = await fetch(prep.url, prep.init)
                  if (config.enable_log_api_request && apiTimestamp) {
                    const h: any = {}
                    res.headers.forEach((v, k) => {
                      h[k] = v
                    })
                    logger.logApiResponse(
                      {
                        status: res.status,
                        statusText: res.statusText,
                        headers: h,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel
                      },
                      apiTimestamp
                    )
                  }
                  if (res.ok) {
                    if (acc.failCount && acc.failCount > 0) {
                      acc.failCount = 0
                      kiroDb.upsertAccount(acc)
                    }
                    if (config.usage_tracking_enabled) {
                      const sync = async (att = 0): Promise<void> => {
                        try {
                          const u = await fetchUsageLimits(auth)
                          updateAccountQuota(acc!, u, am)
                          await am.saveToDisk()
                        } catch (e: any) {
                          if (att < config.usage_sync_max_retries) {
                            await sleep(1000 * Math.pow(2, att))
                            return sync(att + 1)
                          }
                        }
                      }
                      sync().catch(() => {})
                    }
                    if (prep.streaming) {
                      const s = transformKiroStream(res, model, prep.conversationId)
                      return new Response(
                        new ReadableStream({
                          async start(c) {
                            try {
                              for await (const e of s)
                                c.enqueue(
                                  new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)
                                )
                              c.close()
                            } catch (err) {
                              c.error(err)
                            }
                          }
                        }),
                        { headers: { 'Content-Type': 'text/event-stream' } }
                      )
                    }
                    const text = await res.text(),
                      p = parseEventStream(text),
                      oai: any = {
                        id: prep.conversationId,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [
                          {
                            index: 0,
                            message: { role: 'assistant', content: p.content },
                            finish_reason: p.stopReason === 'tool_use' ? 'tool_calls' : 'stop'
                          }
                        ],
                        usage: {
                          prompt_tokens: p.inputTokens || 0,
                          completion_tokens: p.outputTokens || 0,
                          total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0)
                        }
                      }
                    if (p.toolCalls.length > 0)
                      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
                        id: tc.toolUseId,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments:
                            typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
                        }
                      }))
                    return new Response(JSON.stringify(oai), {
                      headers: { 'Content-Type': 'application/json' }
                    })
                  }
                  if (res.status === 400 && reductionFactor > 0.4) {
                    reductionFactor -= 0.2
                    showToast(
                      `Context too long. Retrying with ${Math.round(reductionFactor * 100)}%...`,
                      'warning'
                    )
                    prep = prepRequest(reductionFactor)
                    continue
                  }
                  if (res.status === 401 && retry < config.rate_limit_max_retries) {
                    retry++
                    continue
                  }
                  if (res.status === 500) {
                    acc.failCount = (acc.failCount || 0) + 1
                    let errorMessage = 'Internal Server Error'
                    try {
                      const errorBody = await res.text()
                      const errorData = JSON.parse(errorBody)
                      if (errorData.message) {
                        errorMessage = errorData.message
                      } else if (errorData.Message) {
                        errorMessage = errorData.Message
                      }
                    } catch (e) {
                      // If we can't parse the error, use default message
                    }
                    if (acc.failCount < 5) {
                      const delay = 1000 * Math.pow(2, acc.failCount - 1)
                      showToast(
                        `Server Error (500): ${errorMessage}. Retrying in ${Math.ceil(delay / 1000)}s...`,
                        'warning'
                      )
                      await sleep(delay)
                      continue
                    } else {
                      am.markUnhealthy(acc, `Server Error (500) after 5 attempts: ${errorMessage}`)
                      await am.saveToDisk()
                      showToast(
                        `Server Error (500): ${errorMessage}. Marking account as unhealthy and switching...`,
                        'warning'
                      )
                      continue
                    }
                  }
                  if (res.status === 429) {
                    const w = parseInt(res.headers.get('retry-after') || '60') * 1000
                    am.markRateLimited(acc, w)
                    await am.saveToDisk()
                    if (count > 1) {
                      showToast(`Rate limited. Switching account...`, 'warning')
                      continue
                    }
                    showToast(`Rate limited. Waiting ${Math.ceil(w / 1000)}s...`, 'warning')
                    await sleep(w)
                    continue
                  }
                  if ((res.status === 402 || res.status === 403) && count > 1) {
                    let errorReason = res.status === 402 ? 'Quota' : 'Forbidden'
                    let isPermanent = false
                    try {
                      const errorBody = await res.text()
                      const errorData = JSON.parse(errorBody)
                      if (errorData.reason === 'INVALID_MODEL_ID') {
                        logger.warn(`Invalid model ID for ${acc.email}: ${errorData.message}`)
                        throw new Error(`Invalid model: ${errorData.message}`)
                      }
                      if (errorData.reason === 'TEMPORARILY_SUSPENDED') {
                        errorReason = 'Account Suspended'
                        isPermanent = true
                      }
                    } catch (e) {
                      if (e instanceof Error && e.message.includes('Invalid model')) {
                        throw e
                      }
                    }
                    if (isPermanent) {
                      acc.failCount = 10
                    }
                    am.markUnhealthy(acc, errorReason)
                    await am.saveToDisk()
                    showToast(`${errorReason}. Switching account...`, 'warning')
                    continue
                  }
                  const h: any = {}
                  res.headers.forEach((v, k) => {
                    h[k] = v
                  })
                  const rData = {
                    status: res.status,
                    statusText: res.statusText,
                    headers: h,
                    error: `Kiro Error: ${res.status}`,
                    conversationId: prep.conversationId,
                    model: prep.effectiveModel
                  }
                  let lastB = null
                  try {
                    lastB = prep.init.body ? JSON.parse(prep.init.body as string) : null
                  } catch {}
                  if (!config.enable_log_api_request)
                    logger.logApiError(
                      {
                        url: prep.url,
                        method: prep.init.method,
                        headers: prep.init.headers,
                        body: lastB,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel,
                        email: acc.email
                      },
                      rData,
                      logger.getTimestamp()
                    )
                  throw new Error(`Kiro Error: ${res.status}`)
                } catch (e) {
                  if (isNetworkError(e) && retry < config.rate_limit_max_retries) {
                    const d = 5000 * Math.pow(2, retry)
                    showToast(`Network error. Retrying in ${Math.ceil(d / 1000)}s...`, 'warning')
                    await sleep(d)
                    retry++
                    continue
                  }
                  throw e
                }
              }
            }
          }
        },
        methods: [
          {
            id: 'idc',
            label: 'AWS Builder ID (IDC)',
            type: 'oauth',
            authorize: async (inputs?: any) =>
              new Promise(async (resolve) => {
                const region = config.default_region
                if (inputs) {
                  const accounts: KiroIDCTokenResult[] = []
                  let startFresh = true
                  const existingAm = await AccountManager.loadFromDisk(
                    config.account_selection_strategy
                  )
                  const idcAccs = existingAm.getAccounts().filter((a) => a.authMethod === 'idc')
                  if (idcAccs.length > 0) {
                    const existingAccounts = idcAccs.map((acc, idx) => ({
                      email: acc.email,
                      index: idx
                    }))
                    startFresh = (await promptLoginMode(existingAccounts)) === 'fresh'
                  }
                  while (true) {
                    try {
                      const authData = await authorizeKiroIDC(region)
                      const { url, waitForAuth } = await startIDCAuthServer(
                        authData,
                        config.auth_server_port_start,
                        config.auth_server_port_range
                      )
                      openBrowser(url)
                      const res = await waitForAuth()
                      const u = await fetchUsageLimits({
                        refresh: '',
                        access: res.accessToken,
                        expires: res.expiresAt,
                        authMethod: 'idc',
                        region,
                        clientId: res.clientId,
                        clientSecret: res.clientSecret
                      })
                      if (!u.email) {
                        console.log('\n[Error] Failed to fetch account email. Skipping...\n')
                        continue
                      }
                      accounts.push(res as KiroIDCTokenResult)
                      const am = await AccountManager.loadFromDisk(
                        config.account_selection_strategy
                      )
                      if (accounts.length === 1 && startFresh)
                        am.getAccounts()
                          .filter((a) => a.authMethod === 'idc')
                          .forEach((a) => am.removeAccount(a))
                      const id = createDeterministicAccountId(u.email, 'idc', res.clientId)
                      const acc: ManagedAccount = {
                        id,
                        email: u.email,
                        authMethod: 'idc',
                        region,
                        clientId: res.clientId,
                        clientSecret: res.clientSecret,
                        refreshToken: res.refreshToken,
                        accessToken: res.accessToken,
                        expiresAt: res.expiresAt,
                        rateLimitResetTime: 0,
                        isHealthy: true,
                        failCount: 0
                      }
                      am.addAccount(acc)
                      am.updateUsage(id, { usedCount: u.usedCount, limitCount: u.limitCount })
                      await am.saveToDisk()
                      console.log(
                        `\n[Success] Added: ${u.email} (Quota: ${u.usedCount}/${u.limitCount})\n`
                      )
                      if (!(await promptAddAnotherAccount(am.getAccountCount()))) break
                    } catch (e: any) {
                      console.log(`\n[Error] Login failed: ${e.message}\n`)
                      break
                    }
                  }
                  const finalAm = await AccountManager.loadFromDisk(
                    config.account_selection_strategy
                  )
                  return resolve({
                    url: '',
                    instructions: `Complete (${finalAm.getAccountCount()} accounts).`,
                    method: 'auto',
                    callback: async () => ({
                      type: 'success',
                      key: finalAm.getAccounts()[0]?.accessToken
                    })
                  })
                }
                try {
                  const authData = await authorizeKiroIDC(region)
                  const { url, waitForAuth } = await startIDCAuthServer(
                    authData,
                    config.auth_server_port_start,
                    config.auth_server_port_range
                  )
                  openBrowser(url)
                  resolve({
                    url,
                    instructions: `Open: ${url}`,
                    method: 'auto',
                    callback: async () => {
                      try {
                        const res = await waitForAuth(),
                          am = await AccountManager.loadFromDisk(config.account_selection_strategy)
                        const u = await fetchUsageLimits({
                          refresh: '',
                          access: res.accessToken,
                          expires: res.expiresAt,
                          authMethod: 'idc',
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret
                        })
                        if (!u.email) throw new Error('No email')
                        const id = createDeterministicAccountId(u.email, 'idc', res.clientId)
                        const acc: ManagedAccount = {
                          id,
                          email: u.email,
                          authMethod: 'idc',
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret,
                          refreshToken: res.refreshToken,
                          accessToken: res.accessToken,
                          expiresAt: res.expiresAt,
                          rateLimitResetTime: 0,
                          isHealthy: true,
                          failCount: 0
                        }
                        am.addAccount(acc)
                        if (u.email)
                          am.updateUsage(id, { usedCount: u.usedCount, limitCount: u.limitCount })
                        await am.saveToDisk()
                        return { type: 'success', key: res.accessToken }
                      } catch (e: any) {
                        return { type: 'failed' }
                      }
                    }
                  })
                } catch (e: any) {
                  resolve({
                    url: '',
                    instructions: 'Failed',
                    method: 'auto',
                    callback: async () => ({ type: 'failed' })
                  })
                }
              })
          }
        ]
      }
    }
  }
export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
