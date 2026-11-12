/** Deterministic races at external spawn, stream and process-table callbacks. */
import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnRunner } from '../src/command-runner.ts'

const processTable = vi.hoisted(() => ({ status: 'S' }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: () => ['12345'], readFileSync: () => `12345 (fixture) ${processTable.status} 1 12345 1 0` }
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture(): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough; signals: NodeJS.Signals[]; stop: () => void } {
  vi.useFakeTimers()
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 12345 })
  child.stdin = new PassThrough()
  const stdout = child.stdout = new PassThrough()
  const stderr = child.stderr = new PassThrough()
  let live = true
  const signals: NodeJS.Signals[] = []
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid).toBe(-12345)
    if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (signal !== 0) {
      signals.push(signal as NodeJS.Signals)
      if (signal === 'SIGKILL') live = false
    }
    return true
  })
  vi.mocked(spawn).mockReturnValue(child)
  return { child, stdout, stderr, signals, stop: () => { live = false } }
}

describe('owned command callback races', () => {
  it('keeps first output failure through deadline, late data and leader close until group kill', async () => {
    const { child, stdout, stderr, signals } = fixture()
    const pending = spawnRunner('fixture', [], undefined, undefined, { timeoutMs: 100, killGraceMs: 200, outputLimitBytes: 1 })
    void pending.catch(() => {})
    stdout.emit('data', Buffer.from('a'))
    stderr.emit('data', Buffer.from('b'))
    stdout.emit('data', Buffer.from('PRIVATE_LATE_OUTPUT'))
    child.emit('exit', 0)
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(200)
    await expect(pending).rejects.toMatchObject({ reason: 'output-limit' })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles cancellation reentering during spawn before listener registration', async () => {
    const { child, signals, stop } = fixture()
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementation(() => { controller.abort(new Error('PRIVATE')); return child })
    const pending = spawnRunner('fixture', [], undefined, undefined, { signal: controller.signal })
    void pending.catch(() => {})
    stop()
    child.emit('close', 0)
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled', outcome: 'unknown' })
    expect(signals).toEqual(['SIGTERM'])
  })

  it('observes Linux zombie-only quiescence and contains a late child error after settlement', async () => {
    const { child, signals } = fixture()
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    processTable.status = 'S'
    const pending = spawnRunner('fixture', [])
    child.emit('exit', 0)
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(20)
    processTable.status = 'Z'
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toEqual({ code: 0, stdout: '', stderr: '' })
    child.emit('error', new Error('PRIVATE_LATE_ERROR'))
    expect(signals).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
