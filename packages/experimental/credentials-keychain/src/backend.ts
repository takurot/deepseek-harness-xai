/**
 * OS secret-store backends for the keychain credentials provider. Each backend
 * maps an account name to one opaque secret string under one service name and
 * talks to the platform's own command-line client, so the package adds no
 * native dependency. Secret values travel through the child's stdin or stdout,
 * never its argument vector, which other processes of the same user can read
 * through `ps`.
 * @module @deepseek-ai/dsh-credentials-keychain/backend
 */

import { spawn } from 'node:child_process'

/** Outcome of one finished command. */
export interface KeychainCommandResult {
  /** Exit code; `null` when a signal ended the child. */
  code: number | null
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
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

/**
 * The spawn-backed {@link KeychainCommandRunner}.
 * @param command - executable name resolved through `PATH`.
 * @param args - argument vector; must never carry a secret.
 * @param stdin - text written to the child's stdin before it is closed.
 * @returns the exit code and captured output.
 */
export function spawnRunner(command: string, args: readonly string[], stdin?: string): Promise<KeychainCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    // A child that exits before reading stdin closes the pipe; the exit code reports that failure.
    child.stdin.once('error', () => {})
    child.stdin.end(stdin)
  })
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
 * @returns the backend, preferring successor values over legacy values.
 */
export function macosBackend(service: string, run: KeychainCommandRunner): KeychainBackend {
  const failure = (operation: string): Error => new Error(`credentials-keychain: macOS ${operation} failed; unlock the Keychain and verify access, then inspect the store before retrying`)
  const native = async (operation: 'get' | 'set' | 'delete', account: string, secret?: string): Promise<MacosResult> => {
    const request = { operation, service, account: `v2:${account}`, ...(secret === undefined ? {} : { secret: Buffer.from(secret).toString('base64') }) }
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_SCRIPT], JSON.stringify(request))
    if (result.code !== 0) throw failure(operation)
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
    async get(account) {
      const result = await native('get', account)
      if ('secret' in result) {
        const bytes = Buffer.from(result.secret, 'base64')
        const value = bytes.toString('utf8')
        if (bytes.toString('base64') !== result.secret || !Buffer.from(value, 'utf8').equals(bytes)) throw failure('get')
        return value
      }
      if (result.status !== MACOS_STATUS_NOT_FOUND) throw failure('get')
      const legacy = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      if (legacy.code === MACOS_ITEM_NOT_FOUND) return undefined
      if (legacy.code !== 0) throw commandFailure('security find-generic-password', legacy)
      return Buffer.from(legacy.stdout.trim(), 'base64').toString('utf8')
    },
    async set(account, secret) {
      if ((await native('set', account, secret)).status !== 0) throw failure('set')
    },
    async delete(account) {
      // Removing legacy first prevents a failed successor removal from revealing an older value.
      const legacy = await run('security', ['-i'], `delete-generic-password -s ${service} -a ${account}\n`)
      if (legacy.code !== 0 && legacy.code !== MACOS_ITEM_NOT_FOUND) throw commandFailure('security delete-generic-password', legacy)
      const result = await native('delete', account)
      if (result.status !== 0 && result.status !== MACOS_STATUS_NOT_FOUND) throw failure('delete')
    },
  }
}

/**
 * Freedesktop Secret Service through `secret-tool` (libsecret). `store` reads
 * the secret from stdin, `lookup` prints it, and a missing item is exit 1 with
 * empty stderr; any diagnostic text means the service itself failed.
 * @param service - attribute value identifying the harness items.
 * @param run - command runner.
 * @returns the backend.
 */
export function secretServiceBackend(service: string, run: KeychainCommandRunner): KeychainBackend {
  return {
    async get(account) {
      const result = await run('secret-tool', ['lookup', 'service', service, 'account', account])
      if (result.code === 0) return result.stdout
      if (result.code === 1 && result.stderr.trim().length === 0) return undefined
      throw commandFailure('secret-tool lookup', result)
    },
    async set(account, secret) {
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
 * @returns the backend for macOS or Linux.
 * @throws on any other platform, which has no supported store yet.
 */
export function createBackend(platform: NodeJS.Platform, service: string, run: KeychainCommandRunner): KeychainBackend {
  if (platform === 'darwin') return macosBackend(service, run)
  if (platform === 'linux') return secretServiceBackend(service, run)
  throw new Error(`credentials-keychain: platform "${platform}" has no supported secret store; use credentials-local`)
}

/** Failure carrying the tool's diagnostic text; the secret is never in the arguments or output of a failed call. */
function commandFailure(what: string, result: KeychainCommandResult): Error {
  const detail = result.stderr.trim()
  return new Error(`credentials-keychain: ${what} failed with exit code ${String(result.code)}${detail.length > 0 ? `: ${detail}` : ''}`)
}
