import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

/** Read the plain values behind the volatile getters. */
const plain = (config: ReturnType<typeof Config>): unknown => ({
  framePersistence: config.framePersistence.get(),
  minPaneWidth: config.minPaneWidth.get(),
})

describe('frame layout persistence host entry', () => {
  it('defaults to local storage with a 264 px floor', () => {
    expect(plain(Config({}))).toEqual({ framePersistence: 'local', minPaneWidth: 264 })
  })

  it('accepts valid values and rejects unknown modes and negative floors', () => {
    expect(plain(Config({ framePersistence: 'off', minPaneWidth: 0 }))).toEqual({ framePersistence: 'off', minPaneWidth: 0 })
    expect(() => Config({ framePersistence: 'session' } as never)).toThrow()
    expect(() => Config({ minPaneWidth: -1 })).toThrow()
  })

  it('registers the settings presentation once the settings service is mounted', async () => {
    const root = new Context()
    const configure = vi.fn()
    const owner = root.plugin({ apply })
    await owner.await()
    expect(configure).not.toHaveBeenCalled()
    root.provide('settings', { configure } as never)
    await owner.await()
    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure.mock.calls[0]![0]).toEqual({ auto: false })
    expect(configure.mock.calls[0]![1]).toBeDefined()
    await owner.dispose()
  })
})
