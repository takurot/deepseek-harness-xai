import { describe, expect, it } from 'vitest'
import { extractPdfText } from '../src/pdf-extract.ts'
import { corruptPdfBytes, pdfBytes } from './fixtures/pdf.ts'

const LIMITS = { maxPages: 10, maxChars: 1_000 }

describe('PDF text extraction', () => {
  it('extracts every page, joining page text with form feeds and preserving empty pages', async () => {
    const result = await extractPdfText(pdfBytes([{ text: 'First page' }, {}, { text: 'Third page' }]), LIMITS)
    expect(result).toEqual({
      pageCount: 3,
      pagesExtracted: 3,
      content: 'First page\u000C\u000CThird page',
      truncated: false,
    })
  })

  it('accepts a single text-free page as one extracted page with empty content', async () => {
    const result = await extractPdfText(pdfBytes([{}]), LIMITS)
    expect(result).toEqual({ pageCount: 1, pagesExtracted: 1, content: '', truncated: false })
  })

  it('replaces a form feed inside extracted page text so page separators stay unambiguous', async () => {
    const result = await extractPdfText(pdfBytes([{ text: 'before\fafter' }]), LIMITS)
    expect(result.content).toBe('before after')
  })

  it('keeps extracted line breaks and joins items on one baseline with a space', async () => {
    const lines = await extractPdfText(pdfBytes([{ lines: ['First line', 'Second line'] }]), LIMITS)
    expect(lines.content).toBe('First line\nSecond line')
    const table = await extractPdfText(pdfBytes([{ rows: [['Name', 'Value'], ['Alpha', 'One']] }]), LIMITS)
    expect(table.content).toBe('Name Value\nAlpha One')
  })

  it('stops at maxPages and reports truncation', async () => {
    const result = await extractPdfText(pdfBytes([{ text: 'One' }, { text: 'Two' }, { text: 'Three' }]), {
      maxPages: 2,
      maxChars: 1_000,
    })
    expect(result).toEqual({ pageCount: 3, pagesExtracted: 2, content: 'One\u000CTwo', truncated: true })
  })

  it('bounds the joined content at maxChars, separator included, and keeps the partial page', async () => {
    const exact = await extractPdfText(pdfBytes([{ text: 'ab' }, { text: 'cd' }]), { maxPages: 10, maxChars: 5 })
    expect(exact).toEqual({ pageCount: 2, pagesExtracted: 2, content: 'ab\u000Ccd', truncated: false })
    const cut = await extractPdfText(pdfBytes([{ text: 'ab' }, { text: 'cd' }]), { maxPages: 10, maxChars: 4 })
    expect(cut).toEqual({ pageCount: 2, pagesExtracted: 2, content: 'ab\u000Cc', truncated: true })
    const tiny = await extractPdfText(pdfBytes([{ text: 'ab' }, { text: 'cd' }]), { maxPages: 10, maxChars: 1 })
    expect(tiny).toEqual({ pageCount: 2, pagesExtracted: 1, content: 'a', truncated: true })
    // The budget can be exactly exhausted before the last page, which then
    // contributes no span at all.
    const exhausted = await extractPdfText(
      pdfBytes([{ text: 'ab' }, { text: 'cd' }, { text: 'ef' }]),
      { maxPages: 10, maxChars: 5 },
    )
    expect(exhausted).toEqual({ pageCount: 3, pagesExtracted: 2, content: 'ab\u000Ccd', truncated: true })
  })

  it('rejects a body that is not a parseable PDF', async () => {
    await expect(extractPdfText(corruptPdfBytes(), LIMITS)).rejects.toBeDefined()
  })
})
