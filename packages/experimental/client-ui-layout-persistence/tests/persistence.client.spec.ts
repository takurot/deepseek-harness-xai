// @vitest-environment jsdom

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, FRAME_LAYOUT_STORAGE_KEY, inject } from '../src/client/index.ts'
import type { LayoutPersistenceSettings } from '../src/settings.ts'

interface Geometry { sidebar: number; rightbar: number | null }

const owners = new Set<Fiber>()

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(async () => {
  for (const owner of owners) await owner.dispose()
  owners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function bench(
  settings: Partial<LayoutPersistenceSettings> | 'loading' = {},
  restoreImpl: (geometry: Geometry, store: { set: (value: Geometry) => void }) => void = (requested, store) => { store.set(requested) },
) {
  const geometry = createSnapshotStore<Geometry>({ sidebar: 280, rightbar: null })
  const restoreFrameGeometry = vi.fn((requested: Geometry) => { restoreImpl(requested, geometry) })
  const form = stubConfigForm<LayoutPersistenceSettings>()
  const publish = (value: Partial<LayoutPersistenceSettings>): void => {
    form.publish({
      status: 'ready',
      value: { framePersistence: 'local', minPaneWidth: 264, ...value },
    })
  }
  if (settings !== 'loading') publish(settings)
  const root = new Context()
  const warn = vi.spyOn(root.logger, 'warn').mockImplementation(() => {})
  root.provide('layout', { frameGeometry: geometry, restoreFrameGeometry } as never)
  root.provide('configForms', { get: () => form.scope } as never)
  const owner = root.plugin({ inject, apply })
  owners.add(owner)
  await owner.await()
  return { geometry, restoreFrameGeometry, form, publish, warn, owner }
}

const stored = (value: unknown): void => { localStorage.setItem(FRAME_LAYOUT_STORAGE_KEY, JSON.stringify(value)) }

describe('frame layout persistence', () => {
  it('restores a valid save once and floors widths at minPaneWidth', async () => {
    stored({ version: 1, sidebar: 200, rightbar: null })
    const { restoreFrameGeometry, warn } = await bench()
    expect(restoreFrameGeometry).toHaveBeenCalledTimes(1)
    expect(restoreFrameGeometry).toHaveBeenCalledWith({ sidebar: 264, rightbar: null })
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a closed sidebar closed and floors a saved right panel', async () => {
    stored({ version: 1, sidebar: 0, rightbar: 100 })
    const { restoreFrameGeometry } = await bench()
    expect(restoreFrameGeometry).toHaveBeenCalledWith({ sidebar: 0, rightbar: 264 })
  })

  it('waits for the settings to resolve before restoring', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const { restoreFrameGeometry, publish } = await bench('loading')
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    publish({})
    expect(restoreFrameGeometry).toHaveBeenCalledTimes(1)
    expect(restoreFrameGeometry).toHaveBeenCalledWith({ sidebar: 300, rightbar: 400 })
  })

  it('does nothing until a ready snapshot arrives, and not at all while off', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { restoreFrameGeometry, form, geometry, warn } = await bench('loading')
    form.publish({ status: 'unavailable' })
    expect(getItem).not.toHaveBeenCalled()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    form.publish({ status: 'ready', value: { framePersistence: 'off', minPaneWidth: 264 } })
    geometry.set({ sidebar: 350, rightbar: 450 })
    await vi.advanceTimersByTimeAsync(500)
    expect(getItem).not.toHaveBeenCalled()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does nothing when the form never resolves', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const { restoreFrameGeometry, geometry } = await bench('loading')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 350, rightbar: 450 })
    await vi.advanceTimersByTimeAsync(500)
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('writes the geometry the layout actually applied, not the requested one', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 700 })
    const { geometry } = await bench({}, (requested, store) => {
      store.set({ ...requested, rightbar: 560 })
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 300, rightbar: 560 })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).not.toHaveBeenCalled()
    geometry.set({ sidebar: 300, rightbar: 500 })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('debounces a drag into one versioned write', async () => {
    const { geometry } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    for (const sidebar of [300, 320, 340]) {
      geometry.set({ sidebar, rightbar: 500 })
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(FRAME_LAYOUT_STORAGE_KEY)!)).toEqual({ version: 1, sidebar: 340, rightbar: 500 })
  })

  it('does not rewrite the geometry it just restored', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const { geometry } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 300, rightbar: 400 })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['corrupt JSON', '{nope'],
    ['unknown version', JSON.stringify({ version: 2, sidebar: 300, rightbar: null })],
    ['non-numeric sidebar', JSON.stringify({ version: 1, sidebar: '300', rightbar: null })],
    ['negative sidebar', JSON.stringify({ version: 1, sidebar: -1, rightbar: null })],
    ['non-finite rightbar', '{"version":1,"sidebar":300,"rightbar":1e999}'],
    ['missing rightbar', JSON.stringify({ version: 1, sidebar: 300 })],
    ['non-object', '42'],
  ])('discards %s with one diagnostic and no restore', async (_name, raw) => {
    localStorage.setItem(FRAME_LAYOUT_STORAGE_KEY, raw)
    const { restoreFrameGeometry, warn } = await bench()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(localStorage.getItem(FRAME_LAYOUT_STORAGE_KEY)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('emits exactly one diagnostic when the invalid record cannot be removed either', async () => {
    localStorage.setItem(FRAME_LAYOUT_STORAGE_KEY, '{nope')
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('locked') })
    const { restoreFrameGeometry, warn } = await bench()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('cleanup failed: locked')
  })

  it("neither restores nor saves in 'off' mode", async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const { geometry, restoreFrameGeometry } = await bench({ framePersistence: 'off' })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 350, rightbar: 450 })
    await vi.advanceTimersByTimeAsync(500)
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it("stops saving, including a pending write, when the mode flips to 'off'", async () => {
    const { geometry, publish } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 350, rightbar: null })
    publish({ framePersistence: 'off' })
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).not.toHaveBeenCalled()
    geometry.set({ sidebar: 355, rightbar: null })
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).not.toHaveBeenCalled()
    publish({ framePersistence: 'local' })
    geometry.set({ sidebar: 360, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('reports a write failure once and keeps attempting later writes', async () => {
    const { geometry, warn } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    geometry.set({ sidebar: 300, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    geometry.set({ sidebar: 310, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('starts with one diagnostic when localStorage is missing', async () => {
    vi.stubGlobal('localStorage', undefined)
    const { geometry, restoreFrameGeometry, warn } = await bench()
    geometry.set({ sidebar: 300, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('starts with one diagnostic when reading localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const { restoreFrameGeometry, warn } = await bench()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed write and succeeds', async () => {
    const { geometry, warn } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    geometry.set({ sidebar: 300, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    geometry.set({ sidebar: 310, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(FRAME_LAYOUT_STORAGE_KEY)!).sidebar).toBe(310)
  })

  it('does not throw when storage disappears before a save', async () => {
    const { geometry, warn } = await bench()
    vi.stubGlobal('localStorage', undefined)
    geometry.set({ sidebar: 300, rightbar: null })
    await vi.advanceTimersByTimeAsync(300)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports once when the localStorage getter throws', async () => {
    vi.stubGlobal('localStorage', undefined)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
    const { restoreFrameGeometry, warn } = await bench()
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('starts saving without restoring when switched from off to local', async () => {
    stored({ version: 1, sidebar: 300, rightbar: 400 })
    const { geometry, publish, restoreFrameGeometry } = await bench({ framePersistence: 'off' })
    publish({ framePersistence: 'local' })
    expect(restoreFrameGeometry).not.toHaveBeenCalled()
    geometry.set({ sidebar: 320, rightbar: 400 })
    await vi.advanceTimersByTimeAsync(300)
    expect(JSON.parse(localStorage.getItem(FRAME_LAYOUT_STORAGE_KEY)!).sidebar).toBe(320)
  })

  it('releases its subscriptions and timer on dispose', async () => {
    const { geometry, form, owner } = await bench()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    geometry.set({ sidebar: 300, rightbar: null })
    await owner.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).not.toHaveBeenCalled()
    expect(form.listenerCount()).toBe(0)
  })
})
