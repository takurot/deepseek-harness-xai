import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { sniffHtmlCharset } from '../src/policy.ts'

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap(part => [...part]))

const SJIS_NIHONGO = Uint8Array.from([0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA])
const EUCJP_NIHONGO = Uint8Array.from([0xC6, 0xFC, 0xCB, 0xDC, 0xB8, 0xEC])
const GBK_ZHONGWEN = Uint8Array.from([0xD6, 0xD0, 0xCE, 0xC4])

describe('sniffHtmlCharset', () => {
  it('reads <meta charset> in any case, quoting, and spacing', () => {
    expect(sniffHtmlCharset(ascii('<html><head><meta charset="Shift_JIS">'))).toBe('shift_jis')
    expect(sniffHtmlCharset(ascii('<META CHARSET = euc-jp >'))).toBe('euc-jp')
    expect(sniffHtmlCharset(ascii('<meta charset=\'gbk\'/>'))).toBe('gbk')
    expect(sniffHtmlCharset(ascii('<meta charset=big5>'))).toBe('big5')
  })

  it('reads the http-equiv Content-Type form and ignores other content attributes', () => {
    expect(sniffHtmlCharset(ascii('<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">'))).toBe('euc-jp')
    expect(sniffHtmlCharset(ascii('<meta content="text/html; charset=gbk" http-equiv=content-type>'))).toBe('gbk')
    expect(sniffHtmlCharset(ascii('<meta name="x" content="text/html; charset=gbk">'))).toBeUndefined()
    expect(sniffHtmlCharset(ascii('<meta http-equiv="refresh" content="0; charset=gbk">'))).toBeUndefined()
    expect(sniffHtmlCharset(ascii('<meta http-equiv="content-type" content="text/html">'))).toBeUndefined()
  })

  it('uses the first usable declaration and skips comments', () => {
    expect(sniffHtmlCharset(ascii('<!-- <meta charset="big5"> --><meta charset="gbk">'))).toBe('gbk')
    expect(sniffHtmlCharset(ascii('<meta name="a"><meta charset="euc-kr"><meta charset="gbk">'))).toBe('euc-kr')
  })

  it('looks only at the first 1024 bytes', () => {
    expect(sniffHtmlCharset(ascii(`${' '.repeat(1100)}<meta charset="gbk">`))).toBeUndefined()
    expect(sniffHtmlCharset(ascii(`${' '.repeat(1000)}<meta charset="gbk">`))).toBe('gbk')
  })

  it('returns undefined when nothing is declared', () => {
    expect(sniffHtmlCharset(ascii('<p>plain</p>'))).toBeUndefined()
    expect(sniffHtmlCharset(new Uint8Array(0))).toBeUndefined()
  })

  it('lets a byte order mark win over a conflicting declaration', () => {
    expect(sniffHtmlCharset(concat(Uint8Array.from([0xEF, 0xBB, 0xBF]), ascii('<meta charset="gbk">')))).toBe('utf-8')
    expect(sniffHtmlCharset(Uint8Array.from([0xFF, 0xFE, 0x3C, 0x00]))).toBe('utf-16le')
    expect(sniffHtmlCharset(Uint8Array.from([0xFE, 0xFF, 0x00, 0x3C]))).toBe('utf-16be')
  })

  it('does not treat a lone first byte as a byte order mark', () => {
    expect(sniffHtmlCharset(Uint8Array.from([0xFF]))).toBeUndefined()
    expect(sniffHtmlCharset(Uint8Array.from([0xEF, 0xBB]))).toBeUndefined()
  })
})

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let server: Server
let base: string
let handler: Handler

beforeEach(async () => {
  handler = (_req, res) => { res.end() }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function serve(contentType: string, body: Uint8Array): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': contentType })
    res.end(Buffer.from(body))
  }
}

function fetchPage(overrides: Partial<HttpFetchLimits> = {}) {
  return new HttpFetchProvider({ ...limits, ...overrides }).fetch({ url: `${base}/page` }, new AbortController().signal)
}

describe('HttpFetchProvider HTML charset sniffing', () => {
  it.each([
    ['Shift_JIS', SJIS_NIHONGO, '日本語'],
    ['EUC-JP', EUCJP_NIHONGO, '日本語'],
    ['GBK', GBK_ZHONGWEN, '中文'],
  ] as const)('decodes a %s page that declares its charset only in <meta>', async (label, bytes, text) => {
    serve('text/html', concat(ascii(`<meta charset="${label}"><p>`), bytes, ascii('</p>')))
    const result = await fetchPage()
    expect(result.body).toEqual({ kind: 'html', content: `<meta charset="${label}"><p>${text}</p>` })
  })

  it('decodes the http-equiv form', async () => {
    serve('text/html', concat(ascii('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">'), SJIS_NIHONGO))
    expect((await fetchPage()).body.content).toContain('日本語')
  })

  it('decodes UTF-16 text announced only by its byte order mark', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('<p>日本語</p>', 'utf16le')])
    serve('text/html', utf16)
    expect((await fetchPage()).body.content).toBe('<p>日本語</p>')
  })

  it('treats a <meta> utf-16 label as UTF-8, since the page was readable as ASCII', async () => {
    serve('text/html', ascii('<meta charset="utf-16"><p>ok</p>'))
    expect((await fetchPage()).body.content).toBe('<meta charset="utf-16"><p>ok</p>')
  })

  it('lets the header win over a conflicting <meta>', async () => {
    serve('text/html; charset=shift_jis', concat(ascii('<meta charset="gbk">'), SJIS_NIHONGO))
    expect((await fetchPage()).body.content).toContain('日本語')
  })

  it('keeps UTF-8 for HTML with no declaration and does not sniff non-HTML', async () => {
    serve('text/html', ascii('<p>日本語</p>'))
    expect((await fetchPage()).body.content).toBe('<p>日本語</p>')
    serve('text/plain', concat(ascii('<meta charset="gbk">'), GBK_ZHONGWEN))
    expect((await fetchPage()).body.content).toContain('�')
  })

  it('rejects an unsupported <meta> label instead of returning garbled text', async () => {
    serve('text/html', ascii('<meta charset="not-a-charset"><p>x</p>'))
    await expect(fetchPage()).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE', message: 'unsupported charset "not-a-charset"' })
  })

  it('decodes a page cut by the byte cap in the middle of a multibyte character', async () => {
    serve('text/html', concat(ascii('<meta charset="shift_jis">'), SJIS_NIHONGO))
    const result = await fetchPage({ maxResponseBytes: 26 + 3 })
    expect(result.truncated).toBe(true)
    expect(result.body.content.startsWith('<meta charset="shift_jis">日')).toBe(true)
  })
})
