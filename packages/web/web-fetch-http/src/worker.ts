/** Worker Thread entry that extracts one PDF document's text and posts the result to its parent. */
import { parentPort, workerData } from 'node:worker_threads'
import { extractPdfText, type PdfExtractionLimits } from './pdf-extract.ts'
import { PdfEngineLoadError, PdfExtractionUnavailableError } from './pdf-errors.ts'

interface PdfWorkerRequest extends PdfExtractionLimits {
  readonly data: Uint8Array
}

const request = workerData as Partial<PdfWorkerRequest> | null

/** Whether the parent supplied the complete transferable request. */
function isRequest(value: Partial<PdfWorkerRequest> | null): value is PdfWorkerRequest {
  return typeof value === 'object' && value !== null
    && value.data instanceof Uint8Array
    && Number.isInteger(value.maxPages) && (value.maxPages as number) > 0
    && Number.isInteger(value.maxChars) && (value.maxChars as number) > 0
}

/** Extract the document and report either its text or the PDF.js failure message. */
async function extractAndReport(value: PdfWorkerRequest): Promise<void> {
  try {
    parentPort?.postMessage({
      ok: true,
      ...await extractPdfText(value.data, { maxPages: value.maxPages, maxChars: value.maxChars }),
    })
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      code: error instanceof PdfExtractionUnavailableError ? 'unavailable'
        : error instanceof PdfEngineLoadError ? 'engine' : 'document',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

// A malformed request throws at module scope, which the parent observes as a
// Worker error rather than a document failure.
if (!isRequest(request)) throw new Error('PDF extractor request is malformed')
void extractAndReport(request)
