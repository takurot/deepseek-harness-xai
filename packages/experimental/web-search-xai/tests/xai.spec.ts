import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { WebError } from '@deepseek-ai/dsh-web'
import { XaiSearchProvider, mapXaiResponse } from '../src/provider.ts'
import type { XaiResponse, XaiSearchProviderOptions } from '../src/provider.ts'

const OPTIONS: XaiSearchProviderOptions = {
  baseURL: 'https://xai.test/v1',
  model: 'grok-test',
  sources: ['web'],
  timeoutMs: 5_000,
  resolveApiKey: () => Promise.resolve('xai-key'),
}

function answer(annotations: { type: string; url?: string; start_index?: number; end_index?: number; title?: string }[], text = 'The answer.'): XaiResponse {
  return {
    status: 'completed',
    output: [
      { type: 'web_search_call' },
      { type: 'message', content: [{ type: 'output_text', text, annotations }] },
    ],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function urlOf(input: RequestInfo | URL | undefined): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
}

function bodyOf(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : ''
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('mapXaiResponse', () => {
  it('maps the answer to content and url_citation annotations to deduped sources', () => {
    const result = mapXaiResponse(answer([
      { type: 'url_citation', url: 'https://a.test/', start_index: 0, end_index: 3, title: '1' },
      { type: 'url_citation', url: 'https://b.test/', start_index: 4, end_index: 7, title: '2' },
      { type: 'url_citation', url: 'https://a.test/', start_index: 8, end_index: 9, title: '3' },
    ]))
    expect(result.content).toBe('The answer.')
    expect(result.sources).toEqual([{ url: 'https://a.test/' }, { url: 'https://b.test/' }])
    expect(result.truncated).toBe(false)
  })

  it('joins several output_text blocks and ignores non-message output items', () => {
    const result = mapXaiResponse({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'one', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }] },
        { type: 'message', content: [{ type: 'output_text', text: 'two', annotations: [] }, { type: 'refusal' }] },
      ],
    })
    expect(result.content).toBe('one\n\ntwo')
    expect(result.sources).toEqual([{ url: 'https://a.test/' }])
  })

  it('fails with WEB_PROVIDER_ERROR when the response carries no structured citation', () => {
    expect(() => mapXaiResponse(answer([]))).toThrow(WebError)
    try { mapXaiResponse(answer([])) } catch (error) { expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR') }
    expect(() => mapXaiResponse({ status: 'completed', output: [] })).toThrow(/no cited sources/u)
  })

  it('does not scrape URLs out of the answer text', () => {
    expect(() => mapXaiResponse(answer([], 'see https://scraped.test/'))).toThrow(WebError)
  })
})

describe('XaiSearchProvider', () => {
  it('posts the query to /responses with the web_search tool and bearer key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([{ type: 'url_citation', url: 'https://a.test/' }])))
    const result = await new XaiSearchProvider(() => OPTIONS).search({ query: 'dsh harness' })
    expect(result.sources).toEqual([{ url: 'https://a.test/' }])
    const [url, init] = spy.mock.calls[0]!
    expect(urlOf(url)).toBe('https://xai.test/v1/responses')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xai-key')
    expect(init?.redirect).toBe('error')
    const body = JSON.parse(bodyOf(init?.body)) as { model: string; input: string; tools: unknown[] }
    expect(body.model).toBe('grok-test')
    expect(body.input).toContain('dsh harness')
    expect(body.tools).toEqual([{ type: 'web_search' }])
  })

  it('adds x_search when sources include x', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([{ type: 'url_citation', url: 'https://x.com/a' }])))
    await new XaiSearchProvider(() => ({ ...OPTIONS, sources: ['web', 'x'] })).search({ query: 'q' })
    const body = JSON.parse(bodyOf(spy.mock.calls[0]![1]?.body)) as { tools: unknown[] }
    expect(body.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }])
  })

  it('fails with WEB_PROVIDER_CREDENTIAL_MISSING and never fetches when no key resolves', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const provider = new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: () => Promise.resolve(undefined) }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('prefers a literal apiKey over the resolver', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([{ type: 'url_citation', url: 'https://a.test/' }])))
    await new XaiSearchProvider(() => ({ ...OPTIONS, apiKey: 'literal' })).search({ query: 'q' })
    expect((spy.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBe('Bearer literal')
  })

  it.each([
    [401, 'WEB_PROVIDER_AUTH_FAILED'],
    [403, 'WEB_PROVIDER_AUTH_FAILED'],
    [429, 'WEB_PROVIDER_RATE_LIMITED'],
    [500, 'WEB_PROVIDER_ERROR'],
  ])('maps HTTP %i to %s and surfaces the provider message', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'nope' } }, status))
    const failure = await new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WebError)
    expect((failure as WebError).code).toBe(code)
    expect((failure as WebError).message).toContain(`HTTP ${String(status)}`)
    expect((failure as WebError).message).toContain('nope')
  })

  it('keeps the status when the error body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gateway', { status: 502 }))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toThrow(/HTTP 502/u)
  })

  it('maps an unreadable success body to WEB_PROVIDER_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps a transport failure to WEB_PROVIDER_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('socket'))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('does not infer an operation timeout from an unrelated exception name', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('t', 'TimeoutError'))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it.each(['request', 200, 401, 403, 429, 500] as const)('reports its deadline during %s as WEB_TIMEOUT', async (phase) => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init!.signal!
      const pending = (): Promise<never> => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
      return phase === 'request' ? pending() : Promise.resolve(Object.assign(json({}, phase), { json: pending }))
    })
    const result = new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs)
    expect(await result).toMatchObject({ code: 'WEB_TIMEOUT', cause: { timeoutMs: OPTIONS.timeoutMs } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['request', 200, 401, 403, 429, 500] as const)('reports caller cancellation during %s as WEB_ABORTED', async (phase) => {
    const caller = new AbortController()
    const reason = new Error('caller stopped')
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const cancel = (): Promise<never> => {
        caller.abort(reason)
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      }
      return phase === 'request' ? cancel() : Promise.resolve(Object.assign(json({}, phase), { json: cancel }))
    })
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, caller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
  })

  it.each([true, false])('keeps the first cancellation reason when timeout wins: %s', async (timeoutFirst) => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const reason = new Error('caller stopped')
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => {
        setTimeout(() => { reject(new DOMException('aborted', 'AbortError')) }, OPTIONS.timeoutMs)
      }, { once: true })
    }))
    const result = new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, caller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(timeoutFirst ? OPTIONS.timeoutMs : 0)
    caller.abort(reason)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject(timeoutFirst ? { code: 'WEB_TIMEOUT' } : { code: 'WEB_ABORTED', cause: reason })
  })

  it.each(['OTHER_TIMEOUT', 'WEB_TIMEOUT', 'XAI_SEARCH_TIMEOUT'])('keeps caller TimeoutReason %s as WEB_ABORTED', async (code) => {
    const caller = new AbortController()
    const reason = new TimeoutReason(code, 1)
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      caller.abort(reason)
      return Promise.reject(reason)
    })
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, caller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
  })

  it.each([200, 401, 429, 500])('releases the deadline after HTTP %s completes', async (status) => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([{ type: 'url_citation', url: 'https://a.test/' }]), status))
    await new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }).catch(() => undefined)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('available() rejects delays that Node would clamp', () => {
    expect(new XaiSearchProvider(() => ({ ...OPTIONS, timeoutMs: MAX_TIMER_DELAY_MS })).available()).toBe(true)
    expect(new XaiSearchProvider(() => ({ ...OPTIONS, timeoutMs: MAX_TIMER_DELAY_MS + 1 })).available()).toBe(false)
  })

  it('passes a signal combining the caller and the timeout', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([{ type: 'url_citation', url: 'https://a.test/' }])))
    await new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, new AbortController().signal)
    expect(spy.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws WEB_ABORTED before any request when the signal is already aborted', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController(); controller.abort(new Error('stop'))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('maps a mid-request abort to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      controller.abort(new Error('stop'))
      return Promise.reject(new DOMException('a', 'AbortError'))
    })
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('available() requires a parseable endpoint and a credential source', () => {
    expect(new XaiSearchProvider(() => OPTIONS).available()).toBe(true)
    expect(new XaiSearchProvider(() => ({ ...OPTIONS, baseURL: 'not a url' })).available()).toBe(false)
    expect(new XaiSearchProvider(() => ({ ...OPTIONS, sources: [] })).available()).toBe(false)
  })

  it('wraps a failing credential resolver as WEB_PROVIDER_ERROR', async () => {
    const provider = new XaiSearchProvider(() => ({ ...OPTIONS, resolveApiKey: () => Promise.reject(new Error('store down')) }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('reports WEB_ABORTED when cancellation lands while the credential resolver runs', async () => {
    const controller = new AbortController()
    const provider = new XaiSearchProvider(() => ({
      ...OPTIONS,
      resolveApiKey: () => { controller.abort(new Error('stop')); return Promise.reject(new Error('late')) },
    }))
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('names the default credential reference when the options carry none', async () => {
    const provider = new XaiSearchProvider(() => { const { resolveApiKey: _omitted, ...bare } = OPTIONS; return bare })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/"XAI_API_KEY"/u)
  })

  it('maps an abort while reading an error body to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const failing = Object.assign(new Response('x', { status: 500 }), {
      json: () => { controller.abort(new Error('stop')); return Promise.reject(new DOMException('a', 'AbortError')) },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(failing)
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps an abort while reading the success body to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const reading = Object.assign(new Response('x', { status: 200 }), {
      json: () => { controller.abort(new Error('stop')); return Promise.reject(new DOMException('a', 'AbortError')) },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reading)
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reads a top-level error string and message field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'plain' }, 400)).mockResolvedValueOnce(json({ message: 'top' }, 400))
    const provider = new XaiSearchProvider(() => OPTIONS)
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/plain/u)
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/top/u)
  })

  it('passes the no-citation failure through search() unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(answer([])))
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toThrow(/no cited sources/u)
  })

  it('keeps the fetch abort as the cause when the caller supplied no signal', async () => {
    const abort = new DOMException('a', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)
    await expect(new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: abort })
  })

  it('available() rejects a non-positive timeout', () => {
    expect(new XaiSearchProvider(() => ({ ...OPTIONS, timeoutMs: 0 })).available()).toBe(false)
  })
})

describe('mapXaiResponse optional typed fields', () => {
  it('skips empty text, absent optional fields, and other annotation types', () => {
    const result = mapXaiResponse({
      status: 'completed',
      output: [
        { type: 'message' },
        { type: 'message', content: [
          { type: 'output_text' },
          { type: 'output_text', text: '', annotations: [
            { type: 'file_citation', url: 'https://skip.test/' },
            { type: 'url_citation' },
            { type: 'url_citation', url: '' },
            { type: 'url_citation', url: 'https://ok.test/' },
          ] },
        ] },
      ],
    })
    expect(result).toEqual({ content: '', sources: [{ url: 'https://ok.test/' }], truncated: false })
  })
})
