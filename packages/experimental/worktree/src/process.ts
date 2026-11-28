/** Bounded, cancellable commands under the calling Session's existing file policy. */

import { finished } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { RunnerFailureRule, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { BoundedPipes, settlePipes } from './pipes.ts'

/** Resolved process resource limits owned by the worktree service. */
export interface ProcessConfig {
  /** Deadline for one command, including executable lookup and confinement. */
  timeoutMs: number
  /** Termination grace period for each managed subprocess. */
  graceMs: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes: number
}

/** Clear inherited repository, attribute-tree, command-line configuration, and replacement-ref selectors. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/**
 * Run an argv without a shell and await termination of its managed process range.
 * @param ctx - subprocess and sandbox providers in the same execution world.
 * @param config - complete process resource limits.
 * @param policy - unchanged calling Session policy.
 * @param cwd - canonical process working directory.
 * @param argv - executable followed by literal arguments.
 * @param signal - operation cancellation.
 * @param allowedExitCodes - command-specific successful statuses.
 * @param env - command-local environment overrides, applied after Git selector removal.
 * @param input - optional bounded payload for the child; omission ignores stdin.
 * @returns complete bounded stdout and the exit code.
 */
export async function runCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  allowedExitCodes: readonly number[] = [0],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<{ stdout: string; exitCode: number }> {
  using timeout = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  const { child } = await spawnConfined(ctx, policy, argv, {
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env },
    signal: timeout.signal,
    graceMs: config.graceMs,
    stdio: {
      stdin: input === undefined ? 'ignore' : 'pipe',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
  })
  const stdin = child.stdin
  const sent = stdin === undefined ? undefined : finished(stdin, { cleanup: true }).then(() => true, () => false)
  if (input !== undefined) stdin?.end(input)
  try {
    const outcome = await child.done
    timeout.signal.throwIfAborted()
    // The spawn spec above collects both streams.
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    const stderr = captured.stderr.readFrom(0)
    if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
      throw new Error(`worktree command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim()}`)
    }
    if (stdout.lossy) throw new Error('worktree command output exceeds maxOutputBytes')
    if (input !== undefined && !(await sent)) throw new Error('worktree command did not accept provisioning input')
    return { stdout: stdout.text, exitCode: outcome.exitCode }
  } finally {
    stdin?.destroy()
    child.terminate()
    if (sent !== undefined) await sent
    await child.waitForExit()
  }
}

/**
 * Read a complete UTF-8 Git listing; partial records must never drive provisioning.
 * @param ctx - subprocess and sandbox providers.
 * @param config - Git process limits.
 * @param policy - unchanged calling Session policy.
 * @param cwd - source checkout.
 * @param argv - Git executable followed by literal arguments.
 * @param signal - create cancellation.
 * @returns complete NUL-delimited stdout.
 * @throws if Git fails, exceeds its output budget, or returns invalid UTF-8.
 */
export async function readGitListing(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: [string, ...string[]],
  signal: AbortSignal,
): Promise<string> {
  using timer = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  const output = new BoundedPipes(config.maxOutputBytes)
  const { child } = await spawnConfined(ctx, policy, argv, {
    cwd, env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' },
    signal: timer.signal, graceMs: config.graceMs, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  })
  const { outcome, failed } = await settlePipes(child, output, timer.signal)
  timer.signal.throwIfAborted()
  if (failed || outcome?.exitCode !== 0) throw new Error('Git could not enumerate ignored files')
  const listing = output.strictStdout()
  if (listing === undefined) throw new Error('ignored file listing exceeds maxOutputBytes; narrow copyIgnored')
  return listing
}

/**
 * Resolve and start a command with no changes to the Session's sandbox authority.
 * @param ctx - subprocess and sandbox providers.
 * @param policy - calling Session policy.
 * @param argv - executable followed by literal arguments.
 * @param spec - complete launch spec except resolved argv; cancellation covers executable lookup.
 * @param options - optional executable lookup overrides or explicit trusted runner resolution.
 * @returns the caller-owned process handle and the provider's runner failure rules.
 */
export async function spawnConfined(
  ctx: Context,
  policy: SandboxExecutionPolicy,
  argv: readonly [string, ...string[]],
  spec: Omit<SubprocessSpawnSpec, 'argv'> & { signal: AbortSignal },
  options?: { lookupEnv?: Readonly<Record<string, string>>; resolveRunner?: true },
): Promise<{ child: SubprocessHandle; runnerFailureRules: readonly RunnerFailureRule[] }> {
  spec.signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable(argv[0], options?.lookupEnv, spec.signal)
  const command = [program, ...argv.slice(1)]
  const confinement = policy.mode === 'danger-full-access'
    ? undefined
    : await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, spec.signal)
  let wrapped = confinement?.argv ?? command
  if (confinement !== undefined && options?.resolveRunner === true) {
    const [executable, ...args] = wrapped
    if (executable === undefined) throw new Error('worktree: command has no executable')
    const runner = await ctx.subprocess.resolveExecutable(executable, undefined, spec.signal)
    wrapped = [runner, ...args]
  }
  spec.signal.throwIfAborted()
  return { child: ctx.subprocess.spawn({ argv: wrapped, ...spec }), runnerFailureRules: confinement?.runnerFailureRules ?? [] }
}
