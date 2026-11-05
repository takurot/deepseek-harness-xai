/**
 * OS-keychain credentials provider. Stored references and records live in the
 * platform secret store instead of a plaintext file, layered over the
 * environment in this precedence order:
 *
 * ```text
 * OS keychain                        (provider-managed, written by set/unset)
 * > inherited process environment    (fallback; this provider never writes it)
 * > <invocation cwd>/.env            (fallback; this provider never writes it)
 * > $DSH_HOME/.env                   (fallback; this provider never writes it)
 * ```
 *
 * Each reference and each record is one keychain item under the configured
 * service; an index item lists the record keys because the platform tools
 * cannot enumerate items by service. Changes made outside this
 * process are not observed, so only this provider's own writes emit update
 * events.
 * @module @deepseek-ai/dsh-credentials-keychain
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'
import { createBackend, spawnRunner } from './backend.ts'
import type { KeychainBackend } from './backend.ts'

export type { KeychainCommandResult, KeychainCommandRunner, KeychainBackend } from './backend.ts'
export { createBackend, macosBackend, secretServiceBackend, spawnRunner } from './backend.ts'

/** Default keychain service name. */
export const DEFAULT_SERVICE = 'dsh'

/** Characters allowed in a service name: the macOS interactive parser reads it unquoted. */
const SERVICE_PATTERN = /^[A-Za-z0-9._-]+$/

/** Account of the item listing every stored record key. */
const INDEX_ACCOUNT = 'index'

/** Plugin config. */
export interface Config {
  /** Keychain service name shared by every item; defaults to `dsh`. */
  service?: string
}

/**
 * Resolve the service name from plugin config.
 * @param config - raw plugin config.
 * @returns the validated service name.
 * @throws when the name has characters the platform tools cannot take unquoted.
 */
export function resolveService(config: Config): string {
  const service = config.service ?? DEFAULT_SERVICE
  if (!SERVICE_PATTERN.test(service)) {
    throw new TypeError(`credentials-keychain: service "${service}" must match ${SERVICE_PATTERN.source}`)
  }
  return service
}

/** Keychain account of a reference. */
function refAccount(ref: CredentialRef): string {
  return `ref:${ref}`
}

/** Keychain account of a record; key segments are lowercase letters, digits, and hyphens around one `/`. */
function recordAccount(key: CredentialKey): string {
  return `record:${key}`
}

/**
 * Parse one stored record, refusing anything this provider could not have written.
 * @param key - record address, for the failure message.
 * @param text - stored JSON text.
 * @returns the record.
 */
function parseRecord(key: CredentialKey, text: string): CredentialRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`credentials-keychain: record "${key}" is not valid JSON`, { cause: error })
  }
  const kind = typeof parsed === 'object' && parsed !== null && 'kind' in parsed ? parsed.kind : undefined
  if (kind === undefined) throw new Error(`credentials-keychain: record "${key}" has no kind`)
  if (kind !== 'api-key' && kind !== 'grant') throw new Error(`credentials-keychain: record "${key}" has unknown kind`)
  return parsed as CredentialRecord
}

/**
 * JSON-serialize a value, exposing that `JSON.stringify` returns `undefined`
 * for functions, symbols, and `undefined` despite its `string` signature.
 * @param value - value to serialize.
 * @returns the JSON text, or `undefined` when the value has no JSON form.
 */
function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value)
}

/**
 * Refuse a record the read path would refuse, before it is stored.
 * @param key - record address, for the failure message.
 * @param record - the record a mutation returned.
 */
function assertStorable(key: CredentialKey, record: CredentialRecord): void {
  if (record.kind === 'grant') {
    if (stringifyJson(record.payload) === undefined) {
      throw new TypeError(`credentials-keychain: record "${key}" payload is not JSON-serializable`)
    }
    return
  }
  if (record.key !== undefined && record.key.length === 0) {
    throw new TypeError(`credentials-keychain: record "${key}" has an empty key; omit the field instead`)
  }
  for (const [name, value] of Object.entries(record.env ?? {})) {
    credentialRef(name)
    if (value.length === 0) {
      throw new TypeError(`credentials-keychain: record "${key}" env "${name}" must be a non-empty string`)
    }
  }
}

