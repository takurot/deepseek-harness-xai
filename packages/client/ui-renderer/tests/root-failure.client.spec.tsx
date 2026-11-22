// @vitest-environment jsdom
/**
 * Top-level render-failure behavior: a crashed 'root' registration must leave
 * a user-visible explanation and recovery control instead of an empty page,
 * while the diagnostic record stays retrievable after the reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleFace } from '@deepseek-ai/dsh-client-ui-slots'

import { reloadPage, RootFailure } from '../src/client/RootFailure.tsx'
import { RootFailureBoundary } from '../src/client/scoped-slots.tsx'
import { SlotAssemblyError } from '../src/client/errors.ts'
import {
  collectRenderFailures, createRenderFailureRecord, readRenderFailures, recordRenderFailure,
  RENDER_FAILURE_RETENTION, RENDER_FAILURE_STORAGE_KEY,
} from '../src/client/render-failure-log.ts'
import { en, ja, RENDERER_DICTIONARIES, renderFailureTranslate } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

// Type-level declaration for the child slot this suite exercises.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'renderer.root.child': { kind: 'list'; scope: 'root' }
  }
}

/** One locale face over static dictionaries, mirroring the locale plugin's face. */
function fakeLocaleFace(dictionaries: Record<string, Record<string, string>>): LocaleFace {
  return {
    getSnapshot: () => ({ revision: 1 }),
    subscribe: () => () => {},
    bind: ns => (key, params) => {
      const template = dictionaries[ns]?.[key]
      if (template === undefined) return key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match)
    },
  }
}

/** A component that throws during render (outside any entry boundary). */
function Thrower({ error }: { error: unknown }): ReactNode {
  throw error
}

function sampleRecord(message = 'root render boom') {
  return createRenderFailureRecord(new Error(message), 'root', new Date('2026-11-22T00:00:00.000Z'))
}

let runtime: SlotTestRuntime | undefined

beforeEach(() => { window.localStorage.clear() })

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await runtime?.dispose()
  runtime = undefined
  window.localStorage.clear()
})

