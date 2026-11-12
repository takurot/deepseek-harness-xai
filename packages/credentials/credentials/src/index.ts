/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRef } from './types.ts'

export type {
  ApiKeyRecord, CredentialInfo, CredentialKey, CredentialRecord, CredentialRef, GrantRecord,
} from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return brandString<CredentialRef>(value)
}

/**
 * Whether a raw string could name a reference at all. Consumers that receive
 * environment-variable names from somewhere else — a provider library's own
 * ambient discovery, a hook payload — ask this before resolving, because a name
 * outside the grammar has no reference to miss and should read as "not set"
 * rather than as a thrown error.
 * @param value - candidate reference.
 * @returns true when {@link credentialRef} would accept it.
 */
export function isCredentialRefName(value: string): boolean {
  return REF_PATTERN.test(value)
}

/** Own enumerable data fields; inspecting a durable input must not execute accessors. */
function recordFields(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${subject} must be a plain mapping`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${subject} holds fields JSON cannot represent`)
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${subject} holds fields JSON cannot represent`)
    }
    const field: unknown = descriptor.value
    return [key, field]
  }))
}

/** Copy a JSON value without invoking user-supplied conversion methods. */
function copyRecordJson(value: unknown, subject: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${subject} holds a non-finite number`)
    if (Object.is(value, -0)) throw new TypeError(`${subject} holds negative zero, which JSON does not preserve`)
    return value
  }
  if (typeof value !== 'object') throw new TypeError(`${subject} is not JSON-serializable`)
  if (seen.has(value)) throw new TypeError(`${subject} is cyclic`)
  seen.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError(`${subject} must be a dense JSON array without extra fields`)
    }
    result = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${subject} must be a dense JSON array without accessors`)
      }
      const nested: unknown = descriptor.value
      return copyRecordJson(nested, subject, seen)
    })
  } else {
    result = Object.fromEntries(Object.entries(recordFields(value, subject))
      .map(([key, nested]) => [key, copyRecordJson(nested, subject, seen)]))
  }
  seen.delete(value)
  return result
}

/**
 * Admit a durable credential record and copy its JSON data without interpreting grant contents.
 * Undefined API-key optionals normalize to absent fields. Other fields must survive JSON storage.
 * @param value - parsed stored data or a replacement about to be persisted.
 * @param subject - trusted diagnostic context containing no secret values.
 * @returns an independent record with ordinary JSON values and no accessors.
 * @throws TypeError describing the violated rule without quoting supplied fields or values.
 */
export function decodeCredentialRecord(value: unknown, subject: string): CredentialRecord {
  const fields = recordFields(value, subject)
  const kind = fields['kind']
  if (kind !== 'api-key' && kind !== 'grant') {
    throw new TypeError(`${subject} has ${kind === undefined ? 'no' : 'unknown'} kind`)
  }
  const allowed = kind === 'api-key' ? ['kind', 'key', 'env'] : ['kind', 'payload']
  if (Object.keys(fields).some(key => !allowed.includes(key))) throw new TypeError(`${subject} has unknown field`)
  if (kind === 'grant') {
    if (!Object.hasOwn(fields, 'payload')) throw new TypeError(`${subject} has no payload`)
    return { kind, payload: copyRecordJson(fields['payload'], `${subject} payload`, new Set()) }
  }
  const key = fields['key']
  if (key !== undefined && (typeof key !== 'string' || key.length === 0)) {
    throw new TypeError(`${subject} has a non-string or empty key; omit the field instead`)
  }
  const rawEnv = fields['env']
  const env = rawEnv === undefined ? undefined : Object.fromEntries(Object.entries(recordFields(rawEnv, `${subject} env`)).map(([name, entry]) => {
    if (!isCredentialRefName(name)) throw new TypeError(`${subject} env names must match POSIX identifiers`)
    if (typeof entry !== 'string' || entry.length === 0) throw new TypeError(`${subject} env values must be a non-empty string`)
    return [name, entry]
  }))
  return { kind, ...key === undefined ? {} : { key }, ...env === undefined ? {} : { env } }
}

/**
 * Whether a raw string could be a {@link credentialKey} segment at all.
 * Consumers whose addressing units come from somewhere else — a settings dict
 * key, a library's own provider id — ask this before building a key, because a
 * unit outside the grammar can never have stored a record and should read as
 * "nothing stored" rather than as a thrown error.
 * @param value - candidate segment.
 * @returns true when {@link credentialKey} would accept it as either segment.
 */
export function isCredentialKeySegment(value: string): boolean {
  return KEY_SEGMENT_PATTERN.test(value)
}

/**
 * Brand a scope and an id as a {@link CredentialKey}.
 * @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
 * @param id - that plugin's own addressing unit, such as a provider route key.
 * @returns the branded key.
 * @throws TypeError when either segment is not a lowercase hyphenated identifier.
 */
export function credentialKey(scope: string, id: string): CredentialKey {
  for (const segment of [scope, id]) {
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`)
    }
  }
  return brandString<CredentialKey>(`${scope}/${id}`)
}

/**
 * Brand a stored `<scope>/<id>` string as a {@link CredentialKey}. This is the
 * read half of {@link credentialKey}, for a provider admitting keys off disk.
 * @param value - candidate key in its joined form.
 * @returns the branded key.
 * @throws TypeError when the value is not exactly two valid segments.
 */
