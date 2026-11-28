import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import WorktreeService from '../src/index.ts'
import { contents, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it.each([
  { script: 'process.stderr.write("failed"); process.exitCode = 7', bytes: 128, output: 'failed', truncated: false, exitCode: 7 },
  { script: 'process.stdout.write("x".repeat(128));', bytes: 128, output: 'x'.repeat(128), truncated: false, exitCode: 0 },
  { script: 'process.stdout.write("x".repeat(125) + "😀");', bytes: 128, output: 'x'.repeat(125), truncated: true, exitCode: 0 },
  { script: 'process.stdout.write(Buffer.alloc(65_536, 120)); process.stderr.write(Buffer.alloc(65_536, 121));', bytes: 128, output: /^[xy]{128}$/, truncated: true, exitCode: 0 },
])('retains the checkout and reports bounded output (cap $bytes)', async ({ script, bytes, output, truncated, exitCode }) => {
  root = await repository()
  const command = [process.execPath, '-e', script]
  ctx = await harness(root, { setupCommand: command, maxOutputBytes: bytes })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const agent = testAgent(ctx, root)
  const result = await ctx.worktrees.create(agent, { name: 'setup' })
  expect(result.provision).toMatchObject({ command, status: 'exited', exitCode, signal: null })
  expect(result.provision?.output).toEqual(typeof output === 'string' ? output : expect.stringMatching(output))
  expect(result.provision?.truncated).toBe(truncated)
  expect(await git(result.path, 'branch', '--show-current')).toBe('setup')
  expect(ctx.workingDirectory.get(agent.session)).toBe(result.path)
  const setupSpawns = spawn.mock.calls.filter(([spec]) => spec.argv.includes(script))
  expect(setupSpawns).toHaveLength(1)
  expect(setupSpawns[0]?.[0].stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
})

it('does not forward setupEnv to any other command or include it automatically in results', async () => {
  root = await repository()
  const sentinel = 'fixture-value-not-for-results'
  const key = 'DSH_SETUP_FIXTURE'
  const script = `if (!process.env.${key}) process.exitCode = 9; else console.log('ready')`
  ctx = await harness(root, { setupCommand: [process.execPath, '-e', script], setupEnv: { [key]: sentinel } })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const agent = testAgent(ctx, root)
  const original = process.env[key]
  const result = await ctx.worktrees.create(agent, { name: 'setup' })
  expect(result.provision).toMatchObject({ status: 'exited', exitCode: 0, output: 'ready\n' })
  expect(JSON.stringify(result)).not.toContain(sentinel)
  const forwarded = spawn.mock.calls.flatMap(([spec]) =>
    spec.env?.[key] === undefined ? [] : [[spec.argv[2], spec.env[key]]])
  expect(forwarded).toEqual([[script, sentinel]])
  expect(process.env[key]).toBe(original)
  await ctx.workingDirectory.set(agent, root)
  const skipPhases: string[] = []
  const skipped = await ctx.worktrees.create(agent, { name: 'skipped', setup: false }, undefined, (phase) => { skipPhases.push(phase) })
  expect(skipped).not.toHaveProperty('provision')
  expect(skipPhases).toEqual(['prepare', 'checkout'])
  await rm(result.path, { recursive: true })
  const restorePhases: string[] = []
  await ctx.worktrees.restore(agent, result, undefined, (phase) => { restorePhases.push(phase) })
  expect(restorePhases).toEqual(['prepare', 'checkout'])
  expect(spawn.mock.calls.filter(([spec]) => spec.env?.[key] !== undefined)).toHaveLength(1)
})

it('reports a missing setup executable without inventing an exit code or discarding the checkout', async () => {
  root = await repository()
  const command = [join(root, 'missing-worktree-setup')]
  ctx = await harness(root, { setupCommand: command, setupEnv: { DSH_SETUP_SECRET: 'opaque-fixture' } })
  const agent = testAgent(ctx, root)
  const result = await ctx.worktrees.create(agent, { name: 'setup' })
  expect(result.provision).toMatchObject({ command, status: 'unavailable', exitCode: null, signal: null, output: '', truncated: false })
  expect(JSON.stringify(result)).not.toContain('opaque-fixture')
  expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
  expect(ctx.workingDirectory.get(agent.session)).toBe(result.path)
})

it.each(['timeout', 'cancel', 'dispose'] as const)('settles both setup pipes and the managed range after %s', async (stop) => {
  root = await repository()
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); fs.writeFileSync('ready', String(process.pid)); setInterval(() => {}, 60_000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    process.stdout.write('stdout\\n'); process.stderr.write('stderr\\n'); child.unref();
    ${stop === 'timeout' ? '' : 'setInterval(() => {}, 60_000);'}
  `
  ctx = await harness(root, { setupCommand: [process.execPath, '-e', script], setupTimeoutMs: stop === 'timeout' ? 2_000 : 30_000, graceMs: 100 })
  const context = ctx
  const agent = testAgent(context, root)
  const run = context.subprocess.spawn.bind(context.subprocess)
  let setup: SubprocessHandle | undefined
  vi.spyOn(context.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = run(spec)
    if (spec.argv.includes(script)) setup = handle
    return handle
  })
  const signal = new AbortController()
  const checkout = join(root, '.agents', 'worktrees', 'setup')
  const pending = context.worktrees.create(agent, { name: 'setup' }, signal.signal)
  const observed = pending.catch((error: unknown) => error)
  try {
    await vi.waitFor(() => access(join(checkout, 'ready')), { timeout: 5_000 })
    if (stop === 'cancel') signal.abort(new Error('fixture cancellation'))
    if (stop === 'dispose') {
      const [fiber] = [...context.registry.get(WorktreeService)!.fibers]
      await fiber!.dispose()
    }
    if (stop === 'timeout') {
      const result = await pending
      expect(result.provision).toMatchObject({ status: 'timed-out', exitCode: 0, signal: null, output: 'stdout\nstderr\n' })
      expect(context.workingDirectory.get(agent.session)).toBe(checkout)
    } else {
      const failure = await observed
      expect(failure instanceof Error ? failure.message : String(failure))
        .toContain(stop === 'cancel' ? 'fixture cancellation' : 'worktree service disposed')
      expect(context.workingDirectory.get(agent.session)).toBe(root)
    }
    expect(setup?.stdout?.closed).toBe(true)
    expect(setup?.stderr?.closed).toBe(true)
    await expect(setup?.waitForExit(AbortSignal.timeout(100))).resolves.toBe(true)
    expect(await contents(join(checkout, 'tracked.txt'))).toBe('initial\n')
  } finally {
    signal.abort()
    await observed
  }
})

it('delivers setupEnv only inside the confined runner without exposing it in argv or output', async () => {
  root = await repository()
  const sentinel = 'worktree-private-fixture'
  const targetPath = join(root, 'target-path')
  const seesTargetPath = "require('node:path').basename(process.env.PATH ?? '') === 'target-path'"
  const target = `if (!process.env.DSH_SETUP_FIXTURE || !(${seesTargetPath})) process.exitCode = 8; else console.log('target has its environment')`
  const runner = `const fs = require('node:fs'); fs.writeFileSync('runner-env', JSON.stringify({ hasSentinel: !!process.env.DSH_SETUP_FIXTURE, targetPath: ${seesTargetPath} })); const [file, ...args] = process.argv.slice(1); process.exitCode = require('node:child_process').spawnSync(file, args, { stdio: 'inherit' }).status ?? 9`
  ctx = await harness(root, {
    setupCommand: [process.execPath, '-e', target], setupEnv: { DSH_SETUP_FIXTURE: sentinel, PATH: targetPath },
  }, 'workspace-write')
  vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => ({
    argv: argv.includes(target) ? [process.execPath, '-e', runner, ...argv] : [...argv],
    enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
  }))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const agent = testAgent(ctx, root)
  const created = await ctx.worktrees.create(agent, { name: 'setup' })
  expect(JSON.parse(await contents(join(created.path, 'runner-env')))).toEqual({ hasSentinel: false, targetPath: false })
  expect(created.provision).toMatchObject({ status: 'exited', exitCode: 0, output: 'target has its environment\n' })
  const launch = spawn.mock.calls.find(([spec]) => spec.argv.includes(runner))?.[0]
  expect(launch?.argv.join(' ')).not.toContain(sentinel)
  expect(launch?.argv.join(' ')).not.toContain(targetPath)
  expect(JSON.stringify(created)).not.toContain(sentinel)
  expect(JSON.stringify(created)).not.toContain(targetPath)
  expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
})

it.each([false, true])('distinguishes runner failure from a setup exit with the same code (runner fails: %s)', async (runnerFails) => {
  root = await repository()
  const script = "require('node:fs').writeFileSync('target.marker', 'ran'); console.error('target failed'); process.exitCode = 125"
  ctx = await harness(root, { setupCommand: [process.execPath, '-e', script] }, 'workspace-write')
  vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => ({
    argv: argv.includes(script) && runnerFails ? [process.execPath, '-e', "console.error('fixture runner: no target started'); process.exitCode = 125"] : [...argv],
    enforcement: 'full', denialSignatures: [], runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['fixture runner: no target started'] }],
  }))
  const agent = testAgent(ctx, root)
  const created = await ctx.worktrees.create(agent, { name: 'setup' })
  expect(created.provision).toMatchObject({ status: runnerFails ? 'unavailable' : 'exited', exitCode: runnerFails ? null : 125, signal: null })
  const marker = join(created.path, 'target.marker')
  if (runnerFails) await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await contents(marker)).toBe('ran')
  expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
  expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
})

it('runs configured shell text without a terminal in the new checkout', async () => {
  root = await repository()
  const command = process.platform === 'win32' ? '[Console]::Write((Get-Content tracked.txt))' : 'printf "%s" "$(cat tracked.txt)"'
  ctx = await harness(root, { setupCommand: command })
  const result = await ctx.worktrees.create(testAgent(ctx, root), { name: 'shell-setup' })
  expect(result.provision).toEqual({ command, status: 'exited', exitCode: 0, signal: null, output: 'initial', truncated: false })
})
