import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig, type KiroConfig } from './plugin/config/index.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

export const KIRO_PROVIDER_ID = 'kiro'

export type ToastVariant = 'info' | 'warning' | 'success' | 'error'
export type ToastFunction = (message: string, variant: ToastVariant) => void

/**
 * The account, auth, and request machinery shared by the OpenCode V1 and V2
 * entrypoints. Both hosts drive the same `RequestHandler`; they only differ in
 * how they hand it the OpenAI-compatible requests and how they register models.
 */
export interface KiroRuntime {
  config: KiroConfig
  repository: AccountRepository
  accountManager: AccountManager
  authHandler: AuthHandler
  requestHandler: RequestHandler
  /** OpenAI-compatible base URL. The custom fetch intercepts every call to it. */
  baseURL: string
}

export async function createKiroRuntime(directory: string, client?: any): Promise<KiroRuntime> {
  const config = loadConfig(directory)

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)

  const authHandler = new AuthHandler(config, repository)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
  authHandler.setAccountManager(accountManager)

  const requestHandler = new RequestHandler(accountManager, config, repository, client)

  const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
    '{{region}}',
    config.default_region || 'us-east-1'
  )

  return { config, repository, accountManager, authHandler, requestHandler, baseURL }
}

// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
export const WEB_SEARCH_TOOL_NAME = 'kiro_web_search'
export const WEB_SEARCH_QUERY_DESCRIPTION = 'The search query. Must be 200 characters or fewer.'
export const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

/**
 * Kiro's server-side web search is only advertised when enabled and the active
 * account is Pro (has a profileArn), so nothing is offered on free accounts.
 */
export function isWebSearchAvailable(config: KiroConfig, accountManager: AccountManager): boolean {
  if (!config.web_search_enabled) return false
  return !!accountManager.getCurrentOrNext()?.profileArn
}

/** Run a web search and render the outcome, including failures, as model-readable text. */
export async function runWebSearch(accountManager: AccountManager, query: string): Promise<string> {
  try {
    const results = await kiroWebSearch(accountManager, query)
    return formatWebSearchResults(results)
  } catch (e) {
    return `Web search failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
