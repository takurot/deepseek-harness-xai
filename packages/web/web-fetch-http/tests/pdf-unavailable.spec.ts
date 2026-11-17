import { describe, expect, it, vi } from 'vitest'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url)
      require.resolve = () => {
        throw Object.assign(new Error("Cannot find package 'pdfjs-dist'"), { code: 'ERR_MODULE_NOT_FOUND' })
      }
      return require
    },
  }
})

const { extractPdfText } = await import('../src/pdf-extract.ts')
const { PdfExtractionUnavailableError } = await import('../src/pdf-errors.ts')
const { corruptPdfBytes } = await import('./fixtures/pdf.ts')

describe('PDF extraction in a build without the engine', () => {
  it('rejects with the typed unavailable error and keeps the resolution failure as its cause', async () => {
    const error = await extractPdfText(corruptPdfBytes(), { maxPages: 5, maxChars: 1000 }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(PdfExtractionUnavailableError)
    expect((error as Error).cause).toBeInstanceOf(Error)
  })
})
