/** Filesystem validation and bounded lifecycle of one service lock. */

import { constants, fstatSync } from 'node:fs'
import { chmod, lstat, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { withServiceLock } from '../src/service-lock.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
vi.mock('@deepseek-ai/node-addon-system/flock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return { ...actual, tryLockExclusive: vi.fn(actual.tryLockExclusive) }
})

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const realFlock = await vi.importActual<typeof import('@deepseek-ai/node-addon-system/flock')>('@deepseek-ai/node-addon-system/flock')
const cleanups: Array<() => Promise<void>> = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'keychain-service-lock-'))
  cleanups.push(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

function filename(path: string): string {
  return join(path, createHash('sha256').update('test').digest('hex') + '.lock')
}

function lock<T>(path: string, action: (fd: number) => Promise<T>, controller = new AbortController(), waitMs = 1000): Promise<T> {
  return withServiceLock(path, 'test', waitMs, controller.signal, action)
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockImplementation(realFs.open)
  vi.mocked(tryLockExclusive).mockImplementation(realFlock.tryLockExclusive)
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe.skipIf(process.platform === 'win32')('service lock', () => {
  it('keeps a private stable inode on success and failure', async () => {
    const path = await root()
    expect(await lock(path, async () => 42)).toBe(42)
    const first = await lstat(filename(path))
    await expect(lock(path, async () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
    expect((await lstat(filename(path))).ino).toBe(first.ino)
    expect(first.mode & 0o077).toBe(0)
  })

  it('rejects unsafe directory and file metadata before invoking the operation', async () => {
    const path = await root()
    const action = vi.fn(async () => {})
    await chmod(path, 0o755)
    await expect(lock(path, action)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_UNSAFE' })
    await chmod(path, 0o700)
    const link = join(await root(), 'linked')
    await symlink(path, link)
    await expect(lock(link, action)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_UNSAFE' })
    await writeFile(filename(path), '', { mode: 0o644 })
    await expect(lock(path, action)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_UNSAFE' })
    await chmod(filename(path), 0o600)
    const handle = await realFs.open(filename(path), constants.O_RDWR)
    const stat = await handle.stat()
    stat.uid = userInfo().uid + 1
    vi.spyOn(handle, 'stat').mockResolvedValue(stat)
    vi.mocked(open).mockResolvedValueOnce(handle)
    await expect(lock(path, action)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_UNSAFE' })
    expect(action).not.toHaveBeenCalled()
  })

  it('does not follow an existing lock-file symlink', async () => {
    const path = await root()
    const target = join(path, 'target')
    await writeFile(target, 'unchanged', { mode: 0o600 })
    await symlink(target, filename(path))
    await expect(lock(path, async () => {})).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await realFs.readFile(target, 'utf8')).toBe('unchanged')
  })

  it('times out a contender without running its callback or changing the holder', async () => {
    const path = await root()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const held = lock(path, async () => { entered.resolve(undefined); await release.promise })
    await entered.promise
    const action = vi.fn(async () => {})
    try {
      await expect(lock(path, action, new AbortController(), 40)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_TIMEOUT' })
      expect(action).not.toHaveBeenCalled()
    } finally { release.resolve(undefined); await held }
    await lock(path, async () => {})
  })

  it('cancels before acquisition and while a contended wait is pending', async () => {
    const path = await root()
    const controller = new AbortController()
    const action = vi.fn(async () => {})
    controller.abort(new Error('cancelled'))
    await expect(lock(path, action, controller)).rejects.toThrow('cancelled')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const held = lock(path, async () => { entered.resolve(undefined); await release.promise })
    await entered.promise
    const waiting = new AbortController()
    vi.mocked(tryLockExclusive).mockImplementation(async (fd) => {
      try { await realFlock.tryLockExclusive(fd) } catch (error) {
        waiting.abort(new Error('cancelled contender'))
        throw error
      }
    })
    try {
      await expect(lock(path, action, waiting)).rejects.toHaveProperty('cause.message', 'cancelled contender')
      expect(action).not.toHaveBeenCalled()
    } finally { release.resolve(undefined); await held }
  })

  it('keeps the descriptor open until an aborted native acquisition settles', async () => {
    const path = await root()
    const entered = Promise.withResolvers<number>()
    const release = Promise.withResolvers<undefined>()
    vi.mocked(tryLockExclusive).mockImplementation(async (fd) => {
      entered.resolve(fd)
      await release.promise
      await realFlock.tryLockExclusive(fd)
    })
    const controller = new AbortController()
    const action = vi.fn(async () => {})
    const pending = lock(path, action, controller)
    const fd = await entered.promise
    controller.abort(new Error('cancelled in native call'))
    expect(fstatSync(fd).isFile()).toBe(true)
    release.resolve(undefined)
    await expect(pending).rejects.toThrow('cancelled in native call')
    expect(() => fstatSync(fd)).toThrow()
    expect(action).not.toHaveBeenCalled()
  })

  it('does not run an operation after its acquisition deadline', async () => {
    const path = await root()
    const action = vi.fn(async () => {})
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(100)
    await expect(lock(path, action, new AbortController(), 50)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_TIMEOUT' })
    expect(action).not.toHaveBeenCalled()
  })

  it('propagates native errors and stops an expired contention retry', async () => {
    const path = await root()
    vi.mocked(tryLockExclusive).mockRejectedValueOnce(Object.assign(new Error('native failed'), { code: 'EIO' }))
    await expect(lock(path, async () => {})).rejects.toThrow('native failed')
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.mocked(tryLockExclusive).mockImplementationOnce(async () => {
      clock.mockReturnValue(100)
      throw Object.assign(new Error('contended'), { code: 'EWOULDBLOCK' })
    })
    await expect(lock(path, async () => {}, new AbortController(), 50)).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_TIMEOUT' })
  })
})
