/**
 * OS secret-store backends for the keychain credentials provider. Each backend
 * maps an account name to one opaque secret string under one service name and
 * talks to the platform's own command-line client. The provider's lock
 * descriptor follows each helper. Secret values travel through stdin or stdout,
 * never its argument vector, which other processes of the same user can read
 * through `ps`.
 * @module @deepseek-ai/dsh-credentials-keychain/backend
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

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
 * @param lockFd - held service-lock descriptor inherited as fd 3 until the helper exits.
 * @returns the exit code and captured output.
 */
export function spawnRunner(command: string, args: readonly string[], stdin?: string, lockFd?: number): Promise<KeychainCommandResult> {
  return new Promise((resolve, reject) => {
    // Node's tuple overload describes only three descriptors; the first three remain pipes.
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe', lockFd ?? 'ignore'] }) as ChildProcessWithoutNullStreams
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

/** A constant JXA program; all item data arrives on stdin, never as executable source. */
const MACOS_WRITE_SCRIPT = String.raw`
ObjC.import('Foundation')
ObjC.import('Security')
function run() {
  try {
    const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
    const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)))
    const query = $.NSMutableDictionary.alloc.init
    query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass))
    query.setObjectForKey($(request.service), ObjC.castRefToObject($.kSecAttrService))
    query.setObjectForKey($(request.account), ObjC.castRefToObject($.kSecAttrAccount))
    const attributes = $.NSMutableDictionary.alloc.init
    attributes.setObjectForKey($(request.secret).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData))
    let status = $.SecItemUpdate(query, attributes)
    if (status === -25300) {
      const security = Ref()
      status = $.SecTrustedApplicationCreateFromPath('/usr/bin/security', security)
      if (status !== 0) return String(status)
      const script = Ref()
      status = $.SecTrustedApplicationCreateFromPath('/usr/bin/osascript', script)
      if (status !== 0) return String(status)
      const access = Ref()
      status = $.SecAccessCreate($(request.service), $([ObjC.castRefToObject(security[0]), ObjC.castRefToObject(script[0])]), access)
      if (status !== 0) return String(status)
      query.setObjectForKey(ObjC.castRefToObject(access[0]), ObjC.castRefToObject($.kSecAttrAccess))
      query.addEntriesFromDictionary(attributes)
      status = $.SecItemAdd(query, null)
    }
    return String(status)
  } catch (error) {
    return 'invalid'
  }
}
`

/**
 * macOS Keychain: Security APIs write stdin JSON through the system JXA bridge;
 * `security` reads and deletes existing items. Base64 storage preserves the
 * format used by earlier interactive writes.
 * @param service - keychain service name.
 * @param run - command runner.
 * @returns the backend.
 */
export function macosBackend(service: string, run: KeychainCommandRunner): KeychainBackend {
  return {
    async get(account) {
      const result = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      if (result.code === MACOS_ITEM_NOT_FOUND) return undefined
      if (result.code !== 0) throw commandFailure('security find-generic-password', result)
      return Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
    },
    async set(account, secret) {
      const encoded = Buffer.from(secret, 'utf8').toString('base64')
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_WRITE_SCRIPT], JSON.stringify({ service, account, secret: encoded }))
      if (result.code !== 0 || result.stdout.trim() !== '0') {
        throw new Error('credentials-keychain: Keychain write failed; verify the store is accessible before retrying')
      }
    },
    async delete(account) {
      const result = await run('security', ['-i'], `delete-generic-password -s ${service} -a ${account}\n`)
      if (result.code !== 0 && result.code !== MACOS_ITEM_NOT_FOUND) {
        throw commandFailure('security delete-generic-password', result)
      }
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
