import { once } from 'node:events'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as xaiPlugin from '../src/index.ts'
import { XaiSearchProvider } from '../src/provider.ts'

const encoder = new TextEncoder()

function answer(text = 'a'): string {
  return JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{
      type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://a.test/' }],
    }] }],
  })
}

function options(maxResponseBytes = 5_000_000, maxOutputTokens = 128_000) {
  return {
    apiKey: 'test-key', baseURL: 'https://xai.test/v1', model: 'grok-test',
    sources: ['web'] as const, timeoutMs: 5_000, maxResponseBytes, maxOutputTokens,
  }
}

function streamed(chunks: readonly Uint8Array[], status = 200, headers: HeadersInit = {}, cancel = vi.fn<() => void | Promise<void>>()) {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
    cancel,
  }, { highWaterMark: 0 })
  return { response: new Response(body, { status, headers }), body, cancel }
}

async function expectOverflow(response: Response, maxResponseBytes: number): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  await expect(new XaiSearchProvider(() => options(maxResponseBytes)).search({ query: 'q' }))
    .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/(?:size|bytes|limit|exceed)/iu) })
}

afterEach(() => { vi.restoreAllMocks() })

describe('xAI response byte budget', () => {
  it.each([1, 16])('rejects a valid answer under a tiny %i byte budget', async (limit) => {
    await expectOverflow(new Response(answer()), limit)
  })

  it('accepts exactly the byte budget after reading through EOF', async () => {
    const bytes = encoder.encode(answer())
    const fixture = streamed([bytes])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fixture.response)
    await expect(new XaiSearchProvider(() => options(bytes.byteLength)).search({ query: 'q' }))
      .resolves.toMatchObject({ content: 'a', truncated: false })
    expect(fixture.body.locked).toBe(false)
    expect(fixture.cancel).not.toHaveBeenCalled()
  })

  it('rejects the byte after an otherwise complete JSON value at the budget', async () => {
    const bytes = encoder.encode(answer())
    await expectOverflow(streamed([bytes, encoder.encode(' ')]).response, bytes.byteLength)
  })

  it('cancels an oversized single chunk and releases the stream', async () => {
    const bytes = encoder.encode(answer())
    const fixture = streamed([bytes])
    await expectOverflow(fixture.response, bytes.byteLength - 1)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.body.locked).toBe(false)
  })

  it('counts cumulative bytes across chunks', async () => {
    const bytes = encoder.encode(answer())
    const fixture = streamed([bytes.subarray(0, 20), bytes.subarray(20, 40), bytes.subarray(40)])
    await expectOverflow(fixture.response, bytes.byteLength - 1)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.body.locked).toBe(false)
  })

  it('decodes UTF-8 split inside a multibyte character at the exact byte budget', async () => {
    const text = answer('日本語')
    const bytes = encoder.encode(text)
    const split = encoder.encode(text.slice(0, text.indexOf('日'))).byteLength + 1
    const fixture = streamed([bytes.subarray(0, split), bytes.subarray(split)])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fixture.response)
    await expect(new XaiSearchProvider(() => options(bytes.byteLength)).search({ query: 'q' }))
      .resolves.toMatchObject({ content: '日本語' })
  })

  it('counts UTF-8 bytes rather than string characters', async () => {
    const text = answer('日本語')
    await expectOverflow(new Response(text), text.length)
  })

  it.each(['0', '1'])('ignores an understated Content-Length of %s', async (contentLength) => {
    await expectOverflow(new Response(answer(), { headers: { 'content-length': contentLength } }), 16)
  })

  it('accepts a bounded decompressed body despite a larger Content-Length', async () => {
    const bytes = encoder.encode(answer())
    const fixture = streamed([bytes], 200, { 'content-length': '999999999', 'content-encoding': 'gzip' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fixture.response)
    await expect(new XaiSearchProvider(() => options(bytes.byteLength)).search({ query: 'q' }))
      .resolves.toMatchObject({ content: 'a' })
  })

  it('counts the decompressed bytes of a real gzip HTTP response', async () => {
    const text = answer('x'.repeat(1_000))
    const bytes = encoder.encode(text)
    const compressed = gzipSync(bytes)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.byteLength })
      response.end(compressed)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const baseURL = `http://127.0.0.1:${String(address.port)}`
    try {
      await expect(new XaiSearchProvider(() => ({ ...options(bytes.byteLength), baseURL })).search({ query: 'q' }))
        .resolves.toMatchObject({ content: 'x'.repeat(1_000) })
      await expect(new XaiSearchProvider(() => ({ ...options(compressed.byteLength), baseURL })).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/byte limit/u) })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error) }) })
    }
  })

  it('rejects a null success body as a provider error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
    await expect(new XaiSearchProvider(() => options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('rejects a truncated JSON body within the byte budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(answer().slice(0, -1)))
    await expect(new XaiSearchProvider(() => options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('rejects a failed body read and releases the stream', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('connection lost') } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    await expect(new XaiSearchProvider(() => options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(body.locked).toBe(false)
  })

  it.each([401, 429])('applies the same byte budget to HTTP %i error bodies', async (status) => {
    const fixture = streamed([encoder.encode(JSON.stringify({ error: { message: 'x'.repeat(100) } }))], status)
    await expectOverflow(fixture.response, 16)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.body.locked).toBe(false)
  })

  it.each([401, 429])('preserves HTTP %i classification for a bounded error body', async (status) => {
    const text = JSON.stringify({ error: { message: 'denied' } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(text, { status }))
    await expect(new XaiSearchProvider(() => options(encoder.encode(text).byteLength)).search({ query: 'q' }))
      .rejects.toMatchObject({ code: status === 401 ? 'WEB_PROVIDER_AUTH_FAILED' : 'WEB_PROVIDER_RATE_LIMITED' })
  })

  it.each(['throw', 'reject', 'pending'] as const)('preserves overflow when stream cancellation is %s', async (behavior) => {
    const cancel = vi.fn<() => void | Promise<void>>(() => {
      if (behavior === 'throw') throw new Error('cancel failed')
      return behavior === 'reject' ? Promise.reject(new Error('cancel failed')) : new Promise<void>(() => {})
    })
    const fixture = streamed([encoder.encode(answer())], 200, undefined, cancel)
    await expectOverflow(fixture.response, 16)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fixture.body.locked).toBe(false)
  }, 1_000)

  it.each([200, 401])('bounds a pending HTTP %i read even when cancellation never settles', async (status) => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }))
    try {
      const pending = new XaiSearchProvider(() => options()).search({ query: 'q' }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toMatchObject({ code: 'WEB_TIMEOUT' })
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each([401, 429])('preserves HTTP %i taxonomy for an empty error body', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
    await expect(new XaiSearchProvider(() => options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: status === 401 ? 'WEB_PROVIDER_AUTH_FAILED' : 'WEB_PROVIDER_RATE_LIMITED' })
  })

  it('keeps an incomplete provider response distinct from byte overflow', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    })))
    await expect(new XaiSearchProvider(() => options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/incomplete/iu) })
  })
})

