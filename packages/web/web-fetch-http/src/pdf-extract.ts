/**
 * PDF text extraction through PDF.js, isolated in a Worker Thread by `pdf-thread.ts`.
 * The module bounds the page count and the joined character count so a hostile document
 * cannot multiply the returned text, and it resolves PDF.js's own CMap, standard-font, and
 * WebAssembly assets from the installed package instead of fetching them.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/pdf-extract
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { WEB_FETCH_PDF_PAGE_SEPARATOR } from '@deepseek-ai/dsh-web'
import { PdfEngineLoadError, PdfExtractionUnavailableError } from './pdf-errors.ts'

/** One extraction's bounds, applied to the joined page text. */
export interface PdfExtractionLimits {
  /** Maximum pages read from the document, counting from page 1. */
  readonly maxPages: number
  /** Maximum characters in the returned content, page separators included. */
  readonly maxChars: number
}

/** The extraction engine, loaded on first use so a packaged build without it can report a typed failure. */
let engine: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined

/** Load PDF.js once; a build that omits the dependency fails with {@link PdfExtractionUnavailableError}. */
function loadEngine(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  engine ??= initializeEngine()
  return engine
}

/** Resolve the installed package, then load it; absence and breakage are distinct failures. */
async function initializeEngine(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  try {
    createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
  } catch (error: unknown) {
    /* v8 ignore next -- the packaged runtime omits the package; its classification is unit-tested below. */
    throw engineLoadError(error)
  }
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (error: unknown) {
    /* v8 ignore next -- an installed engine whose import itself rejects needs a corrupt package. */
    throw engineLoadFailure(error)
  }
}

/**
 * Classify a failed engine resolution: an absent package is the packaged build
 * without the feature, while any other failure is a broken installed engine.
 *
 * @param error - the rejection from resolving or importing PDF.js.
 * @returns the typed missing-engine or broken-engine error, preserving the cause.
 */
export function engineLoadError(error: unknown): PdfExtractionUnavailableError | PdfEngineLoadError {
  if (isResolutionFailure(error)) {
    return new PdfExtractionUnavailableError('PDF extraction is not included in this packaged runtime', { cause: error })
  }
  return engineLoadFailure(error)
}

/** Whether resolving the package failed because it is not installed. */
function isResolutionFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
}

/** Wrap an installed-but-broken engine failure with the original cause. */
function engineLoadFailure(error: unknown): PdfEngineLoadError {
  return new PdfEngineLoadError(
    `PDF extraction engine failed to load: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}

/** Extracted PDF text with the page accounting the seam exposes. */
export interface PdfExtraction {
  /** Total pages in the document. */
  readonly pageCount: number
  /** Pages whose text is represented in `content`; zero only for an empty document. */
  readonly pagesExtracted: number
  /** Page text joined by {@link WEB_FETCH_PDF_PAGE_SEPARATOR}; an empty page contributes an empty span. */
  readonly content: string
  /** True when the page limit, the character limit, or both cut the document. */
  readonly truncated: boolean
}

/** Absolute PDF.js asset directories, with the trailing slash PDF.js requires. */
function assetDirectories(): { cMapUrl: string; standardFontDataUrl: string; wasmUrl: string } {
  const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  return {
    cMapUrl: `${join(packageRoot, 'cmaps')}/`,
    standardFontDataUrl: `${join(packageRoot, 'standard_fonts')}/`,
    wasmUrl: `${join(packageRoot, 'wasm')}/`,
  }
}

/**
 * Read a page's text items, keeping PDF.js's line breaks. Items that end a line
 * become one normalized line each; remaining items on the same baseline join
 * with a single space. Text-free pages yield an empty string.
 */
async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  const lines: string[] = []
  let line = ''
  for (const item of content.items) {
    /* v8 ignore next -- PDF.js reports marked-content markers without text; this extraction path ignores them. */
    if (!('str' in item)) continue
    line += item.str
    if (item.hasEOL) {
      lines.push(line)
      line = ''
    } else {
      line += ' '
    }
  }
  lines.push(line)
  return lines
    .map(text => text.replace(/\f/g, ' ').replace(/[\t ]+/g, ' ').trim())
    .filter(text => text !== '')
    .join('\n')
}

/**
 * Extract bounded page text from one PDF document.
 *
 * The returned content holds at most `maxPages` pages and at most `maxChars`
 * characters; a page that crosses the character limit contributes its fitting
 * prefix, and an empty page contributes an empty span. Extraction failures
 * (corrupt, encrypted, or unsupported documents) reject with PDF.js's error;
 * the provider translates them into a `WebError`.
 *
 * @param data - the complete PDF bytes; the document is parsed in this process.
 * @param limits - page and character bounds for the returned content.
 * @returns the extracted page text and its page accounting.
 */
export async function extractPdfText(data: Uint8Array, limits: PdfExtractionLimits): Promise<PdfExtraction> {
  const { getDocument } = await loadEngine()
  const loadingTask = getDocument({
    data,
    useWorkerFetch: false,
    disableFontFace: true,
    stopAtErrors: true,
    cMapPacked: true,
    // Untrusted documents must not print PDF.js warnings into the Host log.
    verbosity: 0,
    ...assetDirectories(),
  })
  try {
    const document = await loadingTask.promise
    return await extractPages(document, limits)
  } finally {
    /* v8 ignore next 4 -- the extracted text is already decided and the caller terminates the Worker that owns the document. */
    await loadingTask.destroy().catch((_error: unknown) => {
      // A teardown failure cannot change the extracted text or the page accounting.
    })
  }
}

/** Read pages up to the page and character limits, accounting for separators. */
async function extractPages(document: PDFDocumentProxy, limits: PdfExtractionLimits): Promise<PdfExtraction> {
  const pageCount = document.numPages
  const pageLimit = Math.min(pageCount, limits.maxPages)
  const pages: string[] = []
  let total = 0
  let truncated = pageLimit < pageCount
  for (let number = 1; number <= pageLimit; number++) {
    const page = await document.getPage(number)
    const text = await pageText(page).finally(() => { page.cleanup() })
    const separator = pages.length > 0 ? WEB_FETCH_PDF_PAGE_SEPARATOR.length : 0
    const remaining = limits.maxChars - total - separator
    if (text.length > remaining) {
      if (remaining > 0) pages.push(text.slice(0, remaining))
      truncated = true
      break
    }
    pages.push(text)
    total += separator + text.length
  }
  return { pageCount, pagesExtracted: pages.length, content: pages.join(WEB_FETCH_PDF_PAGE_SEPARATOR), truncated }
}
