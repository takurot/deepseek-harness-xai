/** Creates a new Git branch and checkout, then changes the calling Session's working directory; restores a removed checkout. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PREPARE_DIRECTORY } from './directory.ts'
import { checkShares, provisionFiles, validateFileProvisioning, WorktreeFileProvisionError } from './file-provisioning.ts'
import type { FileProvisioningConfig } from './file-provisioning.ts'
import { generatedWorktreeName } from './name.ts'
import { runCommand } from './process.ts'
import { runSetup } from './setup.ts'
import type { CreatedWorktree, CreateWorktreePhase, CreateWorktreeRequest, RestoredWorktree, RestoreWorktreeRequest } from './types.ts'

export type { CreatedWorktree, CreateWorktreePhase, CreateWorktreeRequest, RestoredWorktree, RestoreWorktreeRequest, WorktreeProvision } from './types.ts'
export { WorktreeFileProvisionError } from './file-provisioning.ts'
export { generatedWorktreeName } from './name.ts'

/** Worktree location, generated names, executables, and subprocess resource limits. */
export interface Config {
  /** Relative checkout pool inside the source repository. */
  directory?: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix?: string
  /** Executable name or absolute execution-world path of a Git release that honors `GIT_NO_LAZY_FETCH`. */
  gitCommand?: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand?: string
  /** Deadline in milliseconds for one command. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per Git stream, or total across both setup streams. */
  maxOutputBytes?: number
  /** Trusted noninteractive shell command or literal argv to run after checkout. */
  setupCommand?: string | string[]
  /** Setup deadline in milliseconds, including command startup. */
  setupTimeoutMs?: number
  /** Environment overrides applied to the setup process only. */
  setupEnv?: Record<string, string>
  /** Existing outside directories to link by basename. */
  shareDirectories?: string[]
  /** Source-checkout-relative Git glob pathspecs for ignored regular files. */
  copyIgnored?: string[]
  /** Provision selected ignored files by exclusive copy or source symlink. */
  copyMode?: 'copy' | 'symlink'
}

type ResolvedConfig = Required<Omit<Config, 'setupCommand'>> & FileProvisioningConfig & { setupCommand?: string | [string, ...string[]] }

interface WorktreeSpec {
  branch: string
  revision: string
  setup: boolean
}

