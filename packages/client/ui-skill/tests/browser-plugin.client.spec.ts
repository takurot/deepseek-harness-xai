import { es, fr, de, ru, pt } from '../src/client/locales.ts'
/**
 * ui-skill browser half: source and keyed toolview registration +
 * locale dictionaries + source duplicate-name proof +
 * fiber-teardown removal (HMR safety) against the real InputTriggerService, then
 * the source behavior contract driven directly on the captured source with
 * real ClientSessionContext projections — sessionId addressing, the
 * session-keyed catalog cache (single-flight per key, scope-birth warm
 * prewarm, plugin-manager/changed and connection/reset clears), shared fuzzy
 * name ranking, RPC-failure
 * rejection, pick → plain-text outcome (the plain-text-reference decision:
 * .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md),
 * the synchronous
 * lexicon reads over the settled cache, and the reference codec's two
 * projections. Most cases drive the source directly. The delayed-preview
 * block composes the plugin with the production Sidebar controller and stores
 * to prove which Session's store receives an open.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { RemoteError, TestRemote, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionFixture } from '@deepseek-ai/dsh-client-test-runtime'
import type { InjectParams } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'
import { SkillRow as SkillToolRow } from '../src/client/SkillRow.tsx'
import { SkillReference, type SkillReferenceInjected } from '../src/client/SkillReference.tsx'
import { UserTextRegistry } from '../../ui-conversation/src/client/conversation/user-text-registry.ts'
import { createSidebarRightController } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/service.ts'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'

type SkillRow = { name: string; description: string; whenToUse?: string; path?: string; modelInvocable?: boolean }
type ListResult =
  | { ok: true; value: { skills: SkillRow[] } }
  | { ok: false; error: RemoteFailure }
type ListFn = (payload: object, signal?: AbortSignal) => Promise<ListResult>

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  const userText = new UserTextRegistry(ctx)
  ctx.provide('uiConversation', { userText } as never)
  slots.register({
    name: 'root',
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const capture: PresentationCapture = {
    slots,
    dictionaries: [],
    localeDisposed: false,
  }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => { capture.localeDisposed = true }
    },
    // Minimal bound-translate fake: zh dictionary lookup, key passthrough on miss.
    bind: () => (key: string) => key === 'menu.userOnly' ? '仅用户' : key,
  })
  return capture
}

interface BenchOptions {
  /** Supply the sidebar face; defaults to a recording navigation mock. */
  readonly sidebarRight?: (ctx: Context) => object
}

/** Boot the plugin over fake slash/connection faces; returns the captured source and its ctx. */
async function bench(
  list: ListFn,
  addressed?: SessionId,
  opening: Pick<SessionFixture, 'initialOpen' | 'snapshot'> = {},
  options: BenchOptions = {},
) {
  const ctx = new Context()
  const openResourceIn = vi.fn()
  const mounted = createSnapshotStore<SessionId | undefined>(undefined)
  ctx.provide('sidebarRight', options.sidebarRight?.(ctx) ?? { mounted, openResourceIn })
  let captured: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource: (src: InputTriggerSource) => { captured = src; return () => {} } })
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  const references = new Map<SessionId, ReturnType<TestSessions['retainFor']>>()
  for (const id of ['s1', 's2', 'preview', 'first', 'second', 'child']) {
    await sessions.add({ id, ...opening })
    references.set(sid(id), sessions.retainFor(ctx, id === addressed
      ? { parentSessionId: sid('parent'), childSessionId: addressed, mode: 'continuable' }
      : sid(id)))
  }
  /** Release the fixture's long-lived reference, as the runtime does when a Session closes. */
  const releaseScope = (id: SessionId): void => {
    const reference = references.get(id)
    if (reference === undefined) throw new Error(`expected a retained Session scope for "${id}"`)
    references.delete(id)
    reference.release()
  }
  const remote = new TestRemote(ctx, { skills: { list } })
  const presentation = providePresentation(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { ctx, source: captured!, remote, fiber, openResourceIn, sessions, presentation, releaseScope }
}

