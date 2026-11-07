/**
 * xAI search through the Responses API with the server-side `web_search` (and optionally
 * `x_search`) tool. Each search costs one model call plus tool-call charges. The answer text
 * becomes `content` and the structured `url_citation` annotations become `sources`; a response
 * without annotations is an error, never a prose-scraping fallback. The native `fetch` client is
 * provider-private and does not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-xai/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const XAI_PROVIDER_ID = 'xai'

/** Default xAI API base, including `/v1`; `/responses` is appended. */
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** Default Grok model for the search turn; the xAI tools documentation uses it in its examples. */
export const XAI_DEFAULT_MODEL = 'grok-4.7'

/** Default whole-request timeout in milliseconds. */
export const XAI_DEFAULT_TIMEOUT_MS = 60_000

/** A server-side search tool the provider can enable. */
export type XaiSearchSource = 'web' | 'x'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** One content block of a Responses API `message` output item; only `output_text` is read. */
interface XaiContentBlock {
  readonly type?: string
  readonly text?: string
  readonly annotations?: readonly { readonly type?: string; readonly url?: string }[]
}

/** The parts of a Responses API body the provider reads. */
export interface XaiResponse {
  readonly output?: readonly { readonly type?: string; readonly content?: readonly XaiContentBlock[] }[]
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface XaiSearchProviderOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: string
  /** Endpoint base; `/responses` is appended. */
  baseURL: string
  /** Grok model that runs the search turn. */
  model: string
  /** Server-side search tools to enable. */
  sources: readonly XaiSearchSource[]
  /** Whole-request timeout in milliseconds. */
  timeoutMs: number
}

/**
 * Map a Responses API body to a normalized search result. Answer text from every `output_text` block
 * joins as `content`; `url_citation` annotations become URL-only sources, deduped by URL (the
 * annotation `title` is the visible citation number, not a page title). The web service owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed Responses API body.
 * @returns the normalized result.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the response cites no source.
 */
export function mapXaiResponse(response: XaiResponse): WebSearchResult {
  const texts: string[] = []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue
    for (const block of item.content ?? []) {
      if (block.type !== 'output_text') continue
      if (block.text !== undefined && block.text.length > 0) texts.push(block.text)
      for (const annotation of block.annotations ?? []) {
        if (annotation.type !== 'url_citation' || annotation.url === undefined || annotation.url.length === 0) continue
        if (seen.has(annotation.url)) continue
        seen.add(annotation.url)
        sources.push({ url: annotation.url })
      }
    }
  }
  if (sources.length === 0) {
    throw new WebError(
      'xAI returned no cited sources; the request may not have triggered server-side search',
      'WEB_PROVIDER_ERROR',
    )
  }
  return { content: texts.join('\n\n'), sources, truncated: false }
}

/** The xAI-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class XaiSearchProvider implements WebSearchProvider {
  readonly id = XAI_PROVIDER_ID
  readonly title = 'xAI'
  /** Picker description: what this provider suits and what it costs or cannot do. */
  readonly description: NonNullable<WebSearchProvider['description']> = {
    en: 'Runs server-side web (and optionally X) search inside a Grok model call, so every search adds model latency, token usage, and per-call search charges. Requires an xAI API key.',
  }

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once at each operation's
   * entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => XaiSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL) && options.sources.length > 0
      && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const endpoint = `${options.baseURL}/responses`
    const body = {
      model: options.model,
      input: `Perform a web search for the query: ${request.query}`,
      tools: options.sources.map(source => ({ type: source === 'x' ? 'x_search' : 'web_search' })),
    }
    const timeout = AbortSignal.timeout(options.timeoutMs)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isNamed(error, 'AbortError')) throw aborted(signal, error)
      if (isNamed(error, 'TimeoutError')) {
        throw new WebError(`xAI search timed out after ${String(options.timeoutMs)} ms`, 'WEB_TIMEOUT', { cause: error })
      }
      throw new WebError(`xAI search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) throw await httpError(response, signal)

    try {
      return mapXaiResponse(await response.json() as XaiResponse)
    } catch (error: unknown) {
      if (signal?.aborted === true || isNamed(error, 'AbortError')) throw aborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`xAI returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's API key without retaining it on the provider.
   * @param options - the caller's snapshot.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no key resolves; `WEB_PROVIDER_ERROR` when the resolver fails.
   */
  private async apiKey(options: XaiSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try { resolved = await options.resolveApiKey?.() }
    catch (error: unknown) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError(`xAI search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `xAI search has no API key for "${options.apiKeyEnv ?? 'XAI_API_KEY'}"; store it through the credentials service,`
      + ' export it in the launching environment, or set a literal "apiKey" in the web-search-xai config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Map a non-2xx response to the web error taxonomy: 401/403 authentication, 429 rate limit, other provider error. */
async function httpError(response: Response, signal?: AbortSignal): Promise<WebError> {
  const status = response.status
  let message = `xAI API error (HTTP ${String(status)})`
  try {
    const parsed = await response.json() as { error?: string | { message?: string }; message?: string }
    const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    if (detail !== undefined && detail.length > 0) message += `: ${detail}`
  } catch (error: unknown) {
    if (signal?.aborted === true || isNamed(error, 'AbortError')) return aborted(signal, error)
    // A non-JSON error body is normal for gateway 5xx/429s; the status above is already in the message.
  }
  if (status === 401 || status === 403) return new WebError(message, 'WEB_PROVIDER_AUTH_FAILED')
  if (status === 429) return new WebError(message, 'WEB_PROVIDER_RATE_LIMITED')
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

/** Throw the stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/** Build the stable cancellation error while retaining the caller's reason. */
function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('xAI search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True when `error` is a DOMException with the given name. */
function isNamed(error: unknown, name: string): boolean {
  return error instanceof DOMException && error.name === name
}