describe('xAI output budget configuration', () => {
  it.each(['maxResponseBytes', 'maxOutputTokens'] as const)('available rejects invalid %s budgets', (field) => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(new XaiSearchProvider(() => ({ ...options(), [field]: value })).available()).toBe(false)
    }
    expect(new XaiSearchProvider(() => ({ ...options(), [field]: Number.MAX_SAFE_INTEGER })).available()).toBe(true)
  })

  it('sends the configured visible output token budget', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(answer()))
    await new XaiSearchProvider(() => options(5_000_000, 42)).search({ query: 'q' })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ max_output_tokens: 42 })
  })

  it('snapshots both budgets before awaiting credentials', async () => {
    let release!: (value: string) => void
    const credential = new Promise<string>((resolve) => { release = resolve })
    const { apiKey: _literalKey, ...withoutKey } = options(16, 42)
    let configured = { ...withoutKey, resolveApiKey: () => credential }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(answer())))
    const provider = new XaiSearchProvider(() => configured)
    const pending = provider.search({ query: 'first' })
    configured = { ...configured, maxResponseBytes: 5_000_000, maxOutputTokens: 84 }
    release('test-key')
    await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(provider.search({ query: 'second' })).resolves.toMatchObject({ content: 'a' })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ max_output_tokens: 42 })
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ max_output_tokens: 84 })
  })

  it('applies the default token budget through plugin configuration', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(xaiPlugin, { apiKey: 'test-key' })
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(answer()))
      await ctx.web.search({ query: 'q' })
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ max_output_tokens: 128_000 })
    } finally { await ctx.fiber.dispose() }
  })

  it('passes both configured budgets through the registered provider', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(xaiPlugin, { apiKey: 'test-key', maxResponseBytes: 16, maxOutputTokens: 42 })
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(answer()))
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ max_output_tokens: 42 })
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['maxResponseBytes', 'maxOutputTokens'])('rejects invalid %s values at plugin load', async (field) => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, {})
        await expect(ctx.plugin(xaiPlugin, { apiKey: 'test-key', [field]: value })).rejects.toThrow()
      } finally { await ctx.fiber.dispose() }
    }
  })
})