/** The real right Sidebar: one tab registry, its controller, and one adopted store per Session. */
function realSidebar(ctx: Context) {
  const tabs = new SidebarRightTabRegistry(ctx)
  tabs.register({
    id: 'test/text',
    kind: 'text',
    patterns: ['dsh-resource://file/**'],
    priority: 'fallback',
    title: address => address.slice(address.lastIndexOf('/') + 1),
  })
  const { controller, adopt, show } = createSidebarRightController(tabs, vi.fn(), {
    autoFullscreen: () => false,
    openWithFocus: (_sessionId, open) => { open() },
    closeWithFocus: (_sessionId, _paneId, close) => { close() },
  })
  const stores = new Map<SessionId, ReturnType<ReturnType<typeof createSidebarRightStore>['create']>>()
  const store = (sessionId: SessionId) => {
    const held = stores.get(sessionId)
    if (held === undefined) throw new Error(`expected an adopted store for Session "${sessionId}"`)
    return held
  }
  const surface = (sessionId: SessionId) => store(sessionId).getSnapshot().bySession[sessionId]
  const adoptStore = (sessionId: SessionId): (() => void) => {
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Guide' })).create()
    stores.set(sessionId, instance)
    return adopt(sessionId, instance)
  }
  const openResource = vi.fn(controller.openResource.bind(controller))
  const openResourceIn = vi.fn(controller.openResourceIn.bind(controller))
  return {
    controller,
    show,
    adoptStore,
    store,
    surface,
    openResource,
    openResourceIn,
    sidebarRight: { mounted: controller.mounted, openResource, openResourceIn },
  }
}

const CATALOG: SkillRow[] = [
  { name: 'commit-helper', description: 'commit flow', modelInvocable: true },
  { name: 'code-review', description: 'review flow', whenToUse: 'reviews', modelInvocable: true },
  { name: 'deploy', description: 'deploy flow', modelInvocable: true },
]

const listOk = (skills: SkillRow[]): ListFn => () => Promise.resolve({ ok: true as const, value: { skills } })

/** Counting fake: records payloads, resolves the shared catalog. */
function countingList(skills: SkillRow[] = CATALOG) {
  const payloads: object[] = []
  const list: ListFn = (payload) => {
    payloads.push(payload)
    return listOk(skills)(payload)
  }
  return { list, payloads }
}

const sid = (id: string) => id as SessionId

const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

