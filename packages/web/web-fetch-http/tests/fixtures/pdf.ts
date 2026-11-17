/** Minimal, hand-built PDF documents used by fetch-provider and extraction tests. */

/** One page: one text run, several lines, or table-like rows; omit all for a text-free page. */
export interface PdfFixturePage {
  readonly text?: string
  /** Text lines drawn 14pt apart; each becomes its own extracted line. */
  readonly lines?: readonly string[]
  /** Rows of columns drawn on one baseline per row, at 150pt column steps. */
  readonly rows?: readonly (readonly string[])[]
}

/** Escape a PDF literal string so parentheses and backslashes survive parsing. */
function escapeLiteral(value: string): string {
  return value.replace(/[\\()]/g, character => `\\${character}`)
}

/** A page's content stream in Helvetica, or an empty graphics state. */
function contentFor(page: PdfFixturePage): string {
  if (page.rows !== undefined) {
    const operations = ['BT /F1 12 Tf']
    page.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        operations.push(`1 0 0 1 ${String(72 + columnIndex * 150)} ${String(720 - rowIndex * 14)} Tm (${escapeLiteral(cell)}) Tj`)
      })
    })
    operations.push('ET')
    return operations.join(' ')
  }
  if (page.lines !== undefined) {
    const [first = '', ...rest] = page.lines
    let operations = `BT /F1 12 Tf 72 720 Td (${escapeLiteral(first)}) Tj`
    for (const line of rest) operations += ` 0 -14 Td (${escapeLiteral(line)}) Tj`
    return `${operations} ET`
  }
  return page.text === undefined
    ? 'q Q'
    : `BT /F1 12 Tf 72 700 Td (${escapeLiteral(page.text)}) Tj ET`
}

/**
 * Build one small, valid PDF whose pages carry at most one text run.
 * @param pages - page contents in document order; at least one page.
 * @returns the complete PDF bytes.
 */
export function pdfBytes(pages: readonly PdfFixturePage[]): Uint8Array {
  if (pages.length === 0) throw new Error('a PDF fixture needs at least one page')
  const objects: string[] = []
  const add = (body: string): number => {
    objects.push(body)
    return objects.length
  }

  // Ids referenced by the catalog and page tree are filled in after their
  // bodies exist, so build the font first and the catalog last.
  const fontId = 1
  const pagesId = 2
  const firstPageId = 3
  const pageIds = pages.map((_page, index) => firstPageId + index * 2)

  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${String(id)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`)
  for (const [index, page] of pages.entries()) {
    const contentId = firstPageId + index * 2 + 1
    const hasText = page.text !== undefined || page.lines !== undefined || page.rows !== undefined
    const resources = hasText ? ` /Resources << /Font << /F1 ${String(fontId)} 0 R >> >>` : ''
    add(`<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 612 792] /Contents ${String(contentId)} 0 R${resources} >>`)
    const stream = contentFor(page)
    add(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`)
  }
  add(`<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`)
  const catalogId = objects.length

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalogId)} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** Bytes that declare a PDF but carry no parseable document structure. */
export function corruptPdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\nthis is not a PDF body\n%%EOF\n')
}
