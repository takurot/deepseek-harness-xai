/**
 * URL validation, content-type classification, and charset resolution for the
 * local HTTP(S) fetch provider — the pure, network-free half. The provider's
 * `fetch()` composes these with transport (redirect following, byte caps,
 * decoding).
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** Maximum accepted request URL length enforced by the fetch provider. */
export const WEB_FETCH_MAX_URL_LENGTH = 2048

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Parse a request URL and enforce network-independent transport restrictions:
 * HTTP(S) only and no embedded credentials. The provider applies this before
 * resolving a destination.
 *
 * @param input - the raw URL string from the fetch request.
 * @returns the parsed `URL`.
 */
export function parseFetchUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Validate a request URL against the provider's complete pre-network policy:
 * bounded length plus the restrictions enforced by {@link parseFetchUrl}.
 * Public-address resolution and connection pinning run after this check.
 *
 * @param input - the raw URL string from the fetch request.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string): URL {
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  return parseFetchUrl(input)
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh tool call.
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns true when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the lower-cased `charset` parameter from a response `Content-Type`.
 *
 * @param contentType - the raw header, or `null` when absent.
 * @returns the charset parameter, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Resolve the declared charset, defaulting to UTF-8 when absent. A malformed
 * comma- or whitespace-joined declaration containing a UTF-8 label uses a fatal
 * UTF-8 decoder; other unsupported declarations throw `WEB_UNSUPPORTED_CONTENT_TYPE`.
 * UTF-8 recovery is a preference, not proof of the original encoding.
 *
 * @param charset - the declared charset parameter, or `undefined` to default.
 * @returns a decoder; callers must report fatal decoding failures and flush at
 *   EOF unless they deliberately truncated the bytes.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  const declared = charset ?? 'utf-8'
  try {
    return new TextDecoder(declared)
  } catch (error: unknown) {
    if (declared.split(/[\s,]+/).some(isUtf8Label)) return new TextDecoder('utf-8', { fatal: true })
    throw new WebError(`unsupported charset "${declared}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}

/** Bytes of an HTML document inspected for a charset declaration, per the WHATWG prescan. */
const SNIFF_BYTES = 1024

/** ASCII whitespace recognized by the HTML prescan. */
const HTML_SPACE = /[\t\n\f\r ]/

/** Charset parameter inside a meta content attribute, rather than HTML markup. */
const CHARSET_VALUE = /charset[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;]+))/i

/**
 * Find a byte order mark, else the first complete meta charset declaration in
 * the first 1024 bytes. Attribute names are ASCII case-insensitive, their first
 * occurrence wins, and charset takes precedence over content regardless of
 * attribute order. Content requires an exact http-equiv="content-type" value.
 * Comments and other tags, including quoted values, are skipped. Incomplete
 * comments, values, or tags consume the remaining prescan bytes. Unsupported
 * labels are returned unchanged except for ASCII case and surrounding space.
 * Callers apply this declaration reader only when the header has no charset.
 *
 * @param bytes - the start of the response body.
 * @returns the lower-cased label, or `undefined` when the document declares none.
 */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8'
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le'
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be'
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SNIFF_BYTES))
  let cursor = 0
  while (cursor < head.length) {
    if (head[cursor] !== '<') { cursor++; continue }
    if (head.startsWith('<!--', cursor)) {
      const end = head.indexOf('-->', cursor + 4)
      if (end === -1) return undefined
      cursor = end + 3
      continue
    }
    cursor++
    if (!/[a-zA-Z/!?]/.test(head[cursor] ?? '')) continue
    const tagStart = cursor
    while (cursor < head.length && !/[\t\n\f\r />]/.test(head.charAt(cursor))) cursor++
    const isMeta = asciiLower(head.slice(tagStart, cursor)) === 'meta'
    const attributes = new Map<string, string>()
    while (cursor < head.length && head[cursor] !== '>') {
      if (HTML_SPACE.test(head.charAt(cursor)) || head[cursor] === '/') { cursor++; continue }
      const nameStart = cursor++
      while (cursor < head.length && !/[\t\n\f\r /=>]/.test(head.charAt(cursor))) cursor++
      const name = asciiLower(head.slice(nameStart, cursor))
      while (cursor < head.length && HTML_SPACE.test(head.charAt(cursor))) cursor++
      let value = ''
      if (head[cursor] === '=') {
        cursor++
        while (cursor < head.length && HTML_SPACE.test(head.charAt(cursor))) cursor++
        const quote = head[cursor]
        if (quote === '"' || quote === "'") {
          const valueStart = ++cursor
          while (cursor < head.length && head[cursor] !== quote) cursor++
          if (cursor === head.length) return undefined
          value = head.slice(valueStart, cursor++)
        } else {
          const valueStart = cursor
          while (cursor < head.length && !/[\t\n\f\r >]/.test(head.charAt(cursor))) cursor++
          value = head.slice(valueStart, cursor)
        }
      }
      if (isMeta && !attributes.has(name)) attributes.set(name, value)
    }
    if (cursor === head.length) return undefined
    cursor++
    if (!isMeta) continue
    let label = attributes.get('charset')
    if (label === undefined && asciiLower(attributes.get('http-equiv') ?? '') === 'content-type') {
      const match = CHARSET_VALUE.exec(attributes.get('content') ?? '')
      label = match?.[1] ?? match?.[2] ?? match?.[3]
    }
    if (label !== undefined) {
      label = asciiLower(label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))
      if (label !== '') return label
    }
  }
  return undefined
}

/** Lower-case ASCII letters without folding non-ASCII attribute names or values. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, letter => letter.toLowerCase())
}

/**
 * Pick the decoder for an HTML body whose header declared no charset.
 * A UTF-16 result from a `<meta>` label is read as UTF-8, because a page whose
 * declaration was readable as ASCII cannot be UTF-16 (WHATWG Encoding).
 *
 * @param bytes - the start of the response body.
 * @returns a decoder for the declared charset, or UTF-8 when none is declared.
 * @throws `WEB_UNSUPPORTED_CONTENT_TYPE` for a label no decoder supports.
 */
export function decoderForHtml(bytes: Uint8Array): TextDecoder {
  const label = sniffHtmlCharset(bytes)
  const decoder = decoderForCharset(label)
  const utf16Bom = bytes[0] === 0xFF || bytes[0] === 0xFE
  if (!utf16Bom && decoder.encoding.startsWith('utf-16')) return new TextDecoder('utf-8')
  return decoder
}

/** Whether a label names UTF-8, including its standard aliases. */
function isUtf8Label(label: string): boolean {
  try {
    return new TextDecoder(label).encoding === 'utf-8'
  } catch (_error: unknown) {
    // An unsupported label does not authorize UTF-8 recovery.
    return false
  }
}
