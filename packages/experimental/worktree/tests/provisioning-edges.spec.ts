import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { RunnerFailureRule, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileProvisioningConfig } from '../src/file-provisioning.ts'
import { validateFileProvisioning, WorktreeFileProvisionError } from '../src/file-provisioning.ts'
import { BoundedPipes, settlePipes } from '../src/pipes.ts'
import { readGitListing, runCommand, spawnConfined } from '../src/process.ts'
import { runSetup } from '../src/setup.ts'
import { harness, repository, testAgent } from './harness.ts'

const limits = { timeoutMs: 30_000, graceMs: 10, maxOutputBytes: 1024 }
const open: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: '/work' }
const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/work' }
const exited = (exitCode: number): SubprocessOutcome => ({ exitCode, signal: null })

interface FakeChild {
  stdin?: Writable
  stdout?: Readable
  stderr?: Readable
  done?: Promise<SubprocessOutcome>
  waitForExit?: () => Promise<boolean>
}

/** A closed-stdin Writable: the first write fails the way a child that exited early does. */
function brokenStdin(): Writable {
  return new Writable({ write: (_chunk, _encoding, callback) => { callback(new Error('stdin closed')) } })
}

function handle(child: FakeChild): SubprocessHandle {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: undefined,
    collected: {},
    done: child.done ?? Promise.resolve(exited(0)),
    terminate: () => {},
    waitForExit: child.waitForExit ?? (async () => true),
  }
}

/** A rejected process promise that does not count as an unhandled rejection before the caller observes it. */
function lostProcess(): Promise<SubprocessOutcome> {
  const done = Promise.reject(new Error('process lost'))
  done.catch(() => {})
  return done
}

interface FakeProviders {
  spawned: Pick<SubprocessSpawnSpec, 'argv' | 'stdio'>[]
  ctx: never
}

function providers(
  child: () => SubprocessHandle,
  options: { argv?: string[]; rules?: readonly RunnerFailureRule[]; resolve?: (signal: AbortSignal) => Promise<string> } = {},
): FakeProviders {
  const spawned: FakeProviders['spawned'] = []
  const ctx = {
    subprocess: {
      resolveExecutable: async (file: string, _env: unknown, signal: AbortSignal) => options.resolve?.(signal) ?? file,
      spawn: (spec: SubprocessSpawnSpec) => { spawned.push({ argv: spec.argv, stdio: spec.stdio }); return child() },
    },
    sandbox: {
      confine: async (argv: readonly string[]) => ({ argv: options.argv ?? [...argv], runnerFailureRules: options.rules ?? [] }),
    },
  } as never
  return { spawned, ctx }
}

const signal = () => new AbortController().signal

describe('BoundedPipes', () => {
  it('ignores a pipe the provider never allocated', async () => {
    const pipes = new BoundedPipes(8)
    await pipes.drain(undefined, 'stdout')
    expect(pipes.read()).toEqual({ output: '', truncated: false })
  })

  it.each([
    { name: 'malformed input that cannot fit its replacement', bytes: [0xff, 0xff], text: '' },
    { name: 'a decoded prefix before the replacement that overflows', bytes: [0x61, 0x62, 0xff], text: 'ab' },
  ])('never reports more text than retained bytes for $name', async ({ bytes, text }) => {
    const pipes = new BoundedPipes(64)
    await pipes.drain(Readable.from([Buffer.from(bytes)]), 'stdout')
    expect(pipes.read()).toEqual({ output: text, truncated: true })
  })
})

describe('settlePipes', () => {
  it('rejects when the provider cannot observe the managed range', async () => {
    const child = handle({ waitForExit: () => Promise.reject(new Error('range unobservable')) })
    await expect(settlePipes(child, new BoundedPipes(8), signal())).rejects.toThrow('range unobservable')
  })
})

describe('process commands', () => {
  it('reports provisioning input that the child did not accept', async () => {
    const collected = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) }
    const child = { ...handle({ stdin: brokenStdin() }), collected: { stdout: collected, stderr: collected } }
    const { ctx } = providers(() => child)
    await expect(runCommand(ctx, limits, open, '/work', ['tool'], signal(), [0], {}, 'payload'))
      .rejects.toThrow('did not accept provisioning input')
  })

  it('fails a Git listing whose process exits nonzero', async () => {
    const { ctx } = providers(() => handle({ stdout: Readable.from([]), stderr: Readable.from([]), done: Promise.resolve(exited(1)) }))
    await expect(readGitListing(ctx, limits, open, '/work', ['git', 'ls-files'], signal()))
      .rejects.toThrow('Git could not enumerate ignored files')
  })

  it('rejects confinement that leaves no runner to resolve', async () => {
    const { ctx } = providers(() => handle({}), { argv: [] })
    await expect(spawnConfined(ctx, confined, ['tool'], { cwd: '/work', signal: signal(), graceMs: 10, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }, { resolveRunner: true }))
      .rejects.toThrow('command has no executable')
  })
})

