/** Runs PDF.js text extraction in a fresh Worker Thread, so a hostile document cannot block the Host event loop. */
import { Worker } from 'node:worker_threads'
import type { PdfExtraction, PdfExtractionLimits } from './pdf-extract.ts'

/** What the Worker receives: the complete document and its bounds. */
interface PdfWorkerRequest extends PdfExtractionLimits {
  readonly data: Uint8Array
}

/** A Worker-reported PDF.js rejection: the document itself could not be extracted. */
export class PdfDocumentError extends Error {}

/** This build does not include the PDF extraction engine. */
export class PdfExtractionUnavailableError extends Error {}

/**
 * The Worker entry and its loader arguments: the bundled sibling in a built
 * package, or a data: URL that registers the TypeScript loader before importing
 * the source entry. The bootstrap resolves `tsx` from this module, so a Worker
 * never depends on a profile or working directory that cannot see it.
 */
function workerSpawn(): { readonly entry: URL; readonly execArgv: string[] } {
  /* v8 ignore next 2 -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return { entry: new URL('./pdf-worker.js', import.meta.url), execArgv: [] }
  const register = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();`
  const source = new URL('./worker.ts', import.meta.url).href
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(`${register} await import(${JSON.stringify(source)})`)}`),
    execArgv: [],
  }
}

/** Whether a Worker message carries a complete extraction. */
function isExtraction(value: unknown): value is PdfExtraction {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Partial<PdfExtraction> & { readonly ok?: unknown }
  return result.ok === true
    && typeof result.pageCount === 'number' && Number.isInteger(result.pageCount) && result.pageCount >= 0
    && typeof result.pagesExtracted === 'number' && Number.isInteger(result.pagesExtracted)
    && result.pagesExtracted >= 1 && result.pagesExtracted <= result.pageCount
    && typeof result.content === 'string'
    && typeof result.truncated === 'boolean'
}

/** Whether a Worker message reports a PDF.js rejection or a missing engine. */
function isDocumentFailure(value: unknown): value is { readonly ok: false; readonly message: string; readonly code?: string } {
  return typeof value === 'object' && value !== null
    && 'ok' in value && value.ok === false
    && 'message' in value && typeof value.message === 'string'
}

/** Settle with the Worker's first result, report, or failure. */
function workerOutcome(worker: Worker): Promise<PdfExtraction> {
  return new Promise((resolve, reject) => {
    worker.once('message', (value: unknown) => {
      if (isDocumentFailure(value)) {
        reject(value.code === 'unavailable' ? new PdfExtractionUnavailableError(value.message) : new PdfDocumentError(value.message))
      }
      else if (isExtraction(value)) resolve(value)
      else reject(new Error('PDF extractor reported an unexpected value'))
    })
    worker.once('error', (error) => { reject(error) })
    worker.once('exit', (code) => { reject(new Error(`PDF extractor exited before reporting a result (code ${String(code)})`)) })
  })
}

/**
 * Extract PDF text in a fresh Worker Thread. The bytes' buffer is transferred to
 * the Worker and is unusable afterwards; the extraction is copied back by
 * structured clone. Every outcome terminates the Worker.
 *
 * A Worker-reported PDF.js rejection rejects with {@link PdfDocumentError}, so
 * the provider can distinguish an unreadable document from a broken Worker and
 * report the matching `WebError` code. Worker failures (spawn, crash, exit,
 * malformed message) reject with an ordinary `Error`.
 *
 * @param data - the complete PDF bytes, owning its whole buffer.
 * @param limits - page and character bounds forwarded to the Worker.
 * @param signal - terminates the Worker and rejects with the signal's reason.
 * @returns the Worker's extraction.
 * @throws the abort reason, {@link PdfDocumentError}, or an Error when the
 *   Worker fails, exits without a result, or reports an unexpected value.
 */
export async function extractPdfInWorker(data: Uint8Array, limits: PdfExtractionLimits, signal: AbortSignal): Promise<PdfExtraction> {
  signal.throwIfAborted()
  const request: PdfWorkerRequest = { data, ...limits }
  const { entry, execArgv } = workerSpawn()
  const worker = new Worker(entry, {
    workerData: request,
    transferList: [data.buffer as ArrayBuffer],
    execArgv,
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason as Error) }
    signal.addEventListener('abort', onAbort, { once: true })
    worker.once('exit', () => { signal.removeEventListener('abort', onAbort) })
  })
  try {
    return await Promise.race([workerOutcome(worker), aborted])
  } finally {
    await worker.terminate().catch((_error: unknown) => {
      // Termination is cleanup; the outcome already settled.
    })
  }
}