const req = (query: string, signal?: AbortSignal) =>
  ({ query, position: 'leading' as const, drilled: false, signal: signal ?? new AbortController().signal })

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['inputTriggers', 'sessions', 'slots', 'locale', 'remote', 'remote.skills', 'sidebarRight', 'uiConversation'])
  })

  it('registers the dedicated skill row and its locale dictionaries', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('sidebarRight', { mounted: createSnapshotStore<SessionId | undefined>(undefined), openResourceIn: vi.fn() })
    ctx.provide('inputTriggers', { registerSource: () => () => {} })
    ctx.provide('sessions', { subagentAddress: () => undefined })
    new TestRemote(ctx, { skills: { list: listOk(CATALOG) } })
    const presentation = providePresentation(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = presentation.slots.entries('tool.call.toolview')[0]
    expect(entry?.options).toMatchObject({ key: 'skill' })
    expect(entry?.locale).toBe('skill')
    expect(entry?.component).toBe(SkillToolRow)
    expect(presentation.dictionaries).toEqual([{
      namespace: 'skill', dictionaries: {
        es, fr, de, ru, pt,
        zh: {
          'row.title': '加载技能',
          'row.running': '正在加载 skill',
          'row.preparing': '准备加载技能',
          'row.failed': 'skill 加载失败',
          'row.stopped': 'skill 加载已中止',
          'row.instructions': '说明',
          'row.inspect': '查看',
          'menu.userOnly': '仅用户',
          'preview.failure': '无法打开技能预览。',
          'preview.retry': '重试',
        },
        en: {
          'row.title': 'Skill',
          'row.running': 'Loading skill',
          'row.preparing': 'Preparing to load a skill',
          'row.failed': 'Skill load failed',
          'row.stopped': 'Skill load stopped',
          'row.instructions': 'Instructions',
          'row.inspect': 'Inspect',
          'menu.userOnly': 'user-only',
          'preview.failure': 'Could not open the skill preview.',
          'preview.retry': 'Retry',
        },
        ja: {
          'row.title': 'スキル',
          'row.running': 'スキルを読み込み中',
          'row.preparing': 'スキルの読み込みを準備中',
          'row.failed': 'スキルの読み込みに失敗しました',
          'row.stopped': 'スキルの読み込みが停止しました',
          'row.instructions': '手順',
          'row.inspect': '詳細を確認',
          'menu.userOnly': 'ユーザー専用',
          'preview.failure': 'スキルのプレビューを開けませんでした。',
          'preview.retry': '再試行',
        },
      },
    }])
  })

  it('registers the "/" skill source; disposal frees the name (HMR safety)', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('sidebarRight', { mounted: createSnapshotStore<SessionId | undefined>(undefined), openResourceIn: vi.fn() })
    // InputTriggerService itself injects 'sessions'; the stub unblocks its fiber.
    ctx.provide('sessions', {})
    await ctx.plugin(InputTriggerService).await()
    new TestRemote(ctx, { skills: { list: listOk(CATALOG) } })
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    const rival = {
      trigger: '/' as const,
      name: 'skill',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    }
    // Live registration holds the (trigger, name) seat…
    expect(() => inputTriggers.registerSource(rival)).toThrow(/already registered/)
    // …and fiber teardown releases it.
    await fiber.dispose()
    expect(() => inputTriggers.registerSource(rival)).not.toThrow()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(presentation.slots.entries('shell.overlay')).toHaveLength(0)
    expect(presentation.localeDisposed).toBe(true)
  })
})

describe('candidates: sessionId addressing', () => {
  it('waits for history and retains the Session until the shared skill RPC settles', async () => {
    const opened = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<ListResult>()
    const list = vi.fn(() => response.promise)
    const b = await bench(list, undefined, { initialOpen: () => opened.promise })
    try {
      const pending = b.source.candidates(proj('s1'), req(''))
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().retainedBy.skillCatalog).toBe(1)
      expect(list).not.toHaveBeenCalled()
      opened.resolve(undefined)
      await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(2)
      response.resolve({ ok: true, value: { skills: CATALOG } })
      await pending
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(1)
    } finally {
      opened.resolve(undefined)
      response.resolve({ ok: true, value: { skills: CATALOG } })
    }
  })

  it.each([true, false])('refuses an unsuccessful history open (reported error: %s)', async (reported) => {
    const error = new RemoteError('gateway/internal', 'history unavailable', {})
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list, undefined, { snapshot: { openState: 'error', openError: reported ? error : null } })
    await expect(b.source.candidates(proj('s1'), req(''))).rejects.toThrow(reported ? 'history unavailable' : 'is not open')
    expect(list).not.toHaveBeenCalled()
    expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(1)
  })

  it('does not reopen a released Session for skill discovery', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list)
    await b.sessions.binding(sid('s1'))!.ctx.fiber.dispose()
    await expect(b.source.candidates(proj('s1'), req(''))).rejects.toThrow('requires a retained session')
    expect(list).not.toHaveBeenCalled()
    expect(b.sessions.binding(sid('s1'))).toBeUndefined()
  })

  it('releases the shared read when the plugin unloads before history is ready', async () => {
    const opened = Promise.withResolvers<undefined>()
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list, undefined, { initialOpen: () => opened.promise })
    try {
      const pending = expect(b.source.candidates(proj('s1'), req(''))).rejects.toThrow()
      await b.fiber.dispose()
      await pending
      expect(list).not.toHaveBeenCalled()
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(1)
    } finally {
      opened.resolve(undefined)
    }
  })

  it('lists via {sessionId} and ranks case-insensitive subsequence matches with prefixes first', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const items = await source.candidates(proj('s1'), req('co'))
    // Exact payload: session address only — no agent or transport vocabulary.
    expect(payloads).toEqual([{ sessionId: 's1' }])
    expect(items).toEqual([
      { name: 'commit-helper', description: 'commit flow' },
      { name: 'code-review', description: 'review flow' },
    ])
    const names = async (query: string) => (await source.candidates(proj('s1'), req(query))).map(c => c.name)
    // 'de' prefixes deploy and is a subsequence of code-review: the prefix ranks first.
    await expect(names('de')).resolves.toEqual(['deploy', 'code-review'])
    await expect(names('REV')).resolves.toEqual(['code-review'])
    await expect(names('zzz')).resolves.toEqual([])
  })

  it('rejects on a failed result (the slash shell owns the menu-side fold)', async () => {
    const { source } = await bench(() => Promise.resolve({
      ok: false, error: new RemoteError('gateway/internal', 'boom', {}),
    }))
    await expect(source.candidates(proj('s1'), req('co')))
      .rejects.toThrow('skills/list failed: gateway/internal: boom')
  })

  it('does not fetch Agent-bound skills for an addressed child', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list, sid('child'))
    await expect(source.candidates(proj('child'), req(''))).resolves.toEqual([])
    source.warm!(proj('child'))
    expect(payloads).toEqual([])
  })
})