describe('root render failure fallback', () => {
  it('shows a recovery fallback instead of a blank page when the only root registration throws', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare({}, () => { throw new Error('root render boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()

    expect(view.container.querySelector('[data-slot-error="root"]')).toBeNull()
    expect(view.container.querySelector('[data-root-failure]')).not.toBeNull()
    expect(view.getByRole('alertdialog')).toBeTruthy()
    expect(view.getByRole('heading').textContent).toContain('stopped rendering')
    expect(view.getByRole('heading')).toBe(document.activeElement)
    expect(view.getByRole('button', { name: 'Reload' })).toBeTruthy()
    // The copy separates a browser render failure from a server disconnect.
    expect(view.container.textContent).toContain('not a server disconnect')
    expect(view.container.textContent).toContain('keeps running')
    expect(view.container.textContent).toContain('last three failures stay')
  })

  it('persists a bounded diagnostic that stays retrievable after the page reloads', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare({}, () => { throw new Error('root render boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    view.unmount()

    const stored = readRenderFailures()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.slot).toBe('root')
    expect(stored[0]?.message).toBe('root render boom')
    expect(stored[0]?.at).toBeTypeOf('string')
    expect(window.localStorage.getItem(RENDER_FAILURE_STORAGE_KEY)).not.toBeNull()
  })

  it('recovers the stored failures when a fresh root mount finds the dry path', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare({}, () => { throw new Error('remount boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = runtime.renderRoot()
    first.unmount()

    // A fresh RootOutlet has no in-hand error; the stored ring supplies it.
    const second = runtime.renderRoot()
    expect(second.container.querySelector('[data-root-failure]')).not.toBeNull()
    expect(second.container.textContent).toContain('remount boom')
    expect(second.container.textContent).toContain('last three failures stay')
  })

  it('renders the fallback in the installed locale and keeps English as the ladder', async () => {
    runtime = await SlotTestRuntime.create()
    runtime.slots.installLocale(fakeLocaleFace({ renderer: ja }))
    await runtime.root.declare({}, () => { throw new Error('root render boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()

    expect(view.getByRole('heading').textContent).toContain('画面の描画を続けられませんでした')
    expect(view.getByRole('button', { name: '再読み込み' })).toBeTruthy()
  })

  it('leaves a healthy root unchanged', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare({}, () => <b>healthy root</b>)
    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('healthy root')
    expect(view.container.querySelector('[data-root-failure]')).toBeNull()
    expect(readRenderFailures()).toHaveLength(0)
  })

  it('keeps a contained child crash out of the root failure screen', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare(
      { 'renderer.root.child': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => <main>{renderSlot('renderer.root.child', {})}</main>,
    )
    runtime.slots.register({ name: 'renderer.root.child', id: 'bad' }, () => { throw new Error('child boom') })
    runtime.slots.register({ name: 'renderer.root.child', id: 'ok' }, () => <b>alive child</b>)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()

    expect(view.container.textContent).toContain('alive child')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
    expect(view.container.querySelector('[data-root-failure]')).toBeNull()
  })

  it('shows the captured error without storage and tolerates a throwing localStorage', async () => {
    const getter = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('storage denied')
    })
    runtime = await SlotTestRuntime.create()
    await runtime.root.declare({}, () => { throw new Error('captured root boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()

    expect(getter).toHaveBeenCalled()
    expect(view.container.querySelector('[data-root-failure]')).not.toBeNull()
    expect(view.container.textContent).toContain('captured root boom')
    expect(view.container.textContent).toContain('shown from memory only')
    expect(view.container.textContent).not.toContain('last three failures stay')
    expect(readRenderFailures()).toHaveLength(0)
  })
})

describe('RootFailure controls', () => {
  it('moves focus to the recovery heading on mount', () => {
    const view = render(<RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} />)
    expect(view.getByRole('heading')).toBe(document.activeElement)
  })

  it('replaces the retention note when the failure was not persisted', () => {
    const view = render(
      <RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} persisted={false} />,
    )
    expect(view.getByText(/shown from memory only/)).toBeTruthy()
    expect(view.queryByText(/last three failures stay/)).toBeNull()
    expect(view.getByText(/root render boom/)).toBeTruthy()
  })

  it('invokes the injected reload action', () => {
    const onReload = vi.fn()
    const view = render(
      <RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} onReload={onReload} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('copies the diagnostic text and reports success', async () => {
    const onCopy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const view = render(
      <RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} onCopy={onCopy} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Copy diagnostics' }))
    expect(await view.findByText('Copied.')).toBeTruthy()
    expect(onCopy).toHaveBeenCalledTimes(1)
    const copied = onCopy.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('root render boom')
    expect(copied).toContain('Slot: root')
  })

  it('uses the browser clipboard by default and reports its denial', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} />)
    fireEvent.click(view.getByRole('button', { name: 'Copy diagnostics' }))
    expect(await view.findByText(/Copy failed\. Select the text above/)).toBeTruthy()
  })

  it('reloads the browser location through the default action', () => {
    const reload = vi.fn()
    reloadPage({ reload })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('tolerates clipboard denial and points at the selectable text', async () => {
    const onCopy = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
    const view = render(
      <RootFailure t={renderFailureTranslate(undefined)} records={[sampleRecord()]} onCopy={onCopy} />,
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(view.getByRole('button', { name: 'Copy diagnostics' }))
    expect(await view.findByText(/Copy failed\. Select the text above/)).toBeTruthy()
    expect(view.getByText(/root render boom/)).toBeTruthy()
  })

  it('omits the stack section when the record has no stack', async () => {
    const onCopy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const record = createRenderFailureRecord('no stack here', 'root')
    const view = render(
      <RootFailure t={renderFailureTranslate(undefined)} records={[record]} onCopy={onCopy} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Copy diagnostics' }))
    await view.findByText('Copied.')
    const copied = onCopy.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('no stack here')
    expect(copied).not.toContain('Stack:')
  })

  it('shows the empty note and no copy control without a record', () => {
    const view = render(<RootFailure t={renderFailureTranslate(undefined)} records={[]} />)
    expect(view.getByText(/No diagnostic was stored/)).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull()
  })
})

describe('RootFailureBoundary', () => {
  it('contains a plumbing error thrown outside an entry boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <RootFailureBoundary>
        <Thrower error={new Error('plumbing boom')} />
      </RootFailureBoundary>,
    )
    expect(view.container.querySelector('[data-root-failure]')).not.toBeNull()
    expect(view.container.textContent).toContain('stopped rendering')
    expect(readRenderFailures()[0]?.message).toBe('plumbing boom')
  })

  it('renders the boundary fallback in the installed locale', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <RootFailureBoundary locale={fakeLocaleFace({ renderer: ja })}>
        <Thrower error={new Error('plumbing boom')} />
      </RootFailureBoundary>,
    )
    expect(view.container.textContent).toContain('画面の描画を続けられませんでした')
  })

  it('rethrows assembly errors instead of degrading boot into the fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(
      <RootFailureBoundary>
        <Thrower error={new SlotAssemblyError('miswired boot')} />
      </RootFailureBoundary>,
    )).toThrow(SlotAssemblyError)
  })
})

describe('render-failure diagnostics', () => {
  it('retains at most three records, newest first', () => {
    for (let index = 1; index <= RENDER_FAILURE_RETENTION + 1; index += 1) {
      recordRenderFailure(
        new Error(`failure ${index}`),
        'root',
        window.localStorage,
        new Date(Date.parse(`2026-11-22T00:00:0${index}.000Z`)),
      )
    }
    const stored = readRenderFailures()
    expect(stored).toHaveLength(RENDER_FAILURE_RETENTION)
    expect(stored.map(record => record.message)).toEqual(['failure 4', 'failure 3', 'failure 2'])
  })

  it('redacts token-like runs before persisting', () => {
    const secret = 'sk-live-1234567890abcdef'
    const longRun = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0'
    recordRenderFailure(
      new Error(`request failed with ${secret} Authorization: Bearer abcdefghijklmnop token=supersecretvalue12345 ${longRun}`),
      'root',
    )
    const serialized = window.localStorage.getItem(RENDER_FAILURE_STORAGE_KEY) ?? ''
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('abcdefghijklmnop')
    expect(serialized).not.toContain('supersecretvalue12345')
    expect(serialized).not.toContain(longRun)
    expect(serialized).toContain('[redacted]')
  })

  it('preserves plugin paths and URLs while redacting a secret-like run', () => {
    const url = 'http://127.0.0.1:3097/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js:1:2'
    const secret = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0'
    recordRenderFailure(new Error(`failed at ${url} with ${secret}`), 'root')
    const stored = readRenderFailures()[0]
    expect(stored?.message).toContain(url)
    expect(stored?.message).toContain('[redacted]')
    expect(stored?.message).not.toContain(secret)
  })

  it('bounds each record to about four kilobytes', () => {
    const error = new Error('message '.repeat(2000))
    error.stack = Array.from({ length: 4000 }, (_, index) => `    at frame${index} (file.ts:1:1)`).join('\n')
    const record = createRenderFailureRecord(error, 'root')
    expect(record.message.length).toBeLessThanOrEqual(512)
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(4096)
  })

  it('trims a stack that JSON escaping inflates past the budget', () => {
    const error = new Error('control characters')
    error.stack = '\u0000'.repeat(3000)
    const record = createRenderFailureRecord(error, 'root')
    expect(record.stack.length).toBeLessThan(3072)
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(4096)
  })

  it('records an error whose stack is unavailable', () => {
    const error = new Error('no stack at all')
    delete error.stack
    const record = createRenderFailureRecord(error, 'root')
    expect(record.stack).toBe('')
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(4096)
  })

  it('drops corrupt storage content and de-duplicates the in-hand record', () => {
    window.localStorage.setItem(RENDER_FAILURE_STORAGE_KEY, 'not json')
    expect(readRenderFailures()).toEqual([])
    window.localStorage.setItem(RENDER_FAILURE_STORAGE_KEY, JSON.stringify([{ at: 1 }, null]))
    expect(readRenderFailures()).toEqual([])
    window.localStorage.setItem(RENDER_FAILURE_STORAGE_KEY, JSON.stringify('not an array'))
    expect(readRenderFailures()).toEqual([])

    const stored = recordRenderFailure(new Error('dedupe me'), 'root')
    expect(collectRenderFailures(stored.record)).toHaveLength(1)
    expect(collectRenderFailures(undefined)).toEqual(readRenderFailures())
    const inHand = createRenderFailureRecord(new Error('not stored'), 'root', new Date('2026-11-22T00:00:09.000Z'))
    expect(collectRenderFailures(inHand).map(record => record.message)).toEqual(['not stored', 'dedupe me'])
  })

  it('records non-Error and hostile thrown values without crashing', () => {
    expect(recordRenderFailure('plain failure', 'root').record.message).toBe('plain failure')
    expect(recordRenderFailure({ some: 'object' }, 'root').record.message).toBe('[object Object]')
    const hostile = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('proxy trap') },
    })
    expect(recordRenderFailure(hostile, 'root').record.message).toBe('unreadable thrown value')
  })

  it('tolerates storage methods that throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const recorded = recordRenderFailure(new Error('storage boom'), 'root')
    expect(recorded.record.message).toBe('storage boom')
    expect(recorded.persisted).toBe(false)
    expect(readRenderFailures()).toEqual([])
  })
})

describe('renderer locale dictionaries', () => {
  it('ships every key in all eight locales', () => {
    const keys = Object.keys(en).sort()
    for (const [locale, dictionary] of Object.entries(RENDERER_DICTIONARIES)) {
      expect(Object.keys(dictionary).sort(), locale).toEqual(keys)
    }
  })

  it('falls back to English when the face misses or cannot bind', () => {
    expect(renderFailureTranslate(undefined)('reload')).toBe('Reload')
    expect(renderFailureTranslate(undefined)('unknown.key')).toBe('unknown.key')
    expect(renderFailureTranslate(undefined)('diagnostics.time', {})).toBe('Time: {value}')

    const missing = fakeLocaleFace({})
    expect(renderFailureTranslate(missing)('reload')).toBe('Reload')

    const throwing: LocaleFace = {
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
      bind: () => () => { throw new Error('locale broke') },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(renderFailureTranslate(throwing)('reload')).toBe('Reload')
  })

  it('registers the renderer namespace with the locale service in apply', async () => {
    const ctx = new Context()
    const register = vi.fn((_ns: string, _dictionaries: Record<string, Record<string, string>>) => () => {})
    ctx.reflect.provide('locale', { register })
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    await vi.waitFor(() => { expect(register).toHaveBeenCalledTimes(1) })
    const call = register.mock.calls[0]
    expect(call?.[0]).toBe('renderer')
    const dictionaries = call?.[1] ?? {}
    expect(Object.keys(dictionaries).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect(dictionaries.en?.title).toBe(en.title)
    await fiber.dispose()
  })
})
