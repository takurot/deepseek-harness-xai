/**
 * OS secret-store backends for the keychain credentials provider. Each backend
 * maps an account name to one opaque secret string under one service name and
 * talks to the platform's own command-line client. The provider's lock
 * descriptor follows each helper. Secret values travel through stdin or stdout,
 * never its argument vector, which other processes of the same user can read
 * through `ps`.
 * @module @deepseek-ai/dsh-credentials-keychain/backend
 */

import { KeychainCommandError, resolveCommandOptions } from './command-runner.ts'
export { spawnRunner } from './command-runner.ts'
export type { KeychainCommandOptions, KeychainCommandSpec } from './command-runner.ts'

/** Outcome of one finished command. */
export interface KeychainCommandResult {
  /** Exit code; `null` when a signal ended the child. */
  code: number | null
  /** Captured standard output for exit 0; empty on a failed exit. */
  stdout: string
  /** Captured standard error for exit 0; `!` records only presence on a failed exit. */
  stderr: string
}

/**
 * Run one command to completion.
 * @param command - executable name resolved through `PATH`.
 * @param args - argument vector; must never carry a secret.
 * @param stdin - text written to the child's stdin before it is closed.
 * @returns the exit code and captured output.
 * @throws when the executable cannot be started.
 */
export type KeychainCommandRunner = (command: string, args: readonly string[], stdin?: string) => Promise<KeychainCommandResult>

/** One secret per account under a fixed service; values are opaque to the backend. */
export interface KeychainBackend {
  /**
   * Refuse unreadable or platform-truncated item text before store access.
   * @param secret - complete candidate item text.
   * @throws KeychainStorageLimitError before any storage effect.
   */
  assertCanStore(secret: string): void
  /**
   * Read one secret.
   * @param account - account name.
   * @returns the secret, or `undefined` while none is stored.
   * @throws when the store is unreachable or refuses the read.
   */
  get(account: string): Promise<string | undefined>
  /**
   * Create or replace one secret.
   * @param account - account name.
   * @param secret - non-empty secret text.
   * @throws when the store refuses the write.
   */
  set(account: string, secret: string): Promise<void>
  /**
   * Remove one secret; removing an absent secret is a no-op.
   * @param account - account name.
   * @throws when the store refuses the removal.
   */
  delete(account: string): Promise<void>
}

/** A candidate item was refused before any storage effect. */
export class KeychainStorageLimitError extends Error {
  /** Stable machine-readable input-refusal code. */
  readonly code = 'KEYCHAIN_STORAGE_LIMIT'
  /** No storage command ran for the refused input. */
  readonly outcome = 'unchanged'

  constructor(readonly reason: 'read-budget' | 'platform-input') {
    super(reason === 'read-budget'
      ? 'credentials-keychain: value exceeds the complete command read-back budget; increase commandOutputLimitBytes before saving'
      : 'credentials-keychain: value exceeds the secret-tool 8192-byte stdin limit; use another credential provider before saving')
    this.name = 'KeychainStorageLimitError'
  }
}

/** Exit code of `security` for a missing item. */
const MACOS_ITEM_NOT_FOUND = 44

/** Native statuses are distinct from the legacy security tool's exit codes. */
const MACOS_STATUS_NOT_FOUND = -25300

/** One JXA host owns successor items; request values arrive only through stdin. */
const MACOS_SCRIPT = String.raw`
ObjC.import('Foundation')
ObjC.import('Security')
function run() {
  try {
    $.SecKeychainSetUserInteractionAllowed(false)
    const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
    const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)))
    const query = $.NSMutableDictionary.alloc.init
    query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass))
    query.setObjectForKey($(request.service), ObjC.castRefToObject($.kSecAttrService))
    query.setObjectForKey($(request.account), ObjC.castRefToObject($.kSecAttrAccount))
    if (request.operation === 'get') {
      query.setObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kSecReturnData))
      const data = Ref()
      const status = $.SecItemCopyMatching(query, data)
      if (status !== 0) return JSON.stringify({ status: status })
      const secret = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(data[0]), $.NSUTF8StringEncoding))
      return JSON.stringify({ status: status, secret: secret })
    }
    if (request.operation === 'delete') return JSON.stringify({ status: $.SecItemDelete(query) })
    const attributes = $.NSMutableDictionary.alloc.init
    attributes.setObjectForKey($(request.secret).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData))
    let status = $.SecItemUpdate(query, attributes)
    if (status === -25300) {
      const application = Ref()
      status = $.SecTrustedApplicationCreateFromPath('/usr/bin/osascript', application)
      if (status !== 0) return JSON.stringify({ status: status })
      const access = Ref()
      status = $.SecAccessCreate($(request.service), $([ObjC.castRefToObject(application[0])]), access)
      if (status !== 0) return JSON.stringify({ status: status })
      query.setObjectForKey(ObjC.castRefToObject(access[0]), ObjC.castRefToObject($.kSecAttrAccess))
      query.addEntriesFromDictionary(attributes)
      status = $.SecItemAdd(query, null)
    }
    return JSON.stringify({ status: status })
  } catch (error) {
    return 'invalid'
  }
}
`

/** Result admitted from the native helper, without retaining its raw output in failures. */
type MacosResult = { status: number } | { status: 0; secret: string }

/**
 * macOS successor items use one JXA identity for reads and writes. Unversioned
 * items retain their original security-tool permissions until explicitly deleted.
 * @param service - keychain service name.
 * @param run - command runner.
 * @param outputLimitBytes - complete command read-back budget.
 * @returns the backend, preferring successor values over legacy values.
 */
