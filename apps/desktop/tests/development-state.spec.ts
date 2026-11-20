/** Temporary Desktop worktrees exercise developer state migration and repository clean. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { RepositoryCleaner } from '../../../scripts/clean.ts'
import { prepareDevelopmentState } from '../scripts/development-state.ts'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'dsh-desktop-state-'))
  onTestFinished(() => { rmSync(repository, { recursive: true, force: true }) })
  const app = join(repository, 'apps', 'desktop')
  const build = join(app, '.desktop-build')
  const legacy = join(build, 'development')
  const state = join(app, '.desktop-dev')
  write(join(repository, 'tsconfig.json'), JSON.stringify({ files: ['stub.ts'] }))
  write(join(repository, 'stub.ts'), 'export {}')
  return { app, build, legacy, state, cleaner: new RepositoryCleaner(repository) }
}

function seedLegacy(legacy: string): void {
  write(join(legacy, 'home', 'session.jsonl'), 'legacy session')
  write(join(legacy, 'electron-user-data', 'Preferences'), 'legacy settings')
}

it('leaves fresh launch defaults outside clean and removes only the build project', async () => {
  const { app, build, legacy, state, cleaner } = fixture()
  const { home, userData } = prepareDevelopmentState(app, {})
  expect({ home, userData }).toEqual({ home: join(state, 'home'), userData: join(state, 'electron-user-data') })
  write(join(home, 'session.jsonl'), 'new session')
  write(join(userData, 'Preferences'), 'new settings')
  write(join(legacy, 'project', 'build.js'), 'build')

  await expect(cleaner.clean()).resolves.toEqual(['apps/desktop/.desktop-build'])
  expect(existsSync(build)).toBe(false)
  expect(readFileSync(join(home, 'session.jsonl'), 'utf8')).toBe('new session')
  expect(readFileSync(join(userData, 'Preferences'), 'utf8')).toBe('new settings')
})

it('migrates both legacy defaults on first launch, then preserves both across clean and relaunch', async () => {
  const { app, build, legacy, state, cleaner } = fixture()
  seedLegacy(legacy)
  write(join(legacy, 'project', 'build.js'), 'build')

  const paths = prepareDevelopmentState(app, {})
  expect(paths).toEqual({ home: join(state, 'home'), userData: join(state, 'electron-user-data') })
  expect(existsSync(join(legacy, 'home'))).toBe(false)
  expect(existsSync(join(legacy, 'electron-user-data'))).toBe(false)
  await cleaner.clean()
  expect(existsSync(build)).toBe(false)
  expect(readFileSync(join(paths.home, 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(readFileSync(join(paths.userData, 'Preferences'), 'utf8')).toBe('legacy settings')
  expect(prepareDevelopmentState(app, {})).toEqual(paths)
})

it.each(['home', 'electron-user-data'])('keeps existing %s and protects its legacy data from clean', async (existing) => {
  const { app, legacy, state, cleaner } = fixture()
  seedLegacy(legacy)
  write(join(state, existing, 'current'), 'keep current')

  prepareDevelopmentState(app, {})
  const other = existing === 'home' ? 'electron-user-data' : 'home'
  expect(existsSync(join(legacy, other))).toBe(false)
  expect(existsSync(join(state, other))).toBe(true)
  expect(readFileSync(join(state, existing, 'current'), 'utf8')).toBe('keep current')
  await expect(cleaner.clean()).rejects.toThrow('legacy Desktop development data')
  expect(existsSync(join(legacy, existing))).toBe(true)
})

it.each([
  ['DSH_HOME', 'home', 'electron-user-data'],
  ['DSH_DESKTOP_USER_DATA_DIR', 'electron-user-data', 'home'],
] as const)('uses %s independently of the other default', (variable, explicit, other) => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const paths = prepareDevelopmentState(app, { [variable]: 'relative-override' })

  const locations = { home: paths.home, 'electron-user-data': paths.userData }
  expect(locations[explicit]).toBe(resolve('relative-override'))
  expect(locations[other]).toBe(join(state, other))
  expect(existsSync(join(legacy, explicit))).toBe(true)
  expect(existsSync(join(legacy, other))).toBe(false)
})

it('preserves resolution of both explicit overrides without touching legacy paths', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const userData = join(app, 'custom-user-data')
  expect(prepareDevelopmentState(app, { DSH_HOME: '', DSH_DESKTOP_USER_DATA_DIR: userData }))
    .toEqual({ home: resolve(''), userData })
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(existsSync(join(legacy, 'electron-user-data'))).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it.each([
  ['DSH_HOME', 'electron-user-data'],
  ['DSH_DESKTOP_USER_DATA_DIR', 'home'],
] as const)('does not move a legacy ancestor of %s', (variable, source) => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  expect(() => prepareDevelopmentState(app, { [variable]: join(legacy, source, 'nested-override') }))
    .toThrow(variable)
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(existsSync(join(legacy, 'electron-user-data'))).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it('does not move legacy data reached through an explicit directory alias with a missing suffix', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const nested = join(legacy, 'home', 'nested')
  mkdirSync(nested)
  const alias = join(app, 'alias')
  symlinkSync(nested, alias, process.platform === 'win32' ? 'junction' : 'dir')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: join(alias, 'missing') }))
    .toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(readFileSync(join(legacy, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(alias)).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it('preserves an explicit override whose lookup passes through the legacy source', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const source = join(legacy, 'home')
  const external = join(app, 'external')
  mkdirSync(external)
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(external, join(source, 'outside'), dirLink)
  const alias = join(app, 'alias')
  symlinkSync(source, alias, dirLink)
  const override = join(alias, 'outside')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: override }))
    .toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(existsSync(override)).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it.each(['', 'missing'])('refuses a hidden legacy hop in an absolute link target (suffix: %j)', (suffix) => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const external = join(app, 'external')
  mkdirSync(external)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  const inside = join(legacy, 'home', 'outside')
  symlinkSync(external, inside, type)
  const alias = join(app, 'alias')
  symlinkSync(inside, alias, type)

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: join(alias, suffix) }))
    .toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(existsSync(alias)).toBe(true)
  expect(readFileSync(join(legacy, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(state)).toBe(false)
})

// Windows junction creation normalizes the target; POSIX symlinks retain the terminal separator.
it.skipIf(process.platform === 'win32').each(['absolute', 'relative'])('inspects the final link in a raw %s target ending in a slash', (kind) => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const external = join(app, 'external')
  const inside = join(legacy, 'home', 'outside')
  const route = join(app, 'route')
  const alias = join(app, 'alias')
  mkdirSync(external)
  symlinkSync(external, inside, 'dir')
  symlinkSync(inside, route, 'dir')
  symlinkSync(kind === 'absolute' ? `${route}/` : 'route/', alias, 'dir')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: alias })).toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(existsSync(alias)).toBe(true)
  expect(readFileSync(join(legacy, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(state)).toBe(false)
})

// Creating a relative directory link on Windows requires symlink privileges; the junction tests use absolute targets.
it.skipIf(process.platform === 'win32')('checks a relative link target from its actual containing directory', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const external = join(app, 'external')
  mkdirSync(external)
  symlinkSync(external, join(legacy, 'home', 'outside'), 'dir')
  symlinkSync('.desktop-build/development/home/outside', join(app, 'alias'), 'dir')
  const appAlias = join(dirname(app), 'app-alias')
  symlinkSync(app, appAlias, 'dir')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: join(appAlias, 'alias') }))
    .toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(existsSync(join(appAlias, 'alias'))).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it.skipIf(process.platform === 'win32')('refuses a raw parent component before normalizing a link target', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const external = join(app, 'external')
  mkdirSync(join(external, 'child'), { recursive: true })
  symlinkSync(join(external, 'child'), join(legacy, 'home', 'outside'), 'dir')
  const alias = join(app, 'alias')
  symlinkSync('.desktop-build/development/home/outside/..', alias, 'dir')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: alias })).toThrow('cannot check DSH_DESKTOP_USER_DATA_DIR')
  expect(existsSync(alias)).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it('refuses a directory alias cycle without moving legacy data', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const alias = join(app, 'alias')
  symlinkSync(alias, alias, process.platform === 'win32' ? 'junction' : 'dir')

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: alias })).toThrow('cannot check DSH_DESKTOP_USER_DATA_DIR')
  expect(readFileSync(join(legacy, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(state)).toBe(false)
})

it('keeps an unrelated explicit directory alias and migrates the other default', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const external = join(app, 'external')
  mkdirSync(external)
  const alias = join(app, 'alias')
  symlinkSync(external, alias, process.platform === 'win32' ? 'junction' : 'dir')

  expect(prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: alias })).toEqual({ home: join(state, 'home'), userData: alias })
  expect(readFileSync(join(state, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(alias)).toBe(true)
})

it('does not move legacy data reached through a case alias on a case-insensitive volume', (context) => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const alias = join(legacy, 'HOME')
  if (!existsSync(alias)) context.skip()

  expect(() => prepareDevelopmentState(app, { DSH_DESKTOP_USER_DATA_DIR: join(alias, 'missing') }))
    .toThrow('DSH_DESKTOP_USER_DATA_DIR')
  expect(readFileSync(join(legacy, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(existsSync(state)).toBe(false)
})

it('does not move either legacy directory while Electron owns the profile', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const profile = join(legacy, 'electron-user-data')
  if (process.platform === 'win32') writeFileSync(join(profile, 'lockfile'), '')
  else symlinkSync(`${hostname()}-${String(process.pid)}`, join(profile, 'SingletonLock'))

  expect(() => prepareDevelopmentState(app, {})).toThrow('legacy Electron profile')
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(existsSync(profile)).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it.skipIf(process.platform === 'win32')('leaves data alone when POSIX profile ownership cannot be verified', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  write(join(legacy, 'electron-user-data', 'SingletonLock'), 'not a Chromium symlink')
  expect(() => prepareDevelopmentState(app, {})).toThrow('legacy Electron profile')
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(existsSync(state)).toBe(false)
})

// PID 2^31-1 is above the supported POSIX kernels' PID limits.
it.skipIf(process.platform === 'win32')('migrates a profile with a stale local POSIX lock', () => {
  const { app, legacy } = fixture()
  seedLegacy(legacy)
  symlinkSync(`${hostname()}-2147483647`, join(legacy, 'electron-user-data', 'SingletonLock'))
  const { userData } = prepareDevelopmentState(app, {})
  expect(readFileSync(join(userData, 'Preferences'), 'utf8')).toBe('legacy settings')
})

it('refuses a default state root linked back into the build tree', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  symlinkSync(legacy, state, process.platform === 'win32' ? 'junction' : 'dir')

  expect(() => prepareDevelopmentState(app, {})).toThrow('not a real directory')
  expect(existsSync(join(legacy, 'home'))).toBe(true)
})

it('refuses a linked legacy data directory without moving any data', async () => {
  const { app, legacy, state, cleaner } = fixture()
  seedLegacy(legacy)
  const linked = join(legacy, 'electron-user-data')
  rmSync(linked, { recursive: true })
  symlinkSync(join(app, 'missing'), linked, process.platform === 'win32' ? 'junction' : 'dir')

  expect(() => prepareDevelopmentState(app, {})).toThrow('not a real directory')
  await expect(cleaner.clean()).rejects.toThrow('legacy Desktop development data')
  expect(existsSync(join(legacy, 'home'))).toBe(true)
  expect(lstatSync(linked).isSymbolicLink()).toBe(true)
  expect(existsSync(state)).toBe(false)
})

it('accepts another migration completing the same rename first', async () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementationOnce((source, target) => {
    fs.renameSync(source, target)
    fs.renameSync(source, target)
  })
  onTestFinished(() => { vi.mocked(renameSync).mockReset() })

  expect(prepareDevelopmentState(app, {})).toEqual({ home: join(state, 'home'), userData: join(state, 'electron-user-data') })
  expect(readFileSync(join(state, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(readFileSync(join(state, 'electron-user-data', 'Preferences'), 'utf8')).toBe('legacy settings')
})

it('rejects a missing-source race without a valid destination', () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  vi.mocked(renameSync).mockImplementationOnce((source) => {
    rmSync(source, { recursive: true })
    throw Object.assign(new Error('source disappeared'), { code: 'ENOENT' })
  })
  onTestFinished(() => { vi.mocked(renameSync).mockReset() })

  expect(() => prepareDevelopmentState(app, {})).toThrow('source disappeared')
  expect(existsSync(join(state, 'home'))).toBe(false)
  expect(readFileSync(join(legacy, 'electron-user-data', 'Preferences'), 'utf8')).toBe('legacy settings')
})

it('reports a later failed rename without discarding migrated or legacy data', async () => {
  const { app, legacy, state } = fixture()
  seedLegacy(legacy)
  const error = Object.assign(new Error('mount boundary'), { code: 'EXDEV' })
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementationOnce(fs.renameSync).mockImplementationOnce(() => { throw error })
  onTestFinished(() => { vi.mocked(renameSync).mockReset() })

  expect(() => prepareDevelopmentState(app, {})).toThrow('cannot move')
  expect(readFileSync(join(state, 'home', 'session.jsonl'), 'utf8')).toBe('legacy session')
  expect(readFileSync(join(legacy, 'electron-user-data', 'Preferences'), 'utf8')).toBe('legacy settings')
})