describe('runSetup', () => {
  const silent = () => handle({ stdout: Readable.from([]), stderr: Readable.from([]) })
  const run = (ctx: never, policy: SandboxExecutionPolicy, command: string, env: Record<string, string> = {}, config = limits) =>
    runSetup(ctx, { ...config, nodeCommand: 'node' }, policy, '/work', command, env, signal())

  it('runs shell text through PowerShell on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { ctx, spawned } = providers(silent)
      await run(ctx, open, 'echo ready')
      expect(spawned[0]?.argv).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'echo ready'])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('reports a launch that failed after the setup deadline as timed out', async () => {
    const { ctx } = providers(silent, {
      resolve: abort => new Promise<string>((_resolve, reject) => { abort.addEventListener('abort', () => { reject(new Error('setup deadline')) }, { once: true }) }),
    })
    const result = await run(ctx, open, 'wait', {}, { ...limits, timeoutMs: 20 })
    expect(result).toMatchObject({ command: 'wait', status: 'timed-out', exitCode: null, signal: null })
  })

  it('does not trust a result when the target never received its environment', async () => {
    const { ctx } = providers(() => handle({ stdin: brokenStdin(), stdout: Readable.from([]), stderr: Readable.from([]) }))
    const result = await run(ctx, confined, 'tool', { KEY: 'value' })
    expect(result).toMatchObject({ status: 'unavailable', exitCode: null, signal: null })
  })

  it('reports no exit facts when the process is lost', async () => {
    const { ctx } = providers(() => handle({ stdout: Readable.from([]), stderr: Readable.from([]), done: lostProcess() }))
    const result = await run(ctx, open, 'tool')
    expect(result).toMatchObject({ status: 'unavailable', exitCode: null, signal: null })
  })

  it('does not trust a nonzero exit whose runner diagnostics were truncated', async () => {
    const stderr = new PassThrough()
    stderr.end('x'.repeat(64))
    const { ctx } = providers(
      () => handle({ stdout: Readable.from([]), stderr, done: Promise.resolve(exited(1)) }),
      { rules: [{ fatalSignatures: ['runner failed'] }] },
    )
    const result = await run(ctx, confined, 'tool', {}, { ...limits, maxOutputBytes: 8 })
    expect(result).toMatchObject({ status: 'unavailable', exitCode: null, signal: null, truncated: true })
  })
})

describe('file provisioning validation', () => {
  const config = (overrides: Partial<FileProvisioningConfig>): FileProvisioningConfig => ({
    ...limits, gitCommand: 'git', nodeCommand: 'node', directory: '.agents/worktrees',
    shareDirectories: [], copyIgnored: [], copyMode: 'copy', ...overrides,
  })

  it('reports a failure before checkout allocation without checkout guidance', () => {
    expect(new WorktreeFileProvisionError('share-validation', null, new Error('bad share')).message).toBe('bad share')
  })

  it('describes a non-Error cause', () => {
    expect(new WorktreeFileProvisionError('ignored-list', null, 'plain failure').message).toBe('plain failure')
  })

  it.each([
    { name: 'a relative shared directory', overrides: { shareDirectories: ['cache'] }, message: /shareDirectories requires absolute/ },
    { name: 'a Git metadata basename', overrides: { shareDirectories: ['/cache/.git'] }, message: /shareDirectories requires absolute/ },
    { name: 'duplicate basenames', overrides: { shareDirectories: ['/a/cache', '/b/CACHE'] }, message: /basenames must be unique/ },
    { name: 'a Windows separator in a glob', overrides: { copyIgnored: ['a\\b'] }, message: /copyIgnored requires root-relative/ },
    { name: 'a dot segment in a glob', overrides: { copyIgnored: ['a/../b'] }, message: /copyIgnored requires root-relative/ },
    { name: 'Git metadata in a glob', overrides: { copyIgnored: ['nested/.git/config'] }, message: /copyIgnored requires root-relative/ },
  ])('rejects $name', ({ overrides, message }) => {
    expect(() => { validateFileProvisioning(config(overrides)) }).toThrow(message)
  })
})

describe('ignored-file provisioning without shared directories', () => {
  let root: string | undefined
  let ctx: Context | undefined
  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it.skipIf(process.platform === 'win32')('reports only the copied ignored count', async () => {
    root = await repository()
    await writeFile(join(root, '.gitignore'), '*.bin\n')
    await writeFile(join(root, 'cache.bin'), 'cached')
    ctx = await harness(root, { copyIgnored: ['*.bin'] })
    const result = await ctx.worktrees.create(testAgent(ctx, root), { name: 'copy-only' })
    expect(result.copiedIgnored).toBe(1)
    expect(result).not.toHaveProperty('sharedDirectories')
  })
})

describe('service configuration', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it.each([
    { name: 'blank shell text', config: { setupCommand: '  ' } },
    { name: 'shell text with NUL', config: { setupCommand: 'echo\0' } },
    { name: 'argv with a blank executable', config: { setupCommand: [' ', 'arg'] as [string, ...string[]] } },
    { name: 'argv with NUL', config: { setupCommand: ['node', 'a\0'] as [string, ...string[]] } },
    { name: 'an empty setupEnv name', config: { setupEnv: { '': 'value' } } },
    { name: 'a setupEnv name containing =', config: { setupEnv: { 'A=B': 'value' } } },
    { name: 'a setupEnv value containing NUL', config: { setupEnv: { A: 'a\0' } } },
  ])('rejects $name', async ({ config }) => {
    root = await repository()
    await expect(harness(root, config)).rejects.toThrow(/setupCommand|setupEnv/)
  })
})
