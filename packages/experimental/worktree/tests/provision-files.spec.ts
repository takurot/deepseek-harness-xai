import { createHash } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { contents, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
let parent: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (parent !== undefined) await rm(parent, { recursive: true, force: true })
  parent = undefined
})

async function repo(): Promise<string> {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'dsh-provision-')))
  return repository(parent)
}

async function hash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

it.skipIf(process.platform === 'win32').each(['copy', 'symlink'] as const)('provisions only selected ignored files (%s) and shares an outside directory', async (copyMode) => {
  const root = await repo()
  const shared = join(dirname(root), 'cache')
  await mkdir(shared)
  await writeFile(join(shared, 'visible'), 'external')
  await mkdir(join(root, 'local'))
  await writeFile(join(root, '.gitignore'), 'local/*.bin\n.env.local\ncollision.bin\ntracked.txt\n')
  await writeFile(join(root, 'local', 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  await writeFile(join(root, 'local', 'ordinary.txt'), 'untracked')
  await writeFile(join(root, '.env.local'), 'not selected')
  await writeFile(join(root, 'collision.bin'), 'do not replace tracked destination')
  await writeFile(join(root, 'tracked.txt'), 'uncommitted')
  await writeFile(join(root, 'local', 'cache-link.bin'), 'placeholder')
  await rm(join(root, 'local', 'cache-link.bin'))
  await symlink(join(shared, 'visible'), join(root, 'local', 'cache-link.bin'))
  // A selected old ignored path can be tracked in the chosen revision.
  await git(root, 'checkout', '-b', 'source-revision')
  await writeFile(join(root, 'collision.bin'), 'committed collision')
  await git(root, 'add', '-f', 'collision.bin')
  await git(root, 'commit', '-m', 'destination collision')
  await git(root, 'checkout', 'main')
  await writeFile(join(root, 'collision.bin'), 'ignored collision')
  ctx = await harness(root, {
    copyIgnored: ['local/**', 'tracked.txt', 'collision.bin'], copyMode, shareDirectories: [shared], maxOutputBytes: 512,
    setupCommand: [process.execPath, '-e', 'if (!require(\'node:fs\').existsSync(\'cache/visible\')) process.exitCode = 8'],
  })
  const spawned = vi.spyOn(ctx.subprocess, 'spawn')
  const agent = testAgent(ctx, root)
  const result = await ctx.worktrees.create(agent, { name: 'topic', from: 'source-revision' })
  expect(result).toMatchObject({ sharedDirectories: 1, copiedIgnored: 1, provision: { exitCode: 0 } })
  expect(await contents(join(result.path, 'cache', 'visible'))).toBe('external')
  expect((await lstat(join(result.path, 'cache'))).isSymbolicLink()).toBe(true)
  const large = join(result.path, 'local', 'large.bin')
  expect(await hash(large)).toBe(await hash(join(root, 'local', 'large.bin')))
  expect((await lstat(large)).isSymbolicLink()).toBe(copyMode === 'symlink')
  expect(await contents(join(result.path, 'collision.bin'))).toBe('committed collision')
  expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
  for (const path of ['local/ordinary.txt', '.env.local', 'local/cache-link.bin']) {
    await expect(access(join(result.path, path))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  const commands = spawned.mock.calls.map(([spec]) => spec.argv)
  expect(commands.filter(argv => argv.includes('ls-files'))).toHaveLength(1)
  expect(commands.findIndex(argv => argv.includes('ls-files'))).toBeGreaterThan(commands.findIndex(argv => argv.includes('reset')))
})

it.skipIf(process.platform === 'win32').each(['direct', 'alias', 'ancestor'] as const)('rejects a %s reference to the workspace before creating a branch', async (kind) => {
  const root = await repo()
  const inside = join(root, 'private')
  const alias = join(dirname(root), 'outside-link')
  await mkdir(inside)
  await symlink(inside, alias, 'dir')
  const target = kind === 'direct' ? inside : kind === 'alias' ? alias : dirname(root)
  ctx = await harness(root, { shareDirectories: [target] })
  const agent = testAgent(ctx, root)
  await expect(ctx.worktrees.create(agent, { name: 'topic' })).rejects.toThrow(/shareDirectories.*outside/i)
  expect(await git(root, 'branch', '--list', 'topic')).toBe('')
  expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  await expect(access(join(root, '.agents', 'worktrees', 'topic'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('refuses a symlink parent in the destination without touching its target or starting setup', async () => {
  const root = await repo()
  const outside = join(dirname(root), 'outside')
  await mkdir(outside)
  await symlink(outside, join(root, 'local'), 'dir')
  await git(root, 'checkout', '-b', 'with-symlink')
  await git(root, 'add', 'local')
  await git(root, 'commit', '-m', 'directory symlink')
  await git(root, 'checkout', 'main')
  await mkdir(join(root, 'local'))
  await writeFile(join(root, '.gitignore'), '*.bin\n')
  await writeFile(join(root, 'local', 'fixture.bin'), 'do not escape')
  ctx = await harness(root, { copyIgnored: ['local/**'], setupCommand: [process.execPath, '-e', 'require(\'node:fs\').writeFileSync(\'setup.marker\', \'ran\')'] })
  const agent = testAgent(ctx, root)
  await expect(ctx.worktrees.create(agent, { name: 'topic', from: 'with-symlink' })).rejects.toThrow(/retained.*symlink/i)
  await expect(access(join(outside, 'fixture.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(join(root, '.agents', 'worktrees', 'topic', 'setup.marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.workingDirectory.get(agent.session)).toBe(root)
})

it('refuses an over-cap ignored listing before provisioning any paths or starting setup', async () => {
  const root = await repo()
  await writeFile(join(root, '.gitignore'), '*.bin\n')
  for (let i = 0; i < 48; i++) await writeFile(join(root, `candidate-${i}.bin`), 'ignored')
  ctx = await harness(root, { copyIgnored: ['*.bin'], maxOutputBytes: 160, setupCommand: [process.execPath, '-e', 'require(\'node:fs\').writeFileSync(\'setup.marker\', \'ran\')'] })
  const agent = testAgent(ctx, root)
  await expect(ctx.worktrees.create(agent, { name: 'topic' })).rejects.toThrow(/ignored.*maxOutputBytes/i)
  const checkout = join(root, '.agents', 'worktrees', 'topic')
  expect(await contents(join(checkout, 'tracked.txt'))).toBe('initial\n')
  await expect(access(join(checkout, 'candidate-0.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(join(checkout, 'setup.marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.workingDirectory.get(agent.session)).toBe(root)
})

it('rejects a shared directory inside external Git metadata before allocation', async () => {
  const root = await repo()
  const external = await repository(dirname(root))
  ctx = await harness(root, { shareDirectories: [join(external, '.git', 'objects')] })
  const agent = testAgent(ctx, root)
  await expect(ctx.worktrees.create(agent, { name: 'topic' })).rejects.toMatchObject({ stage: 'share-validation', path: null })
  expect(await git(root, 'branch', '--list', 'topic')).toBe('')
})

it.each(['unterminated', 'invalid-utf8', 'outside'] as const)('refuses a malformed Git listing (%s) before copying its valid prefix', async (kind) => {
  const root = await repo()
  await writeFile(join(root, 'first.bin'), 'must not be copied')
  ctx = await harness(root, { copyIgnored: ['*.bin'] })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const suffix = kind === 'unterminated' ? "Buffer.from('last.bin')" : kind === 'invalid-utf8' ? 'Buffer.from([255, 0])' : "Buffer.from('../other.bin\\0')"
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec => spawn(spec.argv.includes('ls-files') ? {
    ...spec, argv: [process.execPath, '-e', `process.stdout.write(Buffer.concat([Buffer.from('first.bin\\0'), ${suffix}]))`],
  } : spec))
  const agent = testAgent(ctx, root)
  const checkout = join(root, '.agents', 'worktrees', 'topic')
  await expect(ctx.worktrees.create(agent, { name: 'topic' })).rejects.toMatchObject({ stage: 'ignored-list', path: checkout })
  expect(await contents(join(checkout, 'tracked.txt'))).toBe('initial\n')
  await expect(access(join(checkout, 'first.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.workingDirectory.get(agent.session)).toBe(root)
})
