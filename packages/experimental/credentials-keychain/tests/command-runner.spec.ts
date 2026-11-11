/** Command budgets own all output bytes and descendant lifetimes. */

import { constants as bufferConstants } from 'node:buffer'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as realWait } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { spawnRunner } from '../src/backend.ts'
import { resolveCommandOptions } from '../src/command-runner.ts'

const fixture = fileURLToPath(new URL('./fixtures/bounded-command.mjs', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try { while (cleanups.length > 0) await cleanups.pop()!() } finally { vi.useRealTimers() }
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'keychain-budgets-'))
  cleanups.push(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

async function file(path: string): Promise<string> {
  for (;;) {
    try { return await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await realWait(5)
  }
}

async function expire(pending: Promise<unknown>, deadline: number, grace: number): Promise<void> {
  let done = false
  void pending.then(() => { done = true }, () => { done = true })
  await vi.advanceTimersByTimeAsync(deadline)
  await vi.advanceTimersByTimeAsync(grace)
  for (let count = 0; count < 200 && !done; count++) {
    await realWait(5)
    await vi.advanceTimersByTimeAsync(20)
  }
  expect(done).toBe(true)
}

function own(pending: Promise<unknown>, controller: AbortController): void {
  void pending.then(() => {}, () => {})
  cleanups.push(async () => {
    controller.abort()
    if (vi.isFakeTimers()) await expire(pending, 100_000, 100_000)
    await Promise.allSettled([pending])
  })
}

describe('bounded keychain command runner', () => {
  it('rejects combined output beyond its byte budget', async () => {
    await expect(spawnRunner(process.execPath, ['-e', 'process.stdout.write("123");process.stderr.write("456")'], undefined, undefined,
      { outputLimitBytes: 5 })).rejects.toMatchObject({ reason: 'output-limit', outcome: 'unknown' })
  })

  it.each([1, 6, 65536])('retains exactly %i bytes without treating an exact limit as overflow', async (limit) => {
    const result = await spawnRunner(process.execPath, ['-e', `process.stdout.write(Buffer.alloc(${String(limit)}, 120))`], undefined, undefined,
      { outputLimitBytes: limit })
    expect(Buffer.byteLength(result.stdout)).toBe(limit)
    expect(result.stderr).toBe('')
  })

  it('counts multibyte output and withholds secret output on nonzero exit', async () => {
    await expect(spawnRunner(process.execPath, ['-e', 'process.stdout.write("日本語")'], undefined, undefined,
      { outputLimitBytes: 8 })).rejects.toMatchObject({ reason: 'output-limit' })
    expect(await spawnRunner(process.execPath, ['-e', 'process.stdout.write("PRIVATE");process.stderr.write("PRIVATE");process.exitCode=2']))
      .toEqual({ code: 2, stdout: '', stderr: '!' })
  })

  it('rejects invalid budgets before starting a command', () => {
    for (const field of ['timeoutMs', 'killGraceMs', 'outputLimitBytes'] as const) {
      for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => resolveCommandOptions({ [field]: value })).toThrow(field)
      }
    }
    expect(() => resolveCommandOptions({ outputLimitBytes: bufferConstants.MAX_STRING_LENGTH + 1 })).toThrow('outputLimitBytes')
    expect(() => resolveCommandOptions({ timeoutMs: 2_147_483_648 })).toThrow('timeoutMs')
    expect(() => resolveCommandOptions({ killGraceMs: 2_147_483_648 })).toThrow('killGraceMs')
  })

  it('does not spawn after an already-aborted signal and sanitizes missing executable errors', async () => {
    const path = await root()
    const controller = new AbortController()
    controller.abort(new Error('PRIVATE_ABORT_REASON'))
    await expect(spawnRunner(process.execPath, [fixture, 'ignore-term', path], undefined, undefined,
      { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled', outcome: 'not-started' })
    expect(await readdir(path)).toEqual([])
    await expect(spawnRunner('PRIVATE_MISSING_EXECUTABLE', [])).rejects.toMatchObject({ reason: 'spawn', outcome: 'not-started' })
    await expect(spawnRunner('PRIVATE_MISSING_EXECUTABLE', [])).rejects.not.toThrow('PRIVATE')
    await expect(spawnRunner('PRIVATE\0EXECUTABLE', [])).rejects.toMatchObject({ reason: 'spawn', outcome: 'not-started' })
  })

  it('retains direct-child utility behavior when POSIX groups are unavailable', async () => {
    const path = await root()
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      const pending = spawnRunner(process.execPath, [fixture, 'term-zero', path], undefined, undefined,
        { timeoutMs: 1000, killGraceMs: 100, signal: controller.signal })
      own(pending, controller)
      await file(join(path, 'ready'))
      await expire(pending, 1000, 100)
      await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
    } finally { vi.unstubAllGlobals() }
  })

  it.skipIf(process.platform === 'win32').each(['term-zero', 'ignore-term'])(
    'preserves timeout after ready %s handler and waits for exit', async (mode) => {
      const path = await root()
      vi.useFakeTimers()
      const controller = new AbortController()
      const pending = spawnRunner(process.execPath, [fixture, mode, path], undefined, undefined,
        { timeoutMs: 1000, killGraceMs: 100, signal: controller.signal })
      own(pending, controller)
      const pid = Number(await file(join(path, 'ready')))
      await expire(pending, 1000, 100)
      await expect(pending).rejects.toMatchObject({ reason: 'timeout', outcome: 'unknown' })
      expect(() => process.kill(pid, 0)).toThrow()
    })

  it.skipIf(process.platform === 'win32')('cancels an active ready command without exposing abort reasons', async () => {
    const path = await root()
    const controller = new AbortController()
    const pending = spawnRunner(process.execPath, [fixture, 'term-zero', path], undefined, undefined,
      { signal: controller.signal, timeoutMs: 10_000 })
    own(pending, controller)
    await file(join(path, 'ready'))
    controller.abort(new Error('PRIVATE_ABORT_REASON'))
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    await expect(pending).rejects.not.toThrow('PRIVATE')
  })

  it.skipIf(process.platform === 'win32')('reaps an fd3-only descendant even when its leader exits before grace', async () => {
    const path = await root()
    const lock = await open(join(path, 'lock'), 'w+', 0o600)
    cleanups.push(async () => { await lock.close() })
    await tryLockExclusive(lock.fd)
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = spawnRunner(process.execPath, [fixture, 'group-leader', path], undefined, lock.fd,
      { timeoutMs: 1000, killGraceMs: 100, signal: controller.signal })
    own(pending, controller)
    await file(join(path, 'descendant'))
    await file(join(path, 'leader-exit'))
    await lock.close()
    const contender = await open(join(path, 'lock'), 'r+')
    try {
      await expect(tryLockExclusive(contender.fd)).rejects.toThrow(/^E(AGAIN|WOULDBLOCK):/)
      await expire(pending, 1000, 100)
      await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
      await tryLockExclusive(contender.fd)
    } finally { await contender.close() }
  })
})
