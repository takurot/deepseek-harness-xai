import { describe, expect, it, vi } from 'vitest'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  throw new Error("Cannot find package 'pdfjs-dist'")
})

const { extractPdfText, PdfExtractionUnavailableError } = await import('../src/pdf-extract.ts')
const { corruptPdfBytes } = await import('./fixtures/pdf.ts')

describe('PDF extraction in a build without the engine', () => {
  it('rejects with the typed unavailable error instead of a document failure', async () => {
    await expect(extractPdfText(corruptPdfBytes(), { maxPages: 5, maxChars: 1000 }))
      .rejects.toBeInstanceOf(PdfExtractionUnavailableError)
  })
})
