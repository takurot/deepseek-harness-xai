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

import { constants as bufferConstants } from 'node:buffer'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CredentialProvider, decodeCredentialRecord, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
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
import type { KeychainBackend, KeychainCommandRunner } from './backend.ts'
import { KeychainCommandError, resolveCommandOptions } from './command-runner.ts'
import type { KeychainCommandSpec } from './command-runner.ts'
import type { KeychainCommandResult } from './backend.ts'
import { withServiceLock } from './service-lock.ts'

export { KeychainCommandError, resolveCommandOptions } from './command-runner.ts'
export type { KeychainCommandOptions, KeychainCommandSpec } from './command-runner.ts'
export { KeychainStorageLimitError } from './backend.ts'
export { KeychainLockError } from './service-lock.ts'

export type { KeychainCommandResult, KeychainCommandRunner, KeychainBackend } from './backend.ts'
export { createBackend, macosBackend, secretServiceBackend, spawnRunner } from './backend.ts'

/** Default keychain service name. */
export const DEFAULT_SERVICE = 'dsh'

/** Characters allowed in a service name: the macOS interactive parser reads it unquoted. */
const SERVICE_PATTERN = /^[A-Za-z0-9._-]+$/

/** Account of the item listing every stored record key. */
const INDEX_ACCOUNT = 'index'

/** Default acquisition budget; configurable through lockWaitMs. */
const DEFAULT_LOCK_WAIT_MS = 30_000

/** A record transaction failed with an unknown stored outcome; inspect after recovery before retrying. */
export class KeychainCommitError extends Error {
  /** Stable code for a commit or repair whose backend outcome is unknown. */
  readonly code = 'KEYCHAIN_COMMIT_UNKNOWN'
  /** Storage may already contain the replacement; inspect after attempting recovery. */
  readonly outcome = 'unknown'

  constructor(readonly commandReason?: KeychainCommandError['reason']) {
    super('credentials-keychain: record commit outcome is unknown; reopen the provider to attempt recovery, then inspect the credential before retrying')
    this.name = 'KeychainCommitError'
  }
}

/** Pending record replacement and complete target index, stored in the OS secret store. */
interface RecordIntent {
  version: 1
  key: CredentialKey
  record: string | null
  keys: CredentialKey[]
}

/** One transaction at a time; concurrent processes require the service-wide lock. */
const JOURNAL_ACCOUNT = 'record-transaction-v1'

/** Plugin config. */
export interface Config {
  /** Keychain service name shared by every item; defaults to `dsh`. */
  service?: string
  /** Maximum time to acquire the OS-user/service lock, in milliseconds; defaults to 30,000. */
  lockWaitMs?: number
  /** Deadline for each OS command, in milliseconds; defaults to 30,000. */
  commandTimeoutMs?: number
  /** Combined stdout/stderr bytes and complete item read-back budget; defaults to 4,194,304. */
  commandOutputLimitBytes?: number
  /** Milliseconds between group TERM and KILL; defaults to 1000. */
  commandKillGraceMs?: number
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
  } catch (_error) {
    // JSON parser diagnostics can include the stored credential.
    throw new Error(`credentials-keychain: record "${key}" is not valid JSON`)
  }
  return decodeCredentialRecord(parsed, `credentials-keychain: record "${key}"`)
}

