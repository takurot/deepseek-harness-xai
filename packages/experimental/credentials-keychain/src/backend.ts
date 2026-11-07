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

/**
 * macOS Keychain through the `security` tool. Reads use
 * `find-generic-password -w`; writes and deletes go through `security -i` so
 * the secret arrives on stdin. The interactive parser would misread quotes and
 * whitespace, so the stored text is base64 and account names are restricted to
 * the characters the provider generates.
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
      const result = await run('security', ['-i'], `add-generic-password -U -s ${service} -a ${account} -w ${encoded}\n`)
      if (result.code !== 0) throw commandFailure('security add-generic-password', result)
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
