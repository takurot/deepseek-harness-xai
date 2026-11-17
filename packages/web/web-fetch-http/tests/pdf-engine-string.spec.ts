import { describe, expect, it, vi } from 'vitest'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url)
      require.resolve = () => { throw 'denied as a plain string' }
      return require
    },
  }
})

const { extractPdfText } = await import('../src/pdf-extract.ts')
const { PdfEngineLoadError } = await import('../src/pdf-errors.ts')
const { corruptPdfBytes } = await import('./fixtures/pdf.ts')

describe('PDF extraction when engine resolution throws a non-Error', () => {
  it('stringifies the rejection without losing it', async () => {
    const error = await extractPdfText(corruptPdfBytes(), { maxPages: 5, maxChars: 1000 }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(PdfEngineLoadError)
    expect((error as Error).message).toContain('denied as a plain string')
  })
})