/** Credential provider backed by the OS secret store; see the module comment. */
export class KeychainCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    service: z.string().default(DEFAULT_SERVICE),
    lockWaitMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_LOCK_WAIT_MS),
    commandTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
    commandOutputLimitBytes: z.number().step(1).min(1)
      .max(Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH)).default(4_194_304),
    commandKillGraceMs: z.number().step(1).min(1).max(2_147_483_647).default(1000),
  })

  private readonly backend: KeychainBackend
  private readonly service: string
  private readonly lockWaitMs: number
  private readonly shutdown = new AbortController()
  private readonly commandSpec: KeychainCommandSpec
  private readonly commands = new Set<Promise<KeychainCommandResult>>()
  private lockFd: number | undefined
  /** Serializes local writes and record reads before acquiring the service lock. */
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.service = resolveService(config)
    this.lockWaitMs = config.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
    if (!Number.isSafeInteger(this.lockWaitMs) || this.lockWaitMs < 1) {
      throw new TypeError('credentials-keychain: lockWaitMs must be a positive safe integer')
    }
    this.commandSpec = resolveCommandOptions({
      timeoutMs: config.commandTimeoutMs,
      outputLimitBytes: config.commandOutputLimitBytes,
      killGraceMs: config.commandKillGraceMs,
      signal: this.shutdown.signal,
    })
    this.backend = this.createBackend(this.service, (command, args, stdin) => {
      if (this.closed) return Promise.reject(new KeychainCommandError('cancelled', 'not-started'))
      const pending = spawnRunner(command, args, stdin, this.lockFd, this.commandSpec)
      this.commands.add(pending)
      void pending.then(() => { this.commands.delete(pending) }, () => { this.commands.delete(pending) })
      return pending
    }, this.commandSpec.outputLimitBytes)
  }

  /**
   * Build the platform backend; the single place a different store is chosen.
   * @param service - validated service name.
   * @param run - runner inheriting the currently held service-lock descriptor.
   * @param outputLimitBytes - complete item read-back budget.
   * @returns the backend for this process's platform.
   */
  protected createBackend(service: string, run: KeychainCommandRunner, outputLimitBytes: number): KeychainBackend {
    return createBackend(process.platform, service, run, outputLimitBytes)
  }

  /** Private lock directory shared by every profile of this OS user. */
  protected lockDirectory(): string {
    return join(userInfo().homedir, '.dsh-keychain-locks')
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.closed = true
      this.shutdown.abort(new Error('credentials-keychain is disposed'))
      await Promise.allSettled([this.operations, ...this.commands])
    }
    // Reading the index proves the store is reachable before any consumer resolves a key.
    await this.enqueue(async () => {
      await this.recoverRecords()
      await this.readIndex()
    })
  }

  /* jscpd:ignore-start -- Mirrors credentials-local; a shared credentials helper would replace both. */
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
  /* jscpd:ignore-end */

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

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.recordOperation(() => this.readStoredRecord(key))
  }

  private async readStoredRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const text = await this.backend.get(recordAccount(key))
    return text === undefined ? undefined : parseRecord(key, text)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = await this.readRecord(key)
    if (record === undefined) return { configured: false, writable: true }
    return { configured: true, kind: record.kind, writable: true }
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.recordOperation(async () => {
      const entries: CredentialRecordEntry[] = []
      for (const key of await this.readIndex()) {
        const record = await this.readStoredRecord(key)
        if (record !== undefined) entries.push({ key, kind: record.kind })
      }
      return entries
    })
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.recordOperation(async () => {
      const current = await this.readStoredRecord(key)
      const next = await mutate(current === undefined ? undefined : decodeCredentialRecord(current, `credentials-keychain: record "${key}"`))
      if (next === undefined) return current
      const admitted = decodeCredentialRecord(next, `credentials-keychain: record "${key}"`)
      const keys = await this.readIndex()
      await this.commitRecord({ version: 1, key, record: JSON.stringify(admitted), keys: keys.includes(key) ? keys : [...keys, key] })
      return admitted
    })
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    return this.recordOperation(async () => {
      const keys = await this.readIndex()
      if (await this.backend.get(recordAccount(key)) === undefined && !keys.includes(key)) return
      await this.commitRecord({ version: 1, key, record: null, keys: keys.filter(candidate => candidate !== key) })
    })
  }

  private recordOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.recoverRecords()
      return operation()
    })
  }

  /** Retain the intent until every item agrees; an error may occur after its store effect. */
  private async commitRecord(intent: RecordIntent): Promise<void> {
    const journal = JSON.stringify(intent)
    this.backend.assertCanStore(journal)
    if (intent.record !== null) this.backend.assertCanStore(intent.record)
    if (intent.keys.length > 0) this.backend.assertCanStore(JSON.stringify(intent.keys))
    try {
      await this.backend.set(JOURNAL_ACCOUNT, journal)
      await this.applyRecord(intent)
    } catch (error) {
      // Backend errors may contain secret output and do not establish whether the operation took effect.
      throw new KeychainCommitError(error instanceof KeychainCommandError ? error.reason : undefined)
    }
  }

  private async applyRecord(intent: RecordIntent): Promise<void> {
    if (intent.record === null) await this.backend.delete(recordAccount(intent.key))
    else await this.backend.set(recordAccount(intent.key), intent.record)
    if (intent.keys.length === 0) await this.backend.delete(INDEX_ACCOUNT)
    else await this.backend.set(INDEX_ACCOUNT, JSON.stringify(intent.keys))
    await this.backend.delete(JOURNAL_ACCOUNT)
    this.notifyRecordUpdated(intent.key)
  }

  private async recoverRecords(): Promise<void> {
    const text = await this.backend.get(JOURNAL_ACCOUNT)
    if (text === undefined) return
    const intent = this.parseIntent(text)
    try {
      await this.applyRecord(intent)
    } catch (error) {
      // Recovery retains its journal whenever cleanup has not taken effect.
      throw new KeychainCommitError(error instanceof KeychainCommandError ? error.reason : undefined)
    }
  }

  private parseIntent(text: string): RecordIntent {
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null
        || !('version' in value) || value.version !== 1
        || !('key' in value) || typeof value.key !== 'string'
        || !('record' in value) || !(value.record === null || typeof value.record === 'string')
        || !('keys' in value) || !Array.isArray(value.keys)
        || Object.keys(value).length !== 4) throw new Error('invalid intent')
      const key = parseCredentialKey(value.key)
      const keys = value.keys.map((item: unknown) => {
        if (typeof item !== 'string') throw new Error('invalid index')
        return parseCredentialKey(item)
      })
      if (new Set(keys).size !== keys.length || keys.includes(key) !== (value.record !== null)) throw new Error('inconsistent intent')
      if (value.record !== null) parseRecord(key, value.record)
      return { version: 1, key, record: value.record, keys }
    } catch (_error) {
      // Parser diagnostics and causes may contain the saved credential.
      throw new Error('credentials-keychain: invalid record transaction; preserve the store and repair it before continuing')
    }
  }

  /** Run one write after every earlier write settled; a failure does not block later writes. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('credentials-keychain is disposed'))
    const run = this.operations.then(() => withServiceLock(
      this.lockDirectory(), this.service, this.lockWaitMs, this.shutdown.signal,
      async (fd) => {
        this.lockFd = fd
        try { return await operation() } finally { this.lockFd = undefined }
      },
    ))
    this.operations = run.then(() => {}, () => {})
    return run
  }

  private async readIndex(): Promise<CredentialKey[]> {
    const text = await this.backend.get(INDEX_ACCOUNT)
    if (text === undefined) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (_error) {
      // Parser diagnostics can contain secret-store output.
      throw new Error('credentials-keychain: the record index is not valid JSON')
    }
    if (!Array.isArray(parsed)) throw new Error('credentials-keychain: the record index is not a list')
    return parsed.map((item: unknown) => {
      try {
        if (typeof item !== 'string') throw new Error('invalid index entry')
        return parseCredentialKey(item)
      } catch (_error) {
        throw new Error('credentials-keychain: invalid record index entry; preserve the store and repair it before continuing')
      }
    })
  }

}

export default KeychainCredentialProvider
