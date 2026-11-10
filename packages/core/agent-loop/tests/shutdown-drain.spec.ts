/** Root-fiber shutdown drains buffered session events durably (both mount orders). */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, afterEach, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function mount(
  order: 'backend-first' | 'loop-first',
  adapter = new MockAdapter([textResponse('done')]),
): Promise<{ ctx: Context; root: string; backend: Context['fiber']; loop: Context['fiber'] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-drain-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  let backend: Context['fiber']
  let loop: Context['fiber']
  if (order === 'backend-first') {
    backend = await ctx.plugin(JsonlSessionPersistence, { root })
    loop = await ctx.plugin(AgentLoop, { agents: [] })
  } else {
    loop = await ctx.plugin(AgentLoop, { agents: [] })
    backend = await ctx.plugin(JsonlSessionPersistence, { root })
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root, backend, loop }
}

function closingEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'step/end' || event.type === 'turn/end')
    .map(({ type, data }) => ({ type, data }))
}

describe.each(['backend-first', 'loop-first'] as const)('root shutdown drain (%s)', (order) => {
  it.each([
    { shutdown: 'root', cancellation: 'active stream' },
    { shutdown: 'root', cancellation: 'held cancellation' },
    { shutdown: 'root', cancellation: 'first batch' },
    { shutdown: 'provider', cancellation: 'held cancellation' },
    { shutdown: 'explicit', cancellation: 'held cancellation' },
    { shutdown: 'simultaneous', cancellation: 'held cancellation' },
  ] as const)('persists disposed closing events during $shutdown shutdown and $cancellation', async ({ shutdown, cancellation }) => {
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const adapter = new MockAdapter([])
    adapter.stream = async function* (options) {
      const onAbort = (): void => { cancelled.resolve(undefined) }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        if (options.signal?.aborted) cancelled.resolve(undefined)
        entered.resolve(undefined)
        await cancelled.promise
        if (cancellation === 'held cancellation') await release.promise
        throw new Error('stream cancelled')
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
    }
    const { ctx, root, backend, loop } = await mount(order, adapter)
    const { agents, sessions } = ctx
    let disposal: Promise<void> | undefined
    const cleanup = async (): Promise<void> => {
      release.resolve(undefined)
      try {
        await disposal
      } finally {
        await ctx.fiber.dispose()
        vi.useRealTimers()
      }
    }
    onTestFinished(cleanup)
    const sessionId = SessionId('shutdown-active')
    const expectedClosers = [
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
    ]
    try {
      let ownerCtx = ctx
      const owner = await ctx.plugin({ inject: ['agents'], apply(inner: Context) { ownerCtx = inner } })
      const handle = await ownerCtx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
      const { agent } = handle
      if (cancellation === 'first batch') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
      await entered.promise
      if (cancellation === 'first batch') expect(vi.getTimerCount()).toBe(1)
      let disposed = false
      const pending = shutdown === 'root' ? ctx.fiber.dispose()
        : shutdown === 'provider' ? backend.dispose()
          : shutdown === 'explicit' ? handle.dispose()
            : Promise.all([handle.dispose(), owner.dispose(), loop.dispose(), backend.dispose(), ctx.fiber.dispose()])
      disposal = Promise.resolve(pending).then(() => { disposed = true })
      await cancelled.promise
      if (cancellation === 'held cancellation') {
        await setImmediate()
        expect(disposed).toBe(false)
      }
      release.resolve(undefined)
      await disposal
      if (cancellation === 'first batch') expect(vi.getTimerCount()).toBe(0)
      expect(agents.get(sessionId)).toBeUndefined()
      expect(sessions.get(sessionId)).toBeUndefined()
      expect(closingEvents(agent.session.snapshotEvents())).toEqual(expectedClosers)
    } finally {
      await cleanup()
    }

    const verify = new Context()
    try {
      await verify.plugin(JsonlSessionPersistence, { root })
      const reader = await verify.sessionPersistence.open(sessionId, 'read')
      try {
        const { events } = await reader.read()
        expect(closingEvents(events)).toEqual(expectedClosers)
        expect(events.at(-1)?.type).toBe('turn/end')
      } finally {
        await reader.close()
      }
    } finally {
      await verify.fiber.dispose()
    }
  })

  it.each([
    { operation: 'create', shutdown: 'provider', closeFails: false },
    { operation: 'open', shutdown: 'provider', closeFails: false },
    { operation: 'create', shutdown: 'root', closeFails: false },
    { operation: 'open', shutdown: 'root', closeFails: false },
    { operation: 'create', shutdown: 'provider', closeFails: true },
    { operation: 'open', shutdown: 'provider', closeFails: true },
  ] as const)('retains pending $operation and late close during $shutdown shutdown, closeFails=$closeFails', async ({ operation, shutdown, closeFails }) => {
    const { ctx, backend } = await mount(order)
    const { agents, sessions } = ctx
    const acquired = Promise.withResolvers<undefined>()
    const returnHandle = Promise.withResolvers<undefined>()
    const closing = Promise.withResolvers<undefined>()
    const finishClose = Promise.withResolvers<undefined>()
    const closeFailure = new Error('late handle close failed')
    const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    let disposal: Promise<void> | undefined
    const cleanup = async (): Promise<void> => {
      returnHandle.resolve(undefined)
      finishClose.resolve(undefined)
      try {
        await disposal
        await ctx.fiber.dispose()
      } finally {
        reported.mockRestore()
      }
    }
    onTestFinished(cleanup)
    const sessionId = SessionId('pending-acquisition')
    if (operation === 'open') {
      const previous = await ctx.agents.create({ sessionId })
      previous.agent.session.append('turn/start', { turn: 1 })
      previous.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await previous.dispose()
    }
    let closes = 0
    const delayHandle = async (handle: SessionHandle): Promise<SessionHandle> => {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closes++
        closing.resolve(undefined)
        await finishClose.promise
        await close()
        if (closeFails) throw closeFailure
      })
      acquired.resolve(undefined)
      await returnHandle.promise
      return handle
    }
    if (operation === 'create') {
      const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => delayHandle(await create(...args)))
    } else {
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => delayHandle(await open(...args)))
    }
    const starting = operation === 'create'
      ? ctx.agents.create({ sessionId })
      : ctx.agents.resume({ resumeSessionId: sessionId })
    const rejection = expect(starting).rejects.toThrow(/disposed|not active/)
    try {
      await acquired.promise
      let disposed = false
      disposal = Promise.resolve(shutdown === 'provider' ? backend.dispose() : ctx.fiber.dispose())
        .then(() => { disposed = true })
      await rejection
      await setImmediate()
      expect(disposed).toBe(false)
      expect(closes).toBe(0)
      returnHandle.resolve(undefined)
      await closing.promise
      expect(disposed).toBe(false)
      finishClose.resolve(undefined)
      await disposal
      expect(closes).toBe(1)
      expect(agents.get(sessionId)).toBeUndefined()
      expect(sessions.get(sessionId)).toBeUndefined()
      if (closeFails) {
        expect(reported.mock.calls.some(([error]) => error === closeFailure
          || error instanceof AggregateError && error.errors.includes(closeFailure))).toBe(true)
      } else {
        expect(reported).not.toHaveBeenCalled()
      }
    } finally {
      await cleanup()
    }
  })

  it('does not restart a disposed Agent when its persistence provider is replaced', async () => {
    const { ctx, root, backend } = await mount(order)
    onTestFinished(() => ctx.fiber.dispose())
    const published: SessionId[] = []
    ctx.on('agent/created', ({ agent }) => { published.push(agent.id) })
    const sessionId = SessionId('provider-replacement')
    const handle = await ctx.agents.create({ sessionId })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await backend.dispose()
    await ctx.plugin(JsonlSessionPersistence, { root })
    await setImmediate()
    expect(published).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect(published).toEqual([sessionId, sessionId])
    await resumed.dispose()
  })

  it.each(['publication', 'configuration', 'pre-activation disposal'] as const)('releases the persistence lifetime after %s failure', async (failure) => {
    const { ctx } = await mount(order)
    onTestFinished(() => ctx.fiber.dispose())
    const create = vi.spyOn(ctx.sessionPersistence, 'create')
    const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    const sessionId = SessionId('child-startup-failure')
    const rejected = new Error('child startup failed')
    let child: Context['fiber'] | undefined
    const unfollow = ctx.on('internal/plugin', (fiber) => {
      if (child !== undefined || fiber.uid === null || !Object.hasOwn(fiber.inject, 'sessionPersistence')) return
      child = fiber
      if (failure === 'publication') throw rejected
      if (failure === 'pre-activation disposal') void fiber.dispose()
    })
    const unconfigure = ctx.on('internal/config', (fiber, next): unknown => {
      if (failure === 'configuration' && fiber === child) throw rejected
      return next()
    })
    await expect(ctx.agents.create({ sessionId })).rejects.toThrow(
      failure === 'pre-activation disposal' ? `agent "${sessionId}" persistence is not active` : rejected,
    )
    await child?.dispose()
    while (child?.inertia !== undefined) await child.inertia
    expect(child?.uid).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    if (failure === 'configuration') expect(reported).toHaveBeenCalledWith(rejected)
    unfollow()
    unconfigure()
    const retried = await ctx.agents.create({ sessionId })
    expect(create).toHaveBeenCalledOnce()
    await retried.dispose()
  })

  it('uses the factory persistence provider when the caller owns an isolated provider', async () => {
    const { ctx } = await mount(order)
    onTestFinished(() => ctx.fiber.dispose())
    const shadowRoot = await mkdtemp(join(tmpdir(), 'dsh-shutdown-shadow-'))
    dirs.push(shadowRoot)
    const caller = ctx.isolate('sessionPersistence')
    await caller.plugin(JsonlSessionPersistence, { root: shadowRoot })
    const originalCreate = vi.spyOn(ctx.sessionPersistence, 'create')
    const shadowCreate = vi.spyOn(caller.sessionPersistence, 'create')
    let ownerCtx = caller
    const owner = await caller.plugin({ inject: ['agents'], apply(inner: Context) { ownerCtx = inner } })
    const sessionId = SessionId('caller-shadow')
    const handle = await ownerCtx.agents.create({ sessionId })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await owner.dispose()
    expect(originalCreate).toHaveBeenCalledOnce()
    expect(shadowCreate).not.toHaveBeenCalled()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const reader = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      expect((await reader.read()).events.at(-1)).toMatchObject({
        type: 'turn/end', data: { reason: { kind: 'completed' } },
      })
    } finally {
      await reader.close()
    }
  })

  it('reports a failed first-batch drain and preserves explicit disposal rejection', async () => {
    const { ctx, root } = await mount(order)
    const { agents, sessions } = ctx
    const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    const cleanup = async (): Promise<void> => {
      try {
        await ctx.fiber.dispose()
      } finally {
        vi.useRealTimers()
        reported.mockRestore()
      }
    }
    onTestFinished(cleanup)
    try {
      const sessionId = SessionId('failed-final-drain')
      const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const idle = waitForIdle(ctx, handle.agent)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
      await idle
      expect(vi.getTimerCount()).toBe(1)
      expect(await readdir(root)).toEqual([])
      await rm(root, { recursive: true })
      await writeFile(root, 'storage root is no longer a directory')
      await ctx.fiber.dispose()
      const failure = await handle.dispose().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(errorChain(failure)).toMatch(/ENOTDIR|EEXIST/)
      expect(reported.mock.calls.some(([error]) => error === failure)).toBe(true)
      await expect(handle.dispose()).rejects.toBe(failure)
      expect(agents.get(sessionId)).toBeUndefined()
      expect(sessions.get(sessionId)).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('persists buffered turn events without an explicit flush before dispose', async () => {
    const { ctx, root } = await mount(order)
    const sessionId = SessionId('shutdown-drain')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    // No explicit flush and no agent dispose: root teardown must drain.
    await ctx.fiber.dispose()

    const verify = new Context()
    await verify.plugin(JsonlSessionPersistence, { root })
    const reader = await verify.sessionPersistence.open(sessionId, 'read')
    const { events } = await reader.read()
    await reader.close()
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await verify.fiber.dispose()
  })
})
