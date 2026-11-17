import { describe, expect, it } from 'vitest'
import { engineLoadError } from '../src/pdf-extract.ts'
import { PdfEngineLoadError, PdfExtractionUnavailableError } from '../src/pdf-errors.ts'

describe('PDF engine load failure classification', () => {
  it('reports a missing package as the typed unavailable runtime with its cause', () => {
    const cause = Object.assign(new Error("Cannot find package 'pdfjs-dist'"), { code: 'ERR_MODULE_NOT_FOUND' })
    const error = engineLoadError(cause)
    expect(error).toBeInstanceOf(PdfExtractionUnavailableError)
    expect(error.cause).toBe(cause)
  })

  it('reports any other resolution failure as a broken engine with its cause', () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const error = engineLoadError(cause)
    expect(error).toBeInstanceOf(PdfEngineLoadError)
    expect(error.message).toContain('permission denied')
    expect(error.cause).toBe(cause)
  })

  it('stringifies a non-Error rejection', () => {
    const error = engineLoadError('denied as a plain string')
    expect(error).toBeInstanceOf(PdfEngineLoadError)
    expect(error.message).toContain('denied as a plain string')
  })
})