describe('catalog cache', () => {
  it('re-polls on the same session filter locally: one RPC across keystrokes', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    const second = await source.candidates(proj('s1'), req('co'))
    expect(payloads).toHaveLength(1)
    expect(second).toEqual([
      { name: 'commit-helper', description: 'commit flow' },
      { name: 'code-review', description: 'review flow' },
    ])
    // A different session is its own key — one more RPC, not two.
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toEqual([{ sessionId: 's1' }, { sessionId: 's2' }])
  })

  it('single-flight: concurrent candidates on one cold key share one RPC', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const [a, b] = await Promise.all([
      source.candidates(proj('s1'), req('dep')),
      source.candidates(proj('s1'), req('co')),
    ])
    expect(payloads).toHaveLength(1)
    expect(a).toEqual([{ name: 'deploy', description: 'deploy flow' }])
    expect(b).toHaveLength(2)
  })

  it('an aborted caller yields empty but leaves the shared fetch warm', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.candidates(proj('s1'), req('co', aborted.signal))).resolves.toEqual([])
    // The fetch settled into the cache: the next caller pays zero RPC.
    await expect(source.candidates(proj('s1'), req('co'))).resolves.toHaveLength(2)
    expect(payloads).toHaveLength(1)
  })

  it('a failed fetch does not poison the key: the next caller retries', async () => {
    let fail = true
    const payloads: object[] = []
    const { source } = await bench((payload) => {
      payloads.push(payload)
      return fail
        ? Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'boom', {}) })
        : listOk(CATALOG)(payload)
    })
    await expect(source.candidates(proj('s1'), req(''))).rejects.toThrow('boom')
    fail = false
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(payloads).toHaveLength(2)
  })

  it('the scope-birth warm prewarms the session key fire-and-forget', async () => {
    const { list, payloads } = countingList()
    const { source } = await bench(list)
    source.warm!(proj('s1'))
    await vi.waitFor(() => { expect(payloads).toHaveLength(1) })
    expect(payloads[0]).toEqual({ sessionId: 's1' })
    // The prewarmed key serves candidates with zero further RPC; other
    // sessions' keys stay untouched.
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(payloads).toHaveLength(1)
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
  })

  it('agent-preset/selected clears only the recomposed session', async () => {
    const { list, payloads } = countingList()
    const { source, remote } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
    // The catalog a preset supplies is the preset's; the other session's
    // composition did not change, so its cached catalog still holds.
    remote.emit('agent-preset/selected', [sid('s1'), 'minimal'])
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(3)
    expect(payloads[2]).toEqual({ sessionId: 's1' })
  })

  it('connection/reset clears every cached session', async () => {
    const { list, payloads } = countingList()
    const { ctx, source } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
    ctx.emit('connection/reset')
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(4)
  })

  it('plugin-manager/changed clears every cached session', async () => {
    const { list, payloads } = countingList()
    const { source, remote } = await bench(list)
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(2)
    // A switched plugin may register into the global layer every session reads.
    remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await source.candidates(proj('s1'), req(''))
    await source.candidates(proj('s2'), req(''))
    expect(payloads).toHaveLength(4)
  })
})