/** Runs one confined Git command; output with an exit code outside `allowedExitCodes` throws. */
type GitRun = (directory: string, args: string[], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => ReturnType<typeof runCommand>

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Reject path traversal independently of Git's branch-name grammar. */
function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Creates retained Git worktrees under the mounted filesystem and sandbox providers. */
export class WorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    directory: z.string().default('.agents/worktrees'),
    namePrefix: z.string().default('dsh-'),
    gitCommand: z.string().default('git'),
    nodeCommand: z.string().default('node'),
    timeoutMs: z.number().default(60_000),
    graceMs: z.number().default(3_000),
    maxOutputBytes: z.number().default(65_536),
    setupCommand: z.union([z.string(), z.array(z.string())]),
    setupTimeoutMs: z.number().default(120_000),
    setupEnv: z.dict(z.string()).default({}),
    shareDirectories: z.array(z.string()).default([]),
    copyIgnored: z.array(z.string()).default([]),
    copyMode: z.union([z.const('copy'), z.const('symlink')]).default('copy'),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = config as ResolvedConfig
    if (!relativePath(this.config.directory)) throw new Error('worktree: directory must be a relative directory without dot segments')
    if (!relativePath(`${this.config.namePrefix}name`) || this.config.namePrefix.startsWith('-')) {
      throw new Error('worktree: namePrefix must produce a relative branch name')
    }
    for (const key of ['gitCommand', 'nodeCommand'] as const) {
      if (this.config[key].trim().length === 0) throw new Error(`worktree: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes', 'setupTimeoutMs'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`worktree: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    const command = this.config.setupCommand
    if (typeof command === 'string' ? command.trim().length === 0 || command.includes('\0')
      : command !== undefined && (!command[0].trim() || command.some(arg => arg.includes('\0')))) {
      throw new Error('worktree: setupCommand must be nonempty shell text or argv with a nonempty executable and no NUL bytes')
    }
    for (const [key, value] of Object.entries(this.config.setupEnv)) {
      if (key.length === 0 || /[=\0]/.test(key) || value.includes('\0')) throw new Error('worktree: invalid setupEnv entry')
    }
    validateFileProvisioning(this.config)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('worktree service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /**
   * Create a fresh branch and checkout at a pinned local revision, then enter it.
   * Existing branches or checkout paths fail. Only configured ignored files are provisioned.
   * Checkout disables configured clean, smudge, and process filters without changing Git config.
   * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
   * Publishes the new directory after checkout and configured provisioning. A command failure is
   * returned with the retained checkout. Cancellation or file provisioning failure rejects without
   * publishing the directory and may leave a branch and partial checkout.
   * @param agent - caller whose current directory selects the source repository and file policy.
   * @param request - optional name, revision, and setup opt-out; defaults are generated name, HEAD, and enabled setup.
   * @param signal - cancellation of lookup, creation, and working-directory publication.
   * @param onPhase - receives each stage before it begins; it must not throw.
   * @returns checkout identity, any file counts, and any setup outcome.
   */
  async create(
    agent: Agent,
    request: CreateWorktreeRequest = {},
    signal?: AbortSignal,
    onPhase?: (phase: CreateWorktreePhase) => void,
  ): Promise<CreatedWorktree> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.createCheckout(agent, this.resolve(agent, request), operationSignal, onPhase)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /**
   * Check out a removed worktree again at its recorded directory: its branch
   * when the branch still exists, otherwise a new branch of the same name at
   * `baseCommit`. Only the missing target's unlocked registration is removed, and an
   * existing directory fails. Changes that were never committed are not
   * recovered. Checkout disables configured clean, smudge, and process filters,
   * as creation does. Restoration does not provision files, run setup, or change the Session directory.
   * Failures may retain newly allocated Git/filesystem artifacts.
   * @param agent - caller whose sandbox policy confines the commands.
   * @param request - recorded directory, branch, base commit, and source repository root.
   * @param signal - cancellation of the restoration.
   * @param onPhase - receives each stage before it begins; it must not throw.
   * @returns the directory and whether the branch was created again.
   */
  async restore(
    agent: Agent,
    request: RestoreWorktreeRequest,
    signal?: AbortSignal,
    onPhase?: (phase: Exclude<CreateWorktreePhase, 'provision'>) => void,
  ): Promise<RestoredWorktree> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.restoreCheckout(agent, request, operationSignal, onPhase)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  private resolve(agent: Agent, request: CreateWorktreeRequest): WorktreeSpec {
    const branch = request.name ?? generatedWorktreeName(this.config.namePrefix, agent.session.id)
    if (!relativePath(branch) || branch.startsWith('-')) throw new Error('worktree name must be a relative Git branch name')
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new Error('worktree from must name a local commit, branch, or tag')
    return { branch, revision, setup: request.setup !== false }
  }

  private async createCheckout(
    agent: Agent,
    { branch, revision, setup }: WorktreeSpec,
    signal: AbortSignal,
    onPhase: ((phase: CreateWorktreePhase) => void) | undefined,
  ): Promise<CreatedWorktree> {
    onPhase?.('prepare')
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = this.gitRunner(policy, signal)
    await run(cwd, ['check-ref-format', `refs/heads/${branch}`])
    const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
    const rootTarget = await this.ctx.fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
    const repositoryRoot = this.ctx.fs.processPath(rootTarget)
    const base = await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])
    const baseCommit = base.stdout.trim()
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    if (existing.exitCode === 0) throw new Error(`worktree branch already exists: ${branch}`)
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const poolPath = this.ctx.fs.processPath(pool)
    const destination = await this.ctx.fs.resolve(branch, { cwd: poolPath, signal })
    const path = this.ctx.fs.processPath(destination)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
    const files = this.config.shareDirectories.length > 0 || this.config.copyIgnored.length > 0
      ? { ctx: this.ctx, config: this.config, policy, source: repositoryRoot, checkout: path, signal } : undefined
    if (files !== undefined && this.config.shareDirectories.length > 0) await checkShares(files)
    try {
      await this.prepareDirectory(policy, repositoryRoot, poolPath, path, signal)
      await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
      const overrides = await filterOverrides(run, path)
      onPhase?.('checkout')
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, overrides)
      const provisionedFiles = files === undefined ? undefined : await provisionFiles(files)
      const command = setup ? this.config.setupCommand : undefined
      let provision
      if (command !== undefined) {
        onPhase?.('provision')
        provision = await runSetup(
          this.ctx,
          { ...this.config, timeoutMs: this.config.setupTimeoutMs },
          policy,
          path,
          command,
          this.config.setupEnv,
          signal,
        )
      }
      const canonicalPath = await this.ctx.workingDirectory.set(agent, path, signal)
      return {
        path: canonicalPath, branch, baseCommit, repositoryRoot, ...provisionedFiles,
        ...provision === undefined ? {} : { provision },
      }
    } catch (error) {
      if (error instanceof WorktreeFileProvisionError) throw error
      throw new Error(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private async restoreCheckout(
    agent: Agent,
    { path, branch, baseCommit, repositoryRoot }: RestoreWorktreeRequest,
    signal: AbortSignal,
    onPhase: ((phase: Exclude<CreateWorktreePhase, 'provision'>) => void) | undefined,
  ): Promise<RestoredWorktree> {
    onPhase?.('prepare')
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = this.gitRunner(policy, signal)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
    const root = await this.ctx.fs.resolve(repositoryRoot, { signal })
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const target = await this.ctx.fs.resolve(path, { cwd: repositoryRoot, signal })
    if (this.ctx.fs.processPath(root) !== repositoryRoot || this.ctx.fs.processPath(target) !== path
      || !this.ctx.fs.contains(root, pool) || !this.ctx.fs.contains(pool, target) || pool.targetKey === target.targetKey) {
      throw new Error('worktree restoration must use a canonical directory inside the configured pool')
    }
    if (!relativePath(branch) || branch.startsWith('-')) throw new Error('worktree branch must be a relative Git branch name')
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(baseCommit)) throw new Error('worktree baseCommit must be a full commit object name')
    await run(repositoryRoot, ['check-ref-format', `refs/heads/${branch}`])
    const top = await run(repositoryRoot, ['rev-parse', '--show-toplevel'])
    const actualRoot = await this.ctx.fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: repositoryRoot, signal })
    if (actualRoot.targetKey !== root.targetKey) throw new Error('worktree repositoryRoot must be the source checkout root')
    await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${baseCommit}^{commit}`])
    const registered = await run(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
    for (const entry of registered.stdout.split('\0\0')) {
      const fields = entry.split('\0')
      const recordedPath = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
      if (recordedPath === undefined) continue
      const recorded = await this.ctx.fs.resolve(recordedPath, { cwd: repositoryRoot, signal })
      if (recorded.targetKey !== target.targetKey) continue
      if (fields.some(field => field === 'locked' || field.startsWith('locked '))) throw new Error(`worktree is locked: ${path}`)
      if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
      await run(repositoryRoot, ['worktree', 'remove', '--', path])
    }
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    const branchRecreated = existing.exitCode !== 0
    try {
      await this.prepareDirectory(policy, repositoryRoot, this.ctx.fs.processPath(pool), path, signal)
      await run(repositoryRoot, [
        '--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout',
        ...branchRecreated ? ['-b', branch, '--', path, baseCommit] : ['--', path, branch],
      ])
      const overrides = await filterOverrides(run, path)
      onPhase?.('checkout')
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', 'HEAD'], undefined, overrides)
      return { path, branchRecreated }
    } catch (error) {
      throw new Error(`Could not restore worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  /** Confine Git commands to the caller's sandbox policy, with hooks and the filesystem monitor disabled. */
  private gitRunner(policy: SandboxExecutionPolicy, signal: AbortSignal): GitRun {
    return (directory, args, allowedExitCodes, env) => runCommand(
      this.ctx, this.config, policy, directory,
      [this.config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      signal, allowedExitCodes, env,
    )
  }

  /** Allocate the checkout directory exclusively inside the pool, creating a self-ignoring pool when it is new. */
  private async prepareDirectory(
    policy: SandboxExecutionPolicy,
    repositoryRoot: string,
    poolPath: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    await runCommand(this.ctx, this.config, policy, repositoryRoot,
      [this.config.nodeCommand, '--input-type=module', '-e', PREPARE_DIRECTORY, poolPath, path], signal)
  }
}

/**
 * Build the environment that disables every configured clean, smudge, and
 * process filter of the checkout for one command, without changing Git config.
 * @param run - confined Git runner.
 * @param path - checkout directory.
 * @returns `GIT_CONFIG_*` overrides.
 */
async function filterOverrides(run: GitRun, path: string): Promise<NodeJS.ProcessEnv> {
  const configured = await run(path, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])
  const drivers = new Set<string>()
  for (const key of configured.stdout.split('\0')) {
    const separator = key.lastIndexOf('.')
    if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
      drivers.add(key.slice('filter.'.length, separator))
    }
  }
  const overrides: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
  let index = 0
  for (const driver of drivers) {
    for (const attribute of ['clean', 'smudge', 'process', 'required']) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
      index++
    }
  }
  return overrides
}

export default WorktreeService