/** Credential provider backed by the OS secret store; see the module comment. */
export class KeychainCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    service: z.string().default(DEFAULT_SERVICE),
  })

  private readonly backend: KeychainBackend
  /** Serializes every write so index updates never interleave. */
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.backend = this.createBackend(resolveService(config))
  }

  /**
   * Build the platform backend; the single place a different store is chosen.
   * @param service - validated service name.
   * @returns the backend for this process's platform.
   */
  protected createBackend(service: string): KeychainBackend {
    return createBackend(process.platform, service, spawnRunner)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.closed = true
      await this.operations
    }
    // Reading the index proves the store is reachable before any consumer resolves a key.
    await this.readIndex()
  }

  /** Reference value from the process environment, or `undefined` when empty or unset. */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /** The `.env` fallback, ranked below the keychain and the process environment. */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  /** Stored non-empty reference value; an empty item is absent. */
  private async stored(ref: CredentialRef): Promise<string | undefined> {
    const value = await this.backend.get(refAccount(ref))
    return value !== undefined && value.length > 0 ? value : undefined
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const stored = await this.stored(ref)
    if (stored !== undefined) return { value: stored, source: 'keychain' }
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return { value: inherited, source: 'env' }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { value: fallback.value, source: fallback.source }
    return undefined
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (await this.stored(ref) !== undefined) return { configured: true, source: 'keychain', writable: true }
    if (this.inherited(ref) !== undefined) return { configured: true, source: 'env', writable: true }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-keychain: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.enqueue(async () => {
      await this.backend.set(refAccount(ref), value)
      this.notifyUpdated(ref)
    })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.enqueue(async () => {
      await this.backend.delete(refAccount(ref))
      this.notifyUpdated(ref)
    })
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const text = await this.backend.get(recordAccount(key))
    return text === undefined ? undefined : parseRecord(key, text)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = await this.readRecord(key)
    if (record === undefined) return { configured: false, writable: true }
    return { configured: true, kind: record.kind, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries: CredentialRecordEntry[] = []
    for (const key of await this.readIndex()) {
      const record = await this.readRecord(key)
      if (record !== undefined) entries.push({ key, kind: record.kind })
    }
    return entries
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.enqueue(async () => {
      const current = await this.readRecord(key)
      const next = await mutate(current)
      if (next === undefined) return current
      assertStorable(key, next)
      await this.backend.set(recordAccount(key), JSON.stringify(next))
      await this.indexAdd(key)
      this.notifyRecordUpdated(key)
      return next
    })
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    await this.enqueue(async () => {
      if (await this.backend.get(recordAccount(key)) === undefined) return
      await this.backend.delete(recordAccount(key))
      await this.indexRemove(key)
      this.notifyRecordUpdated(key)
    })
  }

  /** Run one write after every earlier write settled; a failure does not block later writes. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('credentials-keychain is disposed'))
    const run = this.operations.then(operation)
    this.operations = run.then(() => {}, () => {})
    return run
  }

  private async readIndex(): Promise<CredentialKey[]> {
    const text = await this.backend.get(INDEX_ACCOUNT)
    if (text === undefined) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error('credentials-keychain: the record index is not valid JSON', { cause: error })
    }
    if (!Array.isArray(parsed)) throw new Error('credentials-keychain: the record index is not a list')
    return parsed.map(item => parseCredentialKey(String(item)))
  }

  private async indexAdd(key: CredentialKey): Promise<void> {
    const keys = await this.readIndex()
    if (keys.includes(key)) return
    await this.backend.set(INDEX_ACCOUNT, JSON.stringify([...keys, key]))
  }

  private async indexRemove(key: CredentialKey): Promise<void> {
    const keys = await this.readIndex()
    if (!keys.includes(key)) return
    const rest = keys.filter(candidate => candidate !== key)
    if (rest.length === 0) await this.backend.delete(INDEX_ACCOUNT)
    else await this.backend.set(INDEX_ACCOUNT, JSON.stringify(rest))
  }
}

export default KeychainCredentialProvider