describe('lexicon', () => {
  it('is undefined before the session catalog settles and serves names after', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { source } = await bench(async (payload) => {
      await gate
      return listOk(CATALOG)(payload)
    })
    // Cold: nothing cached for the session.
    expect(source.lexicon!(proj('s1'))).toBeUndefined()
    const pending = source.candidates(proj('s1'), req(''))
    // In flight: still no synchronous snapshot.
    expect(source.lexicon!(proj('s1'))).toBeUndefined()
    release!()
    await pending
    expect(source.lexicon!(proj('s1'))).toEqual(['commit-helper', 'code-review', 'deploy'])
    // Another session's key is independent — cold until its own fetch.
    expect(source.lexicon!(proj('s2'))).toBeUndefined()
  })

  it('subscribeLexicon notifies on catalog settle and on invalidation, per session', async () => {
    const { list } = countingList()
    const { ctx, source } = await bench(list)
    const s1 = vi.fn()
    const s2 = vi.fn()
    source.subscribeLexicon!(proj('s1'), s1)
    source.subscribeLexicon!(proj('s2'), s2)
    await source.candidates(proj('s1'), req(''))
    expect(s1).toHaveBeenCalledTimes(1)
    expect(s2).not.toHaveBeenCalled()
    // Reset invalidates every cached session: each key notifies its own listeners.
    await source.candidates(proj('s2'), req(''))
    ctx.emit('connection/reset')
    expect(s1).toHaveBeenCalledTimes(2)
    expect(s2).toHaveBeenCalledTimes(2)
  })

  it('an unsubscribed lexicon listener stops receiving notifications', async () => {
    const { list } = countingList()
    const { source } = await bench(list)
    const listener = vi.fn()
    const off = source.subscribeLexicon!(proj('s1'), listener)
    off()
    await source.candidates(proj('s1'), req(''))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('pick lands plain text', () => {
  it('onPick returns the literal /name text with a closing space', async () => {
    const { source } = await bench(listOk(CATALOG))
    const outcome = source.onPick({
      candidate: { name: 'commit-helper', description: 'commit flow' },
      session: proj('s1'),
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 4, draftRev: 7 },
    })
    expect(outcome).toEqual({ text: '/commit-helper ' })
  })

  it('keeps the legacy reference codec removed and stays out of adjudication', async () => {
    const { source } = await bench(listOk(CATALOG))
    // Determinism lives host-side (the pre-step gesture boundary), so the
    // source neither claims lines nor serializes reference markup.
    expect(source.codec).toBeUndefined()
    expect(typeof source.matchSpace).toBe('undefined')
    expect(typeof source.matchEnter).toBe('undefined')
  })
})

describe('user-only marking', () => {
  it('prefixes the description of candidates the model cannot invoke', async () => {
    const rows: SkillRow[] = [
      { name: 'shared-skill', description: 'both surfaces', modelInvocable: true },
      { name: 'user-only-skill', description: 'user surface only', modelInvocable: false },
    ]
    const { source } = await bench(listOk(rows))
    const candidates = await source.candidates(proj('s1'), req(''))
    expect(candidates).toEqual([
      { name: 'shared-skill', description: 'both surfaces' },
      { name: 'user-only-skill', description: '仅用户 · user surface only' },
    ])
  })
})

describe('reference preview', () => {
  const rows: SkillRow[] = [
    { name: 'review', description: 'Review', path: '/skills/review/SKILL.md' },
    { name: 'virtual', description: 'Virtual' },
  ]

  it('routes sent skill previews through the reference entry’s own Session and ignores an absent scope', async () => {
    const b = await bench(listOk(rows))
    const entry = b.presentation.slots.entries('conversation.user.text.node').find(row => row.options.key === 'skill')
    expect(entry?.component).toBe(SkillReference)
    if (entry?.inject === undefined) throw new Error('Skill reference injector was not registered')
    const injectReference = entry.inject as (
      ...params: InjectParams<'conversation.user.text.node', undefined>
    ) => Pick<SkillReferenceInjected, 'openSkill'>
    const openReference = vi.spyOn(b.source, 'openReference')
    const first = injectReference(sid('first'))
    const second = injectReference(sid('second'))
    first.openSkill('review')
    await b.source.candidates(proj('first'), req(''))
    expect(openReference).toHaveBeenLastCalledWith(proj('first'), { ref: '/review' })
    expect(b.openResourceIn).toHaveBeenLastCalledWith(sid('first'), 'dsh-resource://file/session/first//skills/review/SKILL.md')
    second.openSkill('review')
    await b.source.candidates(proj('second'), req(''))
    expect(openReference).toHaveBeenLastCalledWith(proj('second'), { ref: '/review' })
    expect(b.openResourceIn).toHaveBeenLastCalledWith(sid('second'), 'dsh-resource://file/session/second//skills/review/SKILL.md')
    vi.spyOn(b.sessions, 'scope').mockReturnValueOnce(undefined)
    first.openSkill('review')
    expect(openReference).toHaveBeenCalledTimes(2)
    expect(b.openResourceIn).toHaveBeenCalledTimes(2)
  })

  it('finishes the first click after a shared warm fetch and reloads after reconnect', async () => {
    const gate = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>().mockReturnValueOnce(gate.promise).mockImplementation(listOk(rows))
    const { ctx, source, openResourceIn } = await bench(list)
    const session = proj('preview')
    source.warm!(session)
    expect(source.openReference!(session, { ref: '/review' })).toBe(true)
    const candidates = source.candidates(session, req(''))
    expect(openResourceIn).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    gate.resolve({ ok: true, value: { skills: rows } })
    await candidates
    expect(openResourceIn).toHaveBeenCalledExactlyOnceWith(sid('preview'), 'dsh-resource://file/session/preview//skills/review/SKILL.md')
    expect(source.openReference!(session, { ref: '/virtual' })).toBe(false)
    expect(source.openReference!(session, { ref: '/missing' })).toBe(false)
    expect(source.openReference!(session, { ref: '/review' })).toBe(true)
    ctx.emit('connection/reset')
    expect(source.openReference!(session, { ref: '/review' })).toBe(true)
    await source.candidates(session, req(''))
    expect(list).toHaveBeenCalledTimes(2)
    expect(openResourceIn).toHaveBeenCalledTimes(3)
  })

  it('keeps pending clicks bound to their own Session when another Session opens', async () => {
    const first = Promise.withResolvers<ListResult>()
    const second = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { source, openResourceIn } = await bench(list)
    source.openReference!(proj('first'), { ref: '/review' })
    const firstDone = source.candidates(proj('first'), req(''))
    source.openReference!(proj('second'), { ref: '/review' })
    const secondDone = source.candidates(proj('second'), req(''))
    second.resolve({ ok: true, value: { skills: [{ ...rows[0]!, path: '/second/SKILL.md' }] } })
    await secondDone
    expect(openResourceIn).toHaveBeenLastCalledWith(sid('second'), 'dsh-resource://file/session/second//second/SKILL.md')
    first.resolve({ ok: true, value: { skills: rows } })
    await firstDone
    expect(openResourceIn).toHaveBeenLastCalledWith(sid('first'), 'dsh-resource://file/session/first//skills/review/SKILL.md')
    expect(list.mock.calls.map(([payload]) => payload)).toEqual([{ sessionId: 'first' }, { sessionId: 'second' }])
  })

  it.each(['reset', 'preset', 'plugin', 'dispose'] as const)('cancels a pending preview on %s even if the RPC completes late', async (reason) => {
    const gate = Promise.withResolvers<ListResult>()
    const { ctx, source, remote, fiber, openResourceIn } = await bench(() => gate.promise)
    const session = proj('preview')
    const listener = vi.fn()
    source.subscribeLexicon!(session, listener)
    source.openReference!(session, { ref: '/review' })
    const completion = expect(source.candidates(session, req(''))).rejects.toThrow()
    if (reason === 'reset') ctx.emit('connection/reset')
    else if (reason === 'preset') remote.emit('agent-preset/selected', [session.sessionId, 'minimal'])
    else if (reason === 'plugin') remote.emit('plugin-manager/changed', [{ reason: 'plugin' }])
    else await fiber.dispose()
    expect(listener).toHaveBeenCalledTimes(1)
    gate.resolve({ ok: true, value: { skills: rows } })
    await completion
    expect(source.lexicon!(session)).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(openResourceIn).not.toHaveBeenCalled()
  })

  it('reports a failed preview fetch and allows the next click to retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const list = vi.fn<ListFn>().mockRejectedValueOnce(new Error('offline')).mockImplementation(listOk(rows))
    const { source, openResourceIn } = await bench(list)
    const session = proj('preview')
    source.openReference!(session, { ref: '/review' })
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith('[ui-skill] reference preview failed:', expect.any(Error)) })
    expect(openResourceIn).not.toHaveBeenCalled()
    source.openReference!(session, { ref: '/review' })
    await source.candidates(session, req(''))
    expect(openResourceIn).toHaveBeenCalledOnce()
  })

  it('does not fetch or preview a skill from addressed subagent history', async () => {
    const list = vi.fn(listOk(rows))
    const { source, openResourceIn } = await bench(list, sid('child'))
    expect(source.openReference!(proj('child'), { ref: '/review' })).toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(openResourceIn).not.toHaveBeenCalled()
  })
})

