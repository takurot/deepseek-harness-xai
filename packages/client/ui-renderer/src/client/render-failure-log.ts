/**
 * Bounded, sanitized diagnostics for top-level render failures. A crash is
 * recorded in `localStorage` before the fallback renders, so the evidence
 * survives the reload that recovers the page. Recording is best-effort: a
 * browser that denies storage still gets the fallback, with the in-memory
 * record shown and nothing persisted.
 *
 * Privacy: a record carries the failure time, the error name, message and
 * stack, and the slot that failed. It never reads prompts, conversation text,
 * credentials, or component props; token-like runs inside the error text are
 * redacted and every field is bounded (about 4 KB per record, three records).
 *
 * @module @deepseek-ai/dsh-client-ui-renderer/src/client/render-failure-log
 */

/** localStorage key owning the bounded render-failure ring. */
export const RENDER_FAILURE_STORAGE_KEY = 'dsh.render-failure.v1'

/** Number of failures retained in the ring. */
export const RENDER_FAILURE_RETENTION = 3

/** Upper bound on one serialized record, in JSON characters. */
const MAX_RECORD_LENGTH = 4096
const MAX_MESSAGE_LENGTH = 512
const MAX_STACK_LENGTH = 3072
const MAX_NAME_LENGTH = 80
const MAX_SLOT_LENGTH = 64

/** Outcome of recording one failure: the in-memory record plus whether it persisted. */
export interface RecordedRenderFailure {
  /** The bounded, redacted record (always available). */
  readonly record: RenderFailureRecord
  /** Whether the record was written to the stored ring. */
  readonly persisted: boolean
}

/** One sanitized, bounded render-failure record. */
export interface RenderFailureRecord {
  /** ISO-8601 time the failure was recorded. */
  readonly at: string
  /** Error constructor name, redacted and bounded. */
  readonly name: string
  /** Error message, token-redacted and bounded. */
  readonly message: string
  /** Error stack, token-redacted and bounded (`''` when unavailable). */
  readonly stack: string
  /** Slot whose render failed (`'root'` for the application root). */
  readonly slot: string
}

/**
 * Patterns redacted before anything is persisted. The first entries keep a
 * recognizable prefix; the last one removes long secret-like runs that match
 * no known prefix.
 */
const TOKEN_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, '[redacted]'],
  [/\bauthorization\b\s*[:=]\s*(?:bearer|basic)?\s*["']?[a-z0-9._~+/=-]{8,}/gi, 'Authorization=[redacted]'],
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]'],
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)s?)\b\s*[:=]\s*["']?[^\s"',;]+/gi,
    '$1=[redacted]',
  ],
  [
    /\b((?:secret|password|passwd|authorization|credential)s?)\b\s*[:=]\s*["']?[^\s"',;]+/gi,
    '$1=[redacted]',
  ],
  [/(?<![A-Za-z0-9+/=_.:@-])(?=[A-Za-z0-9+=_]*\d)[A-Za-z0-9+=_]{32,}(?![A-Za-z0-9+/=_.:@-])/g, '[redacted]'],
]

/**
 * Remove token-like runs from one diagnostic string.
 * @param text - raw error text.
 * @returns the redacted text.
 */
export function redactRenderFailureText(text: string): string {
  let redacted = text
  for (const [pattern, replacement] of TOKEN_PATTERNS) redacted = redacted.replace(pattern, replacement)
  return redacted
}

/** Bound one field, marking the cut with an ellipsis. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Truncate before redacting so a huge thrown stack stays cheap to sanitize. */
function sanitize(text: string, max: number): string {
  return bound(redactRenderFailureText(bound(text, max * 2)), max)
}

/** Extract bounded fields from an unknown thrown value. */
function describe(error: unknown): { name: string; message: string; stack: string } {
  try {
    if (error instanceof Error) {
      return {
        name: sanitize(error.name, MAX_NAME_LENGTH),
        message: sanitize(error.message, MAX_MESSAGE_LENGTH),
        stack: error.stack === undefined ? '' : sanitize(error.stack, MAX_STACK_LENGTH),
      }
    }
    const message = typeof error === 'string' ? error : String(error)
    return {
      name: 'Error',
      message: sanitize(message, MAX_MESSAGE_LENGTH),
      stack: '',
    }
  } catch {
    // A hostile thrown value (Proxy traps, throwing `toString`) must not turn
    // diagnostics into a second crash.
    return { name: 'Error', message: 'unreadable thrown value', stack: '' }
  }
}

