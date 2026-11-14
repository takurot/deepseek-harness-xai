import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XaiSearchProvider } from '../src/provider.ts'
import type { XaiSearchProviderOptions } from '../src/provider.ts'

const OPTIONS: XaiSearchProviderOptions = {
  baseURL: 'https://xai.test/v1',
  model: 'grok-test',
  sources: ['web'],
  timeoutMs: 5_000,
}

function credentialRead() {
  let resolve!: (key: string | undefined) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string | undefined>((yes, no) => { resolve = yes; reject = no })
  const read = vi.fn(() => promise)
  return { read, resolve, reject }
}

function observe<T>(operation: Promise<T>) {
  const settled: { value?: T; error?: unknown; done: boolean } = { done: false }
  void operation.then(
    (value) => { settled.value = value; settled.done = true },
    (error: unknown) => { settled.error = error; settled.done = true },
  )
  return settled
}

function successfulResponse(): Response {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer.', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }] }],
  })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('xAI credential waiting', () => {
  it.each(['caller', 'timeout'] as const)('ends a never-settling read on %s cancellation', async (kind) => {
    const credential = credentialRead()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    const provider = new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read }))
    const listeners = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const result = observe(provider.search({ query: 'q' }, controller.signal))
    expect(credential.read).toHaveBeenCalledOnce()
    if (kind === 'caller') controller.abort(new Error('stop'))
    await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs)
    expect(result.done).toBe(true)
    expect(result.error).toMatchObject({ code: kind === 'caller' ? 'WEB_ABORTED' : 'WEB_TIMEOUT' })
    expect(fetch).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(listeners).toHaveBeenCalledOnce()
    const operationSignal = listeners.mock.contexts[0]
    assert(operationSignal instanceof AbortSignal)
    expect(getEventListeners(operationSignal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['caller', 'resolve'], ['caller', 'reject'], ['timeout', 'resolve'], ['timeout', 'reject'],
  ] as const)('ignores late credential %s/%s without dispatch or unhandled rejection', async (kind, settlement) => {
    const credential = credentialRead()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const controller = new AbortController()
      const result = observe(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }, controller.signal))
      if (kind === 'caller') controller.abort(new Error('stop'))
      await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs)
      expect(result.done).toBe(true)
      const cancellation = result.error
      if (settlement === 'resolve') credential.resolve('late-key')
      else credential.reject(new Error('late store failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect(result.error).toBe(cancellation)
      expect(fetch).not.toHaveBeenCalled()
      expect(unhandled).not.toHaveBeenCalled()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('never starts the resolver for an already cancelled caller', async () => {
    const credential = credentialRead()
    const controller = new AbortController()
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
    expect(credential.read).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['caller', 'timeout'] as const)('keeps the first %s cancellation while credentials remain pending', async (first) => {
    const credential = credentialRead()
    const controller = new AbortController()
    const reason = new Error('caller stop')
    const result = observe(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }, controller.signal))
    if (first === 'caller') controller.abort(reason)
    await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs)
    if (first === 'timeout') controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.done).toBe(true)
    expect(result.error).toMatchObject({ code: first === 'caller' ? 'WEB_ABORTED' : 'WEB_TIMEOUT' })
    if (first === 'caller') expect(result.error).toHaveProperty('cause', reason)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('spends the same deadline on credentials and the HTTP request', async () => {
    const credential = credentialRead()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('fetch aborted')) }, { once: true })
    }))
    const result = observe(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }))
    await vi.advanceTimersByTimeAsync(4_000)
    credential.resolve('key')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(result.done).toBe(true)
    expect(result.error).toMatchObject({ code: 'WEB_TIMEOUT' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not dispatch if cancellation wins the credential continuation', async () => {
    const credential = credentialRead()
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const result = observe(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }, controller.signal))
    credential.resolve('key')
    controller.abort(new Error('stop'))
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('observes rejection when the resolver cancels before returning its promise', async () => {
    const reason = new Error('stop')
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const operation = new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: () => {
      controller.abort(reason)
      return Promise.reject(new Error('late failure'))
    } })).search({ query: 'q' }, controller.signal)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('continues with the resolved key and removes the cancellation listener', async () => {
    const credential = credentialRead()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(successfulResponse())
    const controller = new AbortController()
    const listeners = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const operation = new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: credential.read })).search({ query: 'q' }, controller.signal)
    credential.resolve('resolved-key')
    await expect(operation).resolves.toMatchObject({ sources: [{ url: 'https://a.test/' }] })
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer resolved-key' })
    expect(listeners).toHaveBeenCalledOnce()
    const operationSignal = listeners.mock.contexts[0]
    assert(operationSignal instanceof AbortSignal)
    expect(getEventListeners(operationSignal, 'abort')).toHaveLength(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['missing', 'rejection', 'throw'] as const)('retains %s credential diagnostics and disposes the deadline', async (kind) => {
    const failure = new Error('store down')
    const resolveApiKey = (): Promise<string | undefined> => {
      if (kind === 'throw') throw failure
      return kind === 'missing' ? Promise.resolve(undefined) : Promise.reject(failure)
    }
    const fetch = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    await expect(new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey })).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({
      code: kind === 'missing' ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR',
      ...(kind === 'missing' ? {} : { cause: failure }),
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