describe('a delayed preview opens in its own Session', () => {
  const rows: SkillRow[] = [{ name: 'review', description: 'Review', path: '/skills/review/SKILL.md' }]
  const ADDRESS = 'dsh-resource://file/session/first//skills/review/SKILL.md'
  const OTHER_ADDRESS = 'dsh-resource://file/session/second/notes.md'

  /** Boot the plugin with the real controller, one adopted store per Session, and B on screen. */
  async function benchWithSidebar(list: ListFn) {
    let real: ReturnType<typeof realSidebar> | undefined
    const b = await bench(list, undefined, {}, {
      sidebarRight: (ctx) => {
        real = realSidebar(ctx)
        return real.sidebarRight
      },
    })
    if (real === undefined) throw new Error('expected the real Sidebar face')
    const a = sid('first')
    const other = sid('second')
    real.adoptStore(a)
    real.adoptStore(other)
    real.show(other)
    real.controller.openResource(OTHER_ADDRESS)
    return { ...b, real, a, other }
  }

  it('opens exactly once in the originating Session and leaves the on-screen Session untouched', async () => {
    const response = Promise.withResolvers<ListResult>()
    const { real, source, a, other } = await benchWithSidebar(() => response.promise)
    const before = real.store(other).getSnapshot()
    const otherTabs = Object.values(real.surface(other)!.layout.tabs).map(tab => tab.title)
    const otherEntries = real.surface(other)!.history.entries.length

    // A is on screen when the user clicks, then the user switches to B.
    real.show(a)
    expect(source.openReference!(proj('first'), { ref: '/review' })).toBe(true)
    real.show(other)
    response.resolve({ ok: true, value: { skills: rows } })
    await vi.waitFor(() => {
      expect(real.openResource.mock.calls.length + real.openResourceIn.mock.calls.length).toBe(1)
    })

    // B keeps the same committed state: no tab, expansion, or history change.
    expect(Object.values(real.surface(other)!.layout.tabs).map(tab => tab.title)).toEqual(otherTabs)
    expect(real.surface(other)!.layout.expanded).toBe(true)
    expect(real.surface(other)!.history.entries).toHaveLength(otherEntries)
    expect(real.store(other).getSnapshot()).toBe(before)
    expect(real.openResourceIn).toHaveBeenCalledExactlyOnceWith(a, ADDRESS)
    expect(real.openResource).not.toHaveBeenCalled()
    const opened = real.surface(a)
    if (opened === undefined) throw new Error('expected the originating Session to receive the preview')
    expect(Object.values(opened.layout.tabs).map(tab => tab.contentId)).toEqual([ADDRESS])
    expect(opened.layout.expanded).toBe(true)
    expect(opened.history.entries).toHaveLength(1)
  })

  it('opens nothing when the originating Session scope was released before the response', async () => {
    const response = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>().mockReturnValueOnce(response.promise)
    const { real, source, a, other, releaseScope } = await benchWithSidebar(list)
    // A renders once, then the user closes it and the runtime releases its retained scope.
    real.show(a)
    real.controller.openResource('dsh-resource://file/session/first/a.md')
    const aBefore = real.store(a).getSnapshot()
    real.show(other)

    expect(source.openReference!(proj('first'), { ref: '/review' })).toBe(true)
    const pending = source.candidates(proj('first'), req(''))
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    // The Session closes while its catalog RPC is still in flight.
    releaseScope(a)
    response.resolve({ ok: true, value: { skills: rows } })
    await pending

    expect(real.openResourceIn).not.toHaveBeenCalled()
    expect(real.openResource).not.toHaveBeenCalled()
    // The Sidebar adoption outlives the Session: the liveness guard, not the
    // controller's missing adoption, is what stopped the open.
    expect(real.surface(a)).toBeDefined()
    expect(real.store(a).getSnapshot()).toBe(aBefore)
    expect(Object.values(real.surface(a)!.layout.tabs).map(tab => tab.title)).toEqual(['a.md'])
  })

  it('opens once when the originating Session is still on screen at settlement', async () => {
    const response = Promise.withResolvers<ListResult>()
    const { real, source, a, other } = await benchWithSidebar(() => response.promise)
    const before = real.store(other).getSnapshot()

    // A stays on screen from the click to the settlement.
    real.show(a)
    source.openReference!(proj('first'), { ref: '/review' })
    response.resolve({ ok: true, value: { skills: rows } })
    await vi.waitFor(() => {
      expect(real.openResource.mock.calls.length + real.openResourceIn.mock.calls.length).toBe(1)
    })

    expect(real.store(other).getSnapshot()).toBe(before)
    expect(real.openResourceIn).toHaveBeenCalledExactlyOnceWith(a, ADDRESS)
    expect(real.openResource).not.toHaveBeenCalled()
    expect(Object.values(real.surface(a)!.layout.tabs)).toHaveLength(1)
  })

  it('cancels with the other pending previews, then a user retry opens once in the same Session', async () => {
    const response = Promise.withResolvers<ListResult>()
    const list = vi.fn<ListFn>().mockImplementationOnce(() => response.promise).mockImplementation(listOk(rows))
    const { ctx, real, source, a, other } = await benchWithSidebar(list)
    const before = real.store(other).getSnapshot()

    real.show(a)
    expect(source.openReference!(proj('first'), { ref: '/review' })).toBe(true)
    const pending = source.candidates(proj('first'), req(''))
    // Cancel only once the shared fetch has reached the RPC.
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    real.show(other)
    ctx.emit('connection/reset')
    response.resolve({ ok: true, value: { skills: rows } })
    await expect(pending).rejects.toThrow()
    expect(real.openResourceIn).not.toHaveBeenCalled()
    expect(real.surface(a)).toBeUndefined()

    expect(source.openReference!(proj('first'), { ref: '/review' })).toBe(true)
    await vi.waitFor(() => {
      expect(real.openResource.mock.calls.length + real.openResourceIn.mock.calls.length).toBe(1)
    })

    expect(list).toHaveBeenCalledTimes(2)
    expect(real.openResourceIn).toHaveBeenCalledExactlyOnceWith(a, ADDRESS)
    expect(real.openResource).not.toHaveBeenCalled()
    expect(Object.values(real.surface(a)!.layout.tabs).map(tab => tab.contentId)).toEqual([ADDRESS])
    expect(real.store(other).getSnapshot()).toBe(before)
  })
})
