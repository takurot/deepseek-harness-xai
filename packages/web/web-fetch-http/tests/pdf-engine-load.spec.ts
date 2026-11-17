import { describe, expect, it, vi } from 'vitest'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url)
      require.resolve = () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return require
    },
  }
})

const { extractPdfText } = await import('../src/pdf-extract.ts')
const { PdfEngineLoadError } = await import('../src/pdf-errors.ts')
const { corruptPdfBytes } = await import('./fixtures/pdf.ts')

describe('PDF extraction when the installed engine cannot load', () => {
  it('reports an engine failure with an Error cause, not an unavailable runtime', async () => {
    const error = await extractPdfText(corruptPdfBytes(), { maxPages: 5, maxChars: 1000 }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(PdfEngineLoadError)
    expect((error as Error).message).toContain('permission denied')
    expect((error as Error).cause).toBeInstanceOf(Error)
  })
})
