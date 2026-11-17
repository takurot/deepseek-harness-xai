/** Worker lifecycle of PDF text extraction, with a scripted Worker. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const workers: FakeWorker[] = []

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(() => Promise.resolve(0))
  constructor(readonly entry: URL, readonly options: { workerData: unknown; transferList: unknown[] }) {
    super()
    workers.push(this)
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))

const { extractPdfInWorker, PdfDocumentError } = await import('../src/pdf-thread.ts')

afterEach(() => { workers.length = 0 })

const LIMITS = { maxPages: 5, maxChars: 1000 }
const EXTRACTION = { ok: true, pageCount: 2, pagesExtracted: 1, content: 'page text', truncated: false }

function start(signal = new AbortController().signal) {
  const data = new Uint8Array([1, 2, 3])
  const result = extractPdfInWorker(data, LIMITS, signal)
  const worker = workers.at(-1) as FakeWorker
  return { data, result, worker }
}

it('transfers the document, resolves with the extraction, and terminates the Worker', async () => {
  const { data, result, worker } = start()
  expect(worker.options.workerData).toEqual({ data, ...LIMITS })
  expect(worker.options.transferList).toEqual([data.buffer])
  worker.emit('message', EXTRACTION)
  worker.emit('exit', 1)
  await expect(result).resolves.toEqual({
    ok: true, pageCount: 2, pagesExtracted: 1, content: 'page text', truncated: false,
  })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('settles when termination fails', async () => {
  const { result, worker } = start()
  worker.terminate.mockImplementationOnce(() => Promise.reject(new Error('stuck')))
  worker.emit('message', EXTRACTION)
  await expect(result).resolves.toMatchObject({ content: 'page text' })
})

it('spawns the source entry through an in-Worker TypeScript loader registration', () => {
  const { worker } = start()
  expect(worker.entry.protocol).toBe('data:')
  expect(decodeURIComponent(worker.entry.href)).toContain('/src/worker.ts')
  expect(worker.options).toMatchObject({ execArgv: [] })
})

it('reports a Worker-reported extraction failure as a document error', async () => {
  const { result, worker } = start()
  worker.emit('message', { ok: false, message: 'Invalid PDF structure' })
  await expect(result).rejects.toBeInstanceOf(PdfDocumentError)
  await expect(result).rejects.toThrow('Invalid PDF structure')
})

it('reports a password-protected document as a document error naming the password', async () => {
  const { result, worker } = start()
  worker.emit('message', { ok: false, message: 'No password given' })
  await expect(result).rejects.toBeInstanceOf(PdfDocumentError)
  await expect(result).rejects.toThrow('No password given')
})

it.each([
  null,
  { pageCount: 2 },
  { ok: true },
  { ok: true, pageCount: 2, pagesExtracted: 1, content: 'x' },
  { ok: true, pageCount: -1, pagesExtracted: 1, content: 'x', truncated: false },
  { ok: true, pageCount: 2, pagesExtracted: 0, content: 'x', truncated: false },
  { ok: true, pageCount: 2, pagesExtracted: 3, content: 'x', truncated: false },
  { ok: true, pageCount: 2, pagesExtracted: 1, content: 1, truncated: false },
  { ok: true, pageCount: 2, pagesExtracted: 1, content: 'x', truncated: 'no' },
  { ok: false },
  { ok: false, message: 42 },
])('refuses the Worker message %j', async (message) => {
  const { result, worker } = start()
  worker.emit('message', message)
  await expect(result).rejects.toThrow('PDF extractor reported an unexpected value')
})

it('rejects when the Worker fails or exits without a result', async () => {
  const failing = start()
  failing.worker.emit('error', new Error('crashed'))
  await expect(failing.result).rejects.toThrow('crashed')
  const exiting = start()
  exiting.worker.emit('exit', 3)
  await expect(exiting.result).rejects.toThrow('PDF extractor exited before reporting a result (code 3)')
})

it('terminates the Worker on abort and refuses an aborted signal', async () => {
  const controller = new AbortController()
  const { result, worker } = start(controller.signal)
  controller.abort(new Error('disposed'))
  await expect(result).rejects.toThrow('disposed')
  // Termination publishes the Worker exit that releases the abort listener.
  worker.emit('exit', 0)
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(extractPdfInWorker(new Uint8Array([1]), LIMITS, controller.signal)).rejects.toThrow('disposed')
})
