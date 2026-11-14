/**
 * xAI search through the Responses API with the server-side `web_search` (and optionally
 * `x_search`) tool. Each search costs one model call plus tool-call charges. The answer text
 * becomes `content` and the structured `url_citation` annotations become `sources`; a response
 * without annotations is an error, never a prose-scraping fallback. The native `fetch` client is
 * provider-private and does not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-xai/provider
 */

import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const XAI_PROVIDER_ID = 'xai'

/** Default xAI API base, including `/v1`; `/responses` is appended. */
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** Default Grok model for the search turn; the xAI tools documentation uses it in its examples. */
export const XAI_DEFAULT_MODEL = 'grok-4.7'

/** Default whole-search timeout in milliseconds. */
export const XAI_DEFAULT_TIMEOUT_MS = 60_000

/** A server-side search tool the provider can enable. */
export type XaiSearchSource = 'web' | 'x'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** One content block of a Responses API `message` output item; only `output_text` is read. */
interface XaiContentBlock {
  readonly type: string
  readonly text?: string
  readonly annotations?: readonly { readonly type: string; readonly url?: string }[]
}

/** The parts of a Responses API body the provider reads. */
export interface XaiResponse {
  readonly status: 'completed' | 'incomplete'
  readonly output: readonly { readonly type: string; readonly content?: readonly XaiContentBlock[] }[]
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface XaiSearchProviderOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current API key for one search operation; cancellation ends waiting without stopping this read. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: string
  /** Endpoint base; `/responses` is appended. */
  baseURL: string
  /** Grok model that runs the search turn. */
  model: string
  /** Server-side search tools to enable. */
  sources: readonly XaiSearchSource[]
  /** Timeout from credential resolution through body consumption; caller cancellation wins when it occurs first. */
  timeoutMs: number
}

/**
 * Map a Responses API body to a normalized search result. Answer text from every `output_text` block
 * joins as `content`; `url_citation` annotations become URL-only sources, deduped by URL (the
 * annotation `title` is the visible citation number, not a page title). The web service owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed Responses API body.
 * @returns the normalized result.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the response is incomplete or cites no source.
 */
export function mapXaiResponse(response: XaiResponse): WebSearchResult {
  switch (response.status) {
    case 'completed': break
    case 'incomplete': throw new WebError('xAI returned an incomplete search response', 'WEB_PROVIDER_ERROR')
    /* v8 ignore next -- XaiResponse has closed typed statuses; the HTTP parser validates admission. */
    default: return assertNever(response.status)
  }
  const texts: string[] = []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of response.output) {
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

/** Parse only the Responses API fields consumed by the search mapper. */
function parseXaiResponse(value: unknown): XaiResponse {
  const response = record(value, 'response')
  if (response.status !== 'completed' && response.status !== 'incomplete') invalid('status')
  const output = array(response.output, 'output').map((value, index) => {
    const path = `output[${String(index)}]`
    const item = record(value, path)
    const type = string(item.type, `${path}.type`)
    if (type !== 'message') return { type }
    const content = array(item.content, `${path}.content`).map((value, index) => {
      const blockPath = `${path}.content[${String(index)}]`
      const block = record(value, blockPath)
      const type = string(block.type, `${blockPath}.type`)
      if (type !== 'output_text') return { type }
      const text = string(block.text, `${blockPath}.text`)
      const annotations = array(block.annotations, `${blockPath}.annotations`).map((value, index) => {
        const annotationPath = `${blockPath}.annotations[${String(index)}]`
        const annotation = record(value, annotationPath)
        const type = string(annotation.type, `${annotationPath}.type`)
        if (type !== 'url_citation') return { type }
        const url = string(annotation.url, `${annotationPath}.url`)
        if (url.length === 0) invalid(`${annotationPath}.url`)
        return { type, url }
      })
      return { type, text, annotations }
    })
    return { type, content }
  })
  return { status: response.status, output }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path)
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path)
  return value
}

