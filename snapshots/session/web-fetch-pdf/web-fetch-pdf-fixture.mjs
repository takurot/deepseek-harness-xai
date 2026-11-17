/**
 * Deterministic PDF provider for the web-fetch-pdf snapshot scenario: one
 * three-page text PDF and one three-page scanned (text-free) PDF on OS-assigned
 * loopback ports behind the real HTTP transport and the real PDF extraction
 * Worker. Recording and replay therefore exercise page markers, the page cap,
 * and the scanned-document notice without external network while retaining the
 * recorded request URLs.
 */
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Model-visible URLs retained by the recorded session. */
const SPEC_URL = 'http://public.test:43119/spec.pdf'
const SCANNED_URL = 'http://public.test:43119/scanned.pdf'

/** Escape a PDF literal string so parentheses and backslashes survive parsing. */
function escapeLiteral(value) {
  return value.replace(/[\\()]/g, character => `\\${character}`)
}

/** A page's content stream: one text run, several lines, or an empty page. */
function contentFor(page) {
  if (page === undefined) return 'q Q'
  if (page.lines !== undefined) {
    const [first, ...rest] = page.lines
    let operations = `BT /F1 12 Tf 72 720 Td (${escapeLiteral(first)}) Tj`
    for (const line of rest) operations += ` 0 -14 Td (${escapeLiteral(line)}) Tj`
    return `${operations} ET`
  }
  return `BT /F1 12 Tf 72 700 Td (${escapeLiteral(page.text)}) Tj ET`
}

/** Build one small valid PDF; an omitted page produces a text-free page. */
function pdfBytes(pages) {
  const objects = []
  const add = (body) => {
    objects.push(body)
    return objects.length
  }
  const fontId = 1
  const pagesId = 2
  const firstPageId = 3
  const pageIds = pages.map((_page, index) => firstPageId + index * 2)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (const [index, page] of pages.entries()) {
    const contentId = firstPageId + index * 2 + 1
    const resources = page === undefined ? '' : ` /Resources << /Font << /F1 ${fontId} 0 R >> >>`
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R${resources} >>`)
    const stream = contentFor(page)
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  const catalogId = objects.length
  let body = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

const SPEC_PDF = pdfBytes([
  { text: 'Spec page one' },
  { lines: ['Spec line two a', 'Spec line two b'] },
  { text: 'Spec page three' },
])
const SCANNED_PDF = pdfBytes([undefined, undefined, undefined])

/** Cordis plugin name. */
export const name = 'web-fetch-pdf-fixture'

/** Service used by the fixture provider. */
export const inject = ['web']

const LIMITS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  // Two pages prove the page-cap notice on both three-page documents.
  maxPdfPages: 2,
  userAgent: 'deepseek-harness-snapshot/1.0',
}

/**
 * Register the deterministic provider and start its loopback server.
 * @param ctx - Cordis context; the effect disposes the server with the fiber.
 */
export async function apply(ctx) {
  const readiness = Promise.withResolvers()
  let transportUrl
  let startupError

  const provider = new HttpFetchProvider(LIMITS)
  const unregister = ctx.web.registerFetchProvider({
    id: provider.id,
    available: () => provider.available(),
    fetch: async (request, signal) => {
      if (request.url !== SPEC_URL && request.url !== SCANNED_URL) {
        throw new Error(`unexpected snapshot URL: ${request.url}`)
      }
      await readiness.promise
      if (startupError !== undefined) throw startupError
      const path = request.url === SPEC_URL ? '/spec.pdf' : '/scanned.pdf'
      const result = await provider.fetch({ url: `${transportUrl.origin}${path}` }, signal)
      return { ...result, url: request.url }
    },
  })
  try {
    await applyLoopbackServerEffect(ctx, {
      label: 'web-fetch-pdf-fixture-server',
      requestListener: (req, res) => {
        if (req.url === '/spec.pdf') {
          res.writeHead(200, { 'content-type': 'application/pdf' })
          res.end(Buffer.from(SPEC_PDF))
          return
        }
        if (req.url === '/scanned.pdf') {
          res.writeHead(200, { 'content-type': 'application/pdf' })
          res.end(Buffer.from(SCANNED_PDF))
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      },
      onListening: (address) => {
        transportUrl = new URL(SPEC_URL)
        transportUrl.hostname = '127.0.0.1'
        transportUrl.port = String(address.port)
        readiness.resolve(undefined)
      },
      onCleanup: () => {
        unregister()
      },
    })
  } catch (cause) {
    startupError = cause
    readiness.resolve(undefined)
    throw cause
  }
}
