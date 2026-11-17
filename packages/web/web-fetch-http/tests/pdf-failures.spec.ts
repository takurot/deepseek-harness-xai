/** Provider error mapping for PDF extraction bridge failures, with a scripted extraction bridge. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { corruptPdfBytes } from './fixtures/pdf.ts'

type Mode = 'abort' | 'timeout' | 'worker-failure' | 'unavailable' | 'engine-failure'

const state = vi.hoisted(() => ({ mode: 'worker-failure' as Mode, controller: undefined as AbortController | undefined }))

vi.mock('../src/pdf-thread.ts', async () => {
  const { PdfEngineLoadError, PdfExtractionUnavailableError } = await import('../src/pdf-errors.ts')
  return {
    extractPdfInWorker: async () => {
      if (state.mode === 'engine-failure') {
        throw new PdfEngineLoadError('PDF extraction engine failed to load: bad module')
      }
      if (state.mode === 'unavailable') {
        throw new PdfExtractionUnavailableError('PDF extraction is not included in this packaged runtime')
      }
      if (state.mode === 'abort') {
        state.controller?.abort(new Error('aborted by test'))
        throw new Error('aborted by test')
      }
      if (state.mode === 'timeout') {
        await new Promise(resolve => setTimeout(resolve, 200))
        throw new Error('late extraction failure')
      }
      throw new Error('worker crashed')
    },
  }
})

const { WebError } = await import('@deepseek-ai/dsh-web')

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  maxPdfPages: 10,
  userAgent: 'test-agent/1.0',
}

let server: Server
let base: string

beforeEach(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    res.end(Buffer.from(corruptPdfBytes()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  state.controller = undefined
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

describe('PDF extraction bridge failures', () => {
  it('maps a packaged runtime without PDF extraction to WEB_PDF_UNAVAILABLE with an actionable message', async () => {
    state.mode = 'unavailable'
    await expect(new HttpFetchProvider(limits).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PDF_UNAVAILABLE',
        message: 'this packaged runtime does not include PDF extraction; use the Node or desktop distribution',
      }))
  })

  it('maps an engine load failure to WEB_PROVIDER_ERROR with the engine message', async () => {
    state.mode = 'engine-failure'
    await expect(new HttpFetchProvider(limits).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'PDF extraction engine failed to load: bad module',
      }))
  })

  it('maps a bridge failure to WEB_PROVIDER_ERROR', async () => {
    state.mode = 'worker-failure'
    await expect(new HttpFetchProvider(limits).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort observed by the extraction bridge to WEB_ABORTED', async () => {
    state.mode = 'abort'
    const controller = new AbortController()
    state.controller = controller
    await expect(new HttpFetchProvider(limits).fetch({ url: base }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps the provider deadline during extraction to WEB_FETCH_TIMEOUT', async () => {
    state.mode = 'timeout'
    await expect(new HttpFetchProvider({ ...limits, timeoutMs: 5 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('keeps WebError identity for both mapped failures', async () => {
    state.mode = 'worker-failure'
    await expect(new HttpFetchProvider(limits).fetch({ url: base }))
      .rejects.toBeInstanceOf(WebError)
  })
})