/** Reject malformed data without including provider text in the diagnostic. */
function invalid(path: string): never {
  throw new WebError(`xAI returned an invalid response field: ${path}`, 'WEB_PROVIDER_ERROR')
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
      && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= MAX_TIMER_DELAY_MS
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)
    const operation = deadline(signal, options.timeoutMs, 'XAI_SEARCH_TIMEOUT')
    let response: Response | undefined
    try {
      const apiKey = await this.apiKey(options, operation.signal)
      throwIfCancelled(operation.signal, signal)
      const endpoint = `${options.baseURL}/responses`
      const body = {
        model: options.model,
        input: `Perform a web search for the query: ${request.query}`,
        tools: options.sources.map(source => ({ type: source === 'x' ? 'x_search' : 'web_search' })),
      }
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
        signal: operation.signal,
      })
      throwIfCancelled(operation.signal, signal)
      if (!response.ok) throw await httpError(response, operation.signal)
      const parsed: unknown = await response.json()
      throwIfCancelled(operation.signal, signal)
      return mapXaiResponse(parseXaiResponse(parsed))
    } catch (error: unknown) {
      throwIfCancelled(operation.signal, signal)
      if (isNamed(error, 'AbortError')) throw aborted(undefined, error)
      if (error instanceof WebError) throw error
      const message = response === undefined
        ? `xAI search request failed: ${String(error)}`
        : 'xAI returned an unprocessable response body'
      throw new WebError(message, 'WEB_PROVIDER_ERROR', response === undefined ? { cause: error } : undefined)
    } finally {
      operation[Symbol.dispose]()
    }
  }

  /**
   * Resolve one operation's API key without retaining it on the provider.
   * @param options - the caller's snapshot.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no key resolves; `WEB_PROVIDER_ERROR` when the resolver fails.
   */
  private async apiKey(options: XaiSearchProviderOptions, signal: AbortSignal): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try { resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal) }
    catch (error: unknown) {
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

/** Observe credential settlement after cancellation while releasing the search's abort listener. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(aborted(signal))
    }
    void operation.finally(() => { signal.removeEventListener('abort', onAbort) }).then(resolve, reject)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Map a non-2xx response to the web error taxonomy: 401/403 authentication, 429 rate limit, other provider error. */
async function httpError(response: Response, signal?: AbortSignal): Promise<WebError> {
  const status = response.status
  let message = `xAI API error (HTTP ${String(status)})`
  try {
    const parsed: unknown = await response.json()
    if (isRecord(parsed)) {
      const detail = typeof parsed.error === 'string' ? parsed.error
        : isRecord(parsed.error) && typeof parsed.error.message === 'string' ? parsed.error.message
          : typeof parsed.message === 'string' ? parsed.message : undefined
      if (detail !== undefined && detail.length > 0) message += `: ${detail}`
    }
  } catch (error: unknown) {
    if (signal?.aborted === true || isNamed(error, 'AbortError')) throw error
    // A non-JSON error body is normal for gateway 5xx/429s; the status above is already in the message.
  }
  signal?.throwIfAborted()
  if (status === 401 || status === 403) return new WebError(message, 'WEB_PROVIDER_AUTH_FAILED')
  if (status === 429) return new WebError(message, 'WEB_PROVIDER_RATE_LIMITED')
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

/** Classify the operation's winning reason without reclassifying a caller-owned timeout. */
function throwIfCancelled(operation: AbortSignal, caller?: AbortSignal): void {
  if (!operation.aborted) return
  const timeout = timeoutOf(operation, 'XAI_SEARCH_TIMEOUT')
  if (timeout !== undefined && !(caller?.aborted === true && operation.reason === caller.reason)) {
    throw new WebError(`xAI search timed out after ${String(timeout.timeoutMs)} ms`, 'WEB_TIMEOUT', { cause: timeout })
  }
  throw aborted(operation)
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
