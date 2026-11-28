/** Runs a trusted setup command with caller-owned pipes and one shared byte budget. */

import { finished } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import { classifyRunnerFailure } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { BoundedPipes, settlePipes } from './pipes.ts'
import { spawnConfined } from './process.ts'
import type { ProcessConfig } from './process.ts'
import type { WorktreeProvision } from './types.ts'

const TARGET_START_FAILURE = 'worktree setup: target could not start'

// The sandbox runner inherits a trusted environment. Only this confined process
// translates the private stdin payload to environment overrides for the target.
const RUN_TARGET = `
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
try {
  const [file, ...args] = process.argv.slice(1);
  const env = JSON.parse(readFileSync(0, 'utf8'));
  const result = spawnSync(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status;
} catch (error) {
  console.error(${JSON.stringify(TARGET_START_FAILURE)});
  process.exitCode = 125;
}
`

/**
 * Attempt one configured setup command. Loss of managed-range observation rejects the create operation.
 * @param ctx - subprocess and sandbox providers.
 * @param limits - setup deadline, termination grace, shared retention limit, and trusted Node command.
 * @param policy - unchanged Session policy.
 * @param cwd - new checkout.
 * @param command - trusted shell text or literal executable and arguments.
 * @param env - setup-only overrides.
 * @param signal - create cancellation, which rejects rather than returning a setup result.
 * @returns bounded output and the direct command facts known after cleanup.
 */
export async function runSetup(
  ctx: Context,
  limits: ProcessConfig & { nodeCommand: string },
  policy: SandboxExecutionPolicy,
  cwd: string,
  command: string | readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<WorktreeProvision> {
  using timer = deadline(signal, limits.timeoutMs, 'WORKTREE_SETUP_TIMEOUT')
  const argv = typeof command !== 'string' ? command
    : process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] as const
      : ['sh', '-c', command] as const
  const display = typeof command === 'string' ? command : [...command]
  const output = new BoundedPipes(limits.maxOutputBytes)
  const mediated = policy.mode !== 'danger-full-access' && Object.keys(env).length > 0
  let launch: Awaited<ReturnType<typeof spawnConfined>>
  try {
    const target = mediated ? await ctx.subprocess.resolveExecutable(argv[0], env, timer.signal) : undefined
    const commandArgv = target === undefined ? argv
      : [limits.nodeCommand, '--input-type=module', '-e', RUN_TARGET, target, ...argv.slice(1)] as const
    launch = await spawnConfined(ctx, policy, commandArgv, {
      cwd, env: mediated ? undefined : env, signal: timer.signal, graceMs: limits.graceMs,
      stdio: { stdin: mediated ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }, mediated ? { resolveRunner: true } : { resolveRunner: true, lookupEnv: env })
  } catch (_error) {
    signal.throwIfAborted()
    const status = timeoutOf(timer.signal, 'WORKTREE_SETUP_TIMEOUT') === undefined ? 'unavailable' : 'timed-out'
    return { command: display, status, exitCode: null, signal: null, ...output.read() }
  }

  const { child, runnerFailureRules } = launch
  const stdin = child.stdin
  const sent = stdin === undefined ? undefined : finished(stdin, { cleanup: true }).then(() => true, () => false)
  const settlement = settlePipes(child, output, timer.signal)
  try {
    stdin?.end(JSON.stringify(env))
    const { outcome, failed } = await settlement
    signal.throwIfAborted()
    const exitCode = outcome?.exitCode ?? null
    const { text, truncated } = output.readStderr()
    const rules = mediated
      ? [...runnerFailureRules, { allowedExitCodes: [125], fatalSignatures: [TARGET_START_FAILURE] }]
      : runnerFailureRules
    const targetUnknown = (mediated && !(await sent))
      || classifyRunnerFailure(exitCode, text, rules) !== undefined
      || (exitCode !== 0 && truncated && rules.length > 0)
    const status = timeoutOf(timer.signal, 'WORKTREE_SETUP_TIMEOUT') !== undefined ? 'timed-out'
      : failed || targetUnknown ? 'unavailable' : 'exited'
    return {
      command: display, status,
      exitCode: targetUnknown ? null : exitCode,
      signal: targetUnknown ? null : outcome?.signal ?? null,
      ...output.read(),
    }
  } finally {
    stdin?.destroy()
    await sent
  }
}
