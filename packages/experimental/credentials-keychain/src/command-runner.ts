/** Bounded OS-secret command execution and ownership of its detached process group. */

import { constants as bufferConstants } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { KeychainCommandResult } from './backend.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 4_194_304
const DEFAULT_KILL_GRACE_MS = 1000

/** Optional command budgets; values are resolved and validated before a child starts. */
export interface KeychainCommandOptions {
  timeoutMs?: number | undefined
  outputLimitBytes?: number | undefined
  killGraceMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** Validated budgets for one command. */
export interface KeychainCommandSpec {
  readonly timeoutMs: number
  readonly outputLimitBytes: number
  readonly killGraceMs: number
  readonly signal?: AbortSignal | undefined
}

/** An OS credential command failed; no child output or caller-owned cause is retained. */
export class KeychainCommandError extends Error {
  /** Stable machine-readable command failure code. */
  readonly code: string

  constructor(
    readonly reason: 'timeout' | 'cancelled' | 'output-limit' | 'spawn' | 'exit' | 'invalid-result' | 'store',
    readonly outcome: 'not-started' | 'unknown',
    readonly exitCode?: number | null,
    readonly storeStatus?: number,
  ) {
    super(`credentials-keychain: OS command ${reason}${exitCode === undefined ? '' : ` (exit ${String(exitCode)})`}${storeStatus === undefined ? '' : ` (store status ${String(storeStatus)})`}; ${outcome === 'not-started' ? 'no command started' : 'the stored outcome may be unknown; verify the store is reachable and unlocked, then inspect credentials and recover pending records before retrying'}`)
    this.name = 'KeychainCommandError'
    this.code = `KEYCHAIN_COMMAND_${reason.toUpperCase().replaceAll('-', '_')}`
  }
}

/**
 * Resolve command budgets before launch.
 * @param options - optional raw command budgets and provider shutdown signal.
 * @returns validated budgets without starting a process.
 * @throws TypeError when a budget is not a supported positive integer.
 */
export function resolveCommandOptions(options: KeychainCommandOptions = {}): KeychainCommandSpec {
  const spec = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  for (const name of ['timeoutMs', 'outputLimitBytes', 'killGraceMs'] as const) {
    const value = spec[name]
    const maximum = name === 'outputLimitBytes' ? Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH) : MAX_TIMER_DELAY_MS
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`credentials-keychain: ${name} must be a positive integer no greater than ${String(maximum)}`)
    }
  }
  return spec
}

/**
 * Inspect Linux group members, excluding zombies that retain no descriptors.
 * @param pgid - owned process-group identifier.
 * @returns true for a live member, false for an observed zombie-only group, or undefined without evidence.
 */
export function linuxGroupHasLiveMembers(pgid: number): boolean | undefined {
  let entries: string[]
  try { entries = readdirSync('/proc') } catch (_unreadableProcDirectory) { return undefined }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let text: string
    try { text = readFileSync(`/proc/${entry}/stat`, 'utf8') } catch (_exitedOrUnreadableProcess) { continue }
    const fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/)
    if (Number(fields[2]) !== pgid) continue
    matched = true
    // A zombie leader may still have exiting threads that retain the shared descriptor table.
    if (!/^[ZXx]$/.test(String(fields[0])) || Number(fields[17]) > 1) return true
  }
  return matched ? false : undefined
}

/**
 * Run a command under a combined byte budget and deadline, preserving its inherited service lock.
 * @param command - executable; never contains credential data.
 * @param args - argument vector; never contains credential data.
 * @param stdin - credential data written before closing stdin.
 * @param lockFd - held service-lock descriptor inherited as fd 3.
 * @param options - command budgets and provider shutdown signal.
 * @returns captured bounded output after the leader and its owned process group are quiescent.
 * @throws TypeError when a budget cannot be represented by Node.
 * @throws KeychainCommandError for launch, deadline, cancellation, or output failure; no raw output escapes.
 */
export function spawnRunner(
  command: string,
  args: readonly string[],
  stdin?: string,
  lockFd?: number,
  options: KeychainCommandOptions = {},
): Promise<KeychainCommandResult> {
  const spec = resolveCommandOptions(options)
  if (spec.signal?.aborted) return Promise.reject(new KeychainCommandError('cancelled', 'not-started'))
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32'
    let child: ChildProcessWithoutNullStreams
    try {
      // Node's tuple overload cannot describe the extra inherited descriptor; the first three are pipes.
      child = spawn(command, [...args], { detached: posix, stdio: ['pipe', 'pipe', 'pipe', lockFd ?? 'ignore'] }) as ChildProcessWithoutNullStreams
    } catch (_invalidProcessRequest) {
      reject(new KeychainCommandError('spawn', 'not-started'))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: KeychainCommandError | undefined
    let closed = false
    let exited = false
    let settled = false
    let code: number | null = null
    let grace: ReturnType<typeof setTimeout> | undefined

    const alive = (): boolean => {
      if (child.pid === undefined) return false
      if (!posix) return !exited
      try {
        process.kill(-child.pid, 0)
        return !(exited && process.platform === 'linux' && linuxGroupHasLiveMembers(child.pid) === false)
      } catch (error) {
        return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH'
      }
    }
    const signal = (value: NodeJS.Signals): void => {
      if (child.pid === undefined || !alive()) return
      try {
        if (posix) process.kill(-child.pid, value)
        else child.kill(value)
      } catch (_exitedDuringSignal) {
        // Process exit can race the liveness check; no signal targets another group.
      }
    }
    const fail = (reason: KeychainCommandError['reason']): void => {
      if (failure !== undefined || settled) return
      failure = new KeychainCommandError(reason, child.pid === undefined ? 'not-started' : 'unknown')
      signal('SIGTERM')
      grace = setTimeout(() => { signal('SIGKILL'); check() }, spec.killGraceMs)
    }
    const abort = (): void => { fail('cancelled') }
    const check = (): void => {
      if (settled || !closed || alive()) return
      settled = true
      clearTimeout(deadline)
      if (grace !== undefined) clearTimeout(grace)
      clearInterval(observation)
      spec.signal?.removeEventListener('abort', abort)
      if (failure !== undefined) reject(failure)
      else resolve({ code, stdout: code === 0 ? Buffer.concat(stdout).toString('utf8') : '', stderr: code === 0 ? Buffer.concat(stderr).toString('utf8') : stderr.length === 0 ? '' : '!' })
    }
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (failure !== undefined) return
      const remaining = spec.outputLimitBytes - bytes
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      bytes += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) fail('output-limit')
    }
    const deadline = setTimeout(() => { fail('timeout') }, spec.timeoutMs)
    const observation = setInterval(check, 20)
    spec.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { capture(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { capture(stderr, chunk) })
    child.once('error', () => { fail('spawn') })
    child.once('exit', () => { exited = true })
    child.once('close', (exitCode) => { closed = true; exited = true; code = exitCode; check() })
    child.stdin.once('error', (_closedBeforeInput) => {
      // A command can exit before reading stdin; its exit result remains authoritative.
    })
    if (spec.signal?.aborted) { abort(); child.stdin.end() }
    else child.stdin.end(stdin)
  })
}