export function macosBackend(service: string, run: KeychainCommandRunner, outputLimitBytes?: number): KeychainBackend {
  const limit = resolveCommandOptions({ outputLimitBytes }).outputLimitBytes
  const assertCanStore = (secret: string): void => {
    const result = JSON.stringify({ status: 0, secret: Buffer.from(secret, 'utf8').toString('base64') }) + '\n'
    if (Buffer.byteLength(result) > limit) throw new KeychainStorageLimitError('read-budget')
  }
  const failure = (_operation: string): Error => new KeychainCommandError('invalid-result', 'unknown')
  const native = async (operation: 'get' | 'set' | 'delete', account: string, secret?: string): Promise<MacosResult> => {
    const request = { operation, service, account: `v2:${account}`, ...(secret === undefined ? {} : { secret: Buffer.from(secret).toString('base64') }) }
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_SCRIPT], JSON.stringify(request))
    if (result.code !== 0) throw new KeychainCommandError('exit', 'unknown', result.code)
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch (_error) {
      // Parser text can contain credential bytes.
      throw failure(operation)
    }
    if (typeof value !== 'object' || value === null || !('status' in value)
      || typeof value.status !== 'number' || !Number.isSafeInteger(value.status)) throw failure(operation)
    if (operation === 'get' && value.status === 0) {
      if (!('secret' in value) || typeof value.secret !== 'string' || Object.keys(value).length !== 2) throw failure(operation)
      return { status: value.status, secret: value.secret }
    }
    if (Object.keys(value).length !== 1) throw failure(operation)
    return { status: value.status }
  }
  return {
    assertCanStore,
    async get(account) {
      const result = await native('get', account)
      if ('secret' in result) {
        const bytes = Buffer.from(result.secret, 'base64')
        const value = bytes.toString('utf8')
        if (bytes.toString('base64') !== result.secret || !Buffer.from(value, 'utf8').equals(bytes)) throw failure('get')
        return value
      }
      if (result.status !== MACOS_STATUS_NOT_FOUND) throw new KeychainCommandError('store', 'unknown', undefined, result.status)
      const legacy = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      if (legacy.code === MACOS_ITEM_NOT_FOUND) return undefined
      if (legacy.code !== 0) throw commandFailure('security find-generic-password', legacy)
      return Buffer.from(legacy.stdout.trim(), 'base64').toString('utf8')
    },
    async set(account, secret) {
      assertCanStore(secret)
      const result = await native('set', account, secret)
      if (result.status !== 0) throw new KeychainCommandError('store', 'unknown', undefined, result.status)
    },
    async delete(account) {
      // Removing legacy first prevents a failed successor removal from revealing an older value.
      const legacy = await run('security', ['-i'], `delete-generic-password -s ${service} -a ${account}\n`)
      if (legacy.code !== 0 && legacy.code !== MACOS_ITEM_NOT_FOUND) throw commandFailure('security delete-generic-password', legacy)
      const result = await native('delete', account)
      if (result.status !== 0 && result.status !== MACOS_STATUS_NOT_FOUND) throw new KeychainCommandError('store', 'unknown', undefined, result.status)
    },
  }
}

/**
 * Freedesktop Secret Service through `secret-tool` (libsecret). `store` reads
 * the secret from stdin, `lookup` prints it, and a missing item is exit 1 with
 * empty stderr; any diagnostic text means the service itself failed.
 * @param service - attribute value identifying the harness items.
 * @param run - command runner.
 * @param outputLimitBytes - complete command read-back budget.
 * @returns the backend.
 */
export function secretServiceBackend(service: string, run: KeychainCommandRunner, outputLimitBytes?: number): KeychainBackend {
  const limit = resolveCommandOptions({ outputLimitBytes }).outputLimitBytes
  const assertCanStore = (secret: string): void => {
    const bytes = Buffer.byteLength(secret, 'utf8')
    if (bytes > 8192) throw new KeychainStorageLimitError('platform-input')
    if (bytes > limit) throw new KeychainStorageLimitError('read-budget')
  }
  return {
    assertCanStore,
    async get(account) {
      const result = await run('secret-tool', ['lookup', 'service', service, 'account', account])
      if (result.code === 0) return result.stdout
      if (result.code === 1 && result.stderr.trim().length === 0) return undefined
      throw commandFailure('secret-tool lookup', result)
    },
    async set(account, secret) {
      assertCanStore(secret)
      const result = await run(
        'secret-tool',
        ['store', `--label=${service}: ${account}`, 'service', service, 'account', account],
        secret,
      )
      if (result.code !== 0) throw commandFailure('secret-tool store', result)
    },
    async delete(account) {
      const result = await run('secret-tool', ['clear', 'service', service, 'account', account])
      if (result.code !== 0 && !(result.code === 1 && result.stderr.trim().length === 0)) {
        throw commandFailure('secret-tool clear', result)
      }
    },
  }
}

/**
 * Select the backend for a platform.
 * @param platform - `process.platform` value.
 * @param service - service name shared by every item.
 * @param run - command runner.
 * @param outputLimitBytes - complete command read-back budget.
 * @returns the backend for macOS or Linux.
 * @throws on any other platform, which has no supported store yet.
 */
export function createBackend(
  platform: NodeJS.Platform, service: string, run: KeychainCommandRunner, outputLimitBytes?: number,
): KeychainBackend {
  if (platform === 'darwin') return macosBackend(service, run, outputLimitBytes)
  if (platform === 'linux') return secretServiceBackend(service, run, outputLimitBytes)
  throw new Error(`credentials-keychain: platform "${platform}" has no supported secret store; use credentials-local`)
}

/** Stable failures retain no secret-bearing output. */
function commandFailure(_what: string, result: KeychainCommandResult): Error {
  return new KeychainCommandError('exit', 'unknown', result.code)
}