/** Shrink a record until its serialized form fits the per-record budget. */
function fitRecord(record: RenderFailureRecord): RenderFailureRecord {
  let stack = record.stack
  while (stack.length > 0 && JSON.stringify({ ...record, stack }).length > MAX_RECORD_LENGTH) {
    const excess = JSON.stringify({ ...record, stack }).length - MAX_RECORD_LENGTH
    stack = stack.slice(0, Math.max(0, stack.length - Math.max(excess, 32)))
  }
  return stack === record.stack ? record : { ...record, stack }
}

/**
 * Build one sanitized record from a thrown value. No caller data beyond the
 * error object and the slot label reaches the record.
 * @param error - thrown value.
 * @param slot - slot whose render failed.
 * @param now - recording clock (tests pin it).
 * @returns the bounded record.
 */
export function createRenderFailureRecord(
  error: unknown,
  slot: string,
  now: Date = new Date(),
): RenderFailureRecord {
  const { name, message, stack } = describe(error)
  return fitRecord({
    at: now.toISOString(),
    name,
    message,
    stack,
    slot: sanitize(slot, MAX_SLOT_LENGTH),
  })
}

/** Resolve the browser storage this module records into, tolerating denial. */
function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    // Storage access throws in privacy modes and sandboxed frames; recording
    // is best-effort, so the fallback still renders without persistence.
    return undefined
  }
}

/** Read one unknown value as a valid record, dropping corrupt storage content. */
function parseRecord(value: unknown): RenderFailureRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.at !== 'string'
    || typeof candidate.name !== 'string'
    || typeof candidate.message !== 'string'
    || typeof candidate.stack !== 'string'
    || typeof candidate.slot !== 'string'
  ) return undefined
  return fitRecord({
    at: bound(candidate.at, 40),
    name: sanitize(candidate.name, MAX_NAME_LENGTH),
    message: sanitize(candidate.message, MAX_MESSAGE_LENGTH),
    stack: sanitize(candidate.stack, MAX_STACK_LENGTH),
    slot: sanitize(candidate.slot, MAX_SLOT_LENGTH),
  })
}

/**
 * Read the stored failure ring, newest first. Corrupt or hostile storage
 * content is dropped rather than rendered.
 * @param storage - storage to read (defaults to the browser's localStorage).
 * @returns valid records, at most the retention limit.
 */
export function readRenderFailures(storage: Storage | undefined = defaultStorage()): readonly RenderFailureRecord[] {
  if (storage === undefined) return []
  let raw: string | null
  try {
    raw = storage.getItem(RENDER_FAILURE_STORAGE_KEY)
  } catch {
    // Unreadable storage is the same best-effort failure as an absent one.
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A corrupted key must not break the fallback that reports the failure.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const records: RenderFailureRecord[] = []
  for (const value of parsed) {
    const record = parseRecord(value)
    if (record !== undefined) records.push(record)
    if (records.length === RENDER_FAILURE_RETENTION) break
  }
  return records
}

/**
 * Record one top-level render failure. The bounded, redacted in-memory record
 * is always returned; `persisted` states whether it reached the stored ring.
 * @param error - thrown value.
 * @param slot - slot whose render failed.
 * @param storage - storage to write (defaults to the browser's localStorage).
 * @param now - recording clock (tests pin it).
 * @returns the record and whether storage accepted it.
 */
export function recordRenderFailure(
  error: unknown,
  slot: string,
  storage: Storage | undefined = defaultStorage(),
  now: Date = new Date(),
): RecordedRenderFailure {
  const record = createRenderFailureRecord(error, slot, now)
  if (storage === undefined) return { record, persisted: false }
  try {
    const next = [record, ...readRenderFailures(storage)].slice(0, RENDER_FAILURE_RETENTION)
    storage.setItem(RENDER_FAILURE_STORAGE_KEY, JSON.stringify(next))
    return { record, persisted: true }
  } catch {
    // Quota, privacy mode, or a hostile override: the returned record still
    // drives the fallback, and diagnostics are documented as best-effort.
    return { record, persisted: false }
  }
}

/** Identity of a record for de-duplication against the stored ring. */
function recordKey(record: RenderFailureRecord): string {
  return `${record.at}\u0000${record.slot}\u0000${record.name}\u0000${record.message}`
}

/**
 * Combine the in-hand failure with the stored ring, newest first and without
 * duplicating the record that was just persisted.
 * @param latest - the failure being displayed, or undefined before one is known.
 * @param storage - storage to read (defaults to the browser's localStorage).
 * @returns records for the diagnostic view.
 */
export function collectRenderFailures(
  latest: RenderFailureRecord | undefined,
  storage: Storage | undefined = defaultStorage(),
): readonly RenderFailureRecord[] {
  const stored = readRenderFailures(storage)
  if (latest === undefined) return stored
  const key = recordKey(latest)
  return [latest, ...stored.filter(record => recordKey(record) !== key)].slice(0, RENDER_FAILURE_RETENTION)
}