export function parseCredentialKey(value: string): CredentialKey {
  const segments = value.split('/')
  const [scope, id] = segments
  if (segments.length !== 2 || scope === undefined || id === undefined) {
    throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`)
  }
  return credentialKey(scope, id)
}

/**
 * The owning plugin's name for one key. A record whose scope names no
 * currently registered owner is an orphan, which a configuration surface must
 * report as such rather than as a working credential.
 * @param key - the key to read.
 * @returns the scope segment.
 */
export function credentialKeyScope(key: CredentialKey): string {
  // The brand's only constructors both validate two segments, so the split
  // cannot come back short here.
  return key.slice(0, key.indexOf('/'))
}

/**
 * The owning plugin's own addressing unit for one key — the half that plugin
 * chose, such as a provider route.
 * @param key - the key to read.
 * @returns the id segment.
 */
export function credentialKeyId(key: CredentialKey): string {
  return key.slice(key.indexOf('/') + 1)
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}

/** Presence and writability facts for one record, safe for configuration UIs — never the value. */
export interface CredentialRecordInfo {
  /**
   * Whether a record is stored. Unlike a reference, presence alone answers
   * this: an {@link ApiKeyRecord} carrying neither a key nor environment
   * values states that its owner confirmed ambient authentication, which is
   * configured, not blank.
   */
  configured: boolean
  /** Discriminant of the stored record; absent while none is stored. */
  kind?: CredentialRecord['kind']
  /** Whether {@link CredentialProvider.modifyRecord} would currently succeed. */
  writable: boolean
}

/** One stored record's address and tag, for enumeration — never its value. */
export interface CredentialRecordEntry {
  /** The record's address. */
  key: CredentialKey
  /** Discriminant of the stored record. */
  kind: CredentialRecord['kind']
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * Abstract credential service over two key spaces that answer two questions.
 *
 * A {@link CredentialRef} answers "what is behind this environment-variable
 * name": the provider-managed store first, then ambient fallbacks such as the
 * process environment and `.env` files. One seam-wide rule binds that half: an
 * empty stored value is absent everywhere — `resolve` skips it, `describe`
 * reports it unconfigured — so a blank never masquerades as a configured
 * secret.
 *
 * A {@link CredentialKey} answers "what credential does this plugin hold for
 * this id". Nothing can layer here — an authorization grant has no
 * environment to be read from — so presence of the record is the whole fact,
 * and {@link modifyRecord} is the only write path because a correct write
 * depends on the current value (a token refresh is read-decide-replace under
 * one lock).
 */
export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>

  /**
   * Durably store one value in the provider-managed writable source. The stored
   * value takes precedence over ambient fallbacks, and empty values are
   * rejected (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Ambient fallback layers may become
   * effective again after removal.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /**
   * Read one stored record. The value is returned as its owner wrote it; a
   * {@link GrantRecord} payload is not interpreted on the way out.
   * @param key - the record to read.
   * @returns the record, or `undefined` while none is stored.
   */
  abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>

  /**
   * Describe one record for configuration surfaces without exposing its value.
   * @param key - the record to describe.
   * @returns presence, discriminant, and writability.
   */
  abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>

  /**
   * Enumerate every stored record's address and tag. Unlike the reference
   * half, which has no enumeration because configuration surfaces learn which
   * references exist from settings schemas, records have no such discovery
   * path: a surface that cannot list them cannot show what a user is
   * authorized for, nor find an orphan left by an uninstalled plugin.
   * @returns every stored record, values excluded.
   */
  abstract listRecords(): Promise<readonly CredentialRecordEntry[]>

  /**
   * Serialized read-modify-write over one record — the only write path.
   * `mutate` sees the record as it stands at the moment the write is
   * exclusive, and returning `undefined` leaves the entry untouched. Exclusion
   * holds across processes where the backing store supports it, which is what
   * makes a token refresh safe: two processes rotating one refresh token
   * concurrently would otherwise lose whichever wrote first.
   * @param key - the record to modify.
   * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
   * @returns the record after the write, or the current one when `mutate` declined.
   */
  abstract modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>

  /**
   * Remove one record; removing an absent record is a no-op.
   * @param key - the record to remove.
   */
  abstract deleteRecord(key: CredentialKey): Promise<void>

  /**
   * Fan `credentials/reference-updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome. Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    this.fanOut('credentials/reference-updated', ref)
  }

  /**
   * Fan `credentials/record-updated` out on exactly the terms
   * {@link notifyUpdated} documents, for the record half of the seam.
   * @param key - the record whose stored value changed.
   */
  protected notifyRecordUpdated(key: CredentialKey): void {
    this.fanOut('credentials/record-updated', key)
  }

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /** The contained dispatch both notifications run through; see {@link notifyUpdated}. */
  private fanOut(event: 'credentials/reference-updated' | 'credentials/record-updated', subject: string): void {
    const args = [event, subject]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(subject)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(event, subject, error)
          })
        }
      } catch (error) {
        this.warnListenerFailure(event, subject, error)
      }
    }
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(event: string, subject: string, error: unknown): void {
    this.ctx.logger.warn('credentials: a %s listener for "%s" failed', event, subject)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider
