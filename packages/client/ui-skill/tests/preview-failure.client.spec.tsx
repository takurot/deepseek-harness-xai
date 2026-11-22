// @vitest-environment jsdom
/**
 * Explicit skill-preview failures reach the user: the frame-wide
 * `shell.overlay` host outlives the Session panel, offers Retry, and retries
 * the same preview for the same Session after the connection recovers.
 * Prewarm, candidate discovery, cancellation, a Session switch, and a skill
 * without a file path raise no notice.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import * as plugin from '../src/client/index.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

type SkillRow = { name: string; description: string; path?: string; modelInvocable?: boolean }
type ListResult = { ok: true; value: { skills: SkillRow[] } } | { ok: false; error: RemoteError }
type ListFn = (payload: object, signal?: AbortSignal) => Promise<ListResult>

const ROWS: SkillRow[] = [
  { name: 'review', description: 'Review', path: '/skills/review/SKILL.md' },
  { name: 'virtual', description: 'Virtual' },
]

const ADDRESS = 'dsh-resource://file/session/first//skills/review/SKILL.md'

const sid = (id: string) => id as SessionId
const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })
const req = (query: string, signal?: AbortSignal) =>
  ({ query, position: 'leading' as const, drilled: false, signal: signal ?? new AbortController().signal })

const listOk = (skills: SkillRow[] = ROWS): ListFn => () => Promise.resolve({ ok: true as const, value: { skills } })
const listFails = (): ListFn => () => Promise.resolve({
  ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}),
})

/** Flush the microtask chain a settled catalog fetch walks (no timers). */
async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) await act(async () => { await Promise.resolve() })
}

interface Bench {
  readonly runtime: SlotTestRuntime
  readonly source: InputTriggerSource
  readonly mounted: ReturnType<typeof createSnapshotStore<SessionId | undefined>>
  readonly openResourceIn: ReturnType<typeof vi.fn>
  readonly owner: Awaited<ReturnType<SlotTestRuntime['mount']>>
  readonly first: SessionId
  readonly second: SessionId
  readonly session: ClientSessionContext
}

/**
 * Boot the real ui-skill plugin in the assembled client runtime: real slot
 * registry/renderer, real locale dictionaries, a real retained Session, and a
 * frame-wide `shell.overlay` declaration.
 */
async function bench(list: ListFn, language: 'en' | 'ja' = 'en'): Promise<Bench> {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  onTestFinished(locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }))
  locale.setLocale(language)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  let captured: InputTriggerSource | undefined
  runtime.ctx.provide('inputTriggers', {
    registerSource: (source: InputTriggerSource) => { captured = source; return () => {} },
  })
  runtime.ctx.provide('uiConversation', { userText: { register: () => () => {} } })
  const mounted = createSnapshotStore<SessionId | undefined>(undefined)
  const openResourceIn = vi.fn()
  runtime.ctx.provide('sidebarRight', { mounted, openResourceIn })
  runtime.remote.provideNamespaces({ skills: { list } })
  const first = await runtime.sessions.add({ id: 'first' })
  const second = await runtime.sessions.add({ id: 'second' })
  runtime.sessions.retainFor(runtime.ctx, first)
  runtime.sessions.retainFor(runtime.ctx, second)
  mounted.set(first)
  const owner = await runtime.mount(plugin)
  await runtime.root.declare({
    'shell.overlay': { kind: 'list', scope: 'root' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true },
  }, ({ renderSlot }) => renderSlot('shell.overlay', {}))
  runtime.renderRoot()
  return {
    runtime, source: captured!, mounted, openResourceIn, owner, first, second, session: proj('first'),
  }
}

/** Let an explicit click's fetch settle and surface its diagnostics notice. */
async function failExplicitClick(b: Bench): Promise<void> {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(b.source.openReference!(b.session, { ref: '/review' })).toBe(true)
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith('[ui-skill] reference preview failed:', expect.any(Error))
  })
  await flushMicrotasks()
}

describe('explicit preview failure notice', () => {
  it('shows a localized retry notice and opens the preview once after the retry', async () => {
    let fail = true
    const list = vi.fn<ListFn>(payload => fail
      ? listFails()(payload)
      : listOk()(payload))
    const b = await bench(list)
    await failExplicitClick(b)
    expect(screen.getByRole('alert').textContent).toContain('Could not open the skill preview.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(b.openResourceIn).not.toHaveBeenCalled()

    fail = false
    b.runtime.ctx.emit('connection/reset')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    // The notice leaves as soon as the retried open starts.
    expect(screen.queryByRole('alert')).toBeNull()
    await vi.waitFor(() => { expect(b.openResourceIn).toHaveBeenCalledExactlyOnceWith(b.first, ADDRESS) })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('holds the failure long enough to press Retry and dismisses on done', async () => {
    const b = await bench(listFails())
    vi.useFakeTimers()
    b.source.openReference!(b.session, { ref: '/review' })
    await flushMicrotasks()
    const alert = screen.getByRole('alert')
    expect(alert.style.getPropertyValue('--dsh-toast-hold')).toBe('8000ms')
    await act(async () => { await vi.advanceTimersByTimeAsync(8999) })
    expect(screen.queryByRole('alert')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('localizes the failure copy in Japanese', async () => {
    const b = await bench(listFails(), 'ja')
    await failExplicitClick(b)
    expect(screen.getByRole('alert').textContent).toContain('スキルのプレビューを開けませんでした。')
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy()
  })

  it('does not stack notices for repeated clicks on the same shared fetch', async () => {
    const gate = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>(() => gate.promise)
    const b = await bench(list)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(b.source.openReference!(b.session, { ref: '/review' })).toBe(true)
    expect(b.source.openReference!(b.session, { ref: '/review' })).toBe(true)
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    gate.reject(new Error('offline'))
    await vi.waitFor(() => { expect(log).toHaveBeenCalledTimes(2) })
    await flushMicrotasks()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('dismisses the notice when a later click opens the preview', async () => {
    let fail = true
    const list = vi.fn<ListFn>(payload => fail ? listFails()(payload) : listOk()(payload))
    const b = await bench(list)
    await failExplicitClick(b)
    expect(screen.getByRole('alert')).toBeTruthy()

    fail = false
    expect(b.source.openReference!(b.session, { ref: '/review' })).toBe(true)
    await vi.waitFor(() => { expect(b.openResourceIn).toHaveBeenCalledExactlyOnceWith(b.first, ADDRESS) })
    await flushMicrotasks()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears the notice when another Session comes on screen', async () => {
    const b = await bench(listFails())
    await failExplicitClick(b)
    expect(screen.queryByRole('alert')).not.toBeNull()
    act(() => { b.mounted.set(b.second) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears the notice when the plugin disposes', async () => {
    const b = await bench(listFails())
    await failExplicitClick(b)
    expect(screen.queryByRole('alert')).not.toBeNull()
    await b.owner.dispose()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('preview failures that stay silent', () => {
  it('ignores a failed prewarm', async () => {
    const gate = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>(() => gate.promise)
    const b = await bench(list)
    b.source.warm!(b.session)
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    gate.reject(new Error('offline'))
    await flushMicrotasks()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores failed candidate discovery', async () => {
    const b = await bench(listFails())
    await expect(b.source.candidates(b.session, req(''))).rejects.toThrow('offline')
    await flushMicrotasks()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a preview cancelled by connection reset', async () => {
    const gate = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>(() => gate.promise)
    const b = await bench(list)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    b.source.openReference!(b.session, { ref: '/review' })
    const completion = b.source.candidates(b.session, req(''))
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    b.runtime.ctx.emit('connection/reset')
    gate.resolve({ ok: true, value: { skills: ROWS } })
    await expect(completion).rejects.toThrow()
    await flushMicrotasks()
    expect(log).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a failed click whose Session is no longer on screen', async () => {
    const b = await bench(listFails())
    b.mounted.set(b.second)
    await failExplicitClick(b)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a skill without a file path', async () => {
    const list = vi.fn(listOk())
    const b = await bench(list)
    expect(b.source.openReference!(b.session, { ref: '/virtual' })).toBe(true)
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    await flushMicrotasks()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(b.openResourceIn).not.toHaveBeenCalled()
  })
})
