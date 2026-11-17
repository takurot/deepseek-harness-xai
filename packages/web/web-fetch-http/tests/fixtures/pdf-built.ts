import { createServer } from 'node:http'
import { once } from 'node:events'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { pdfBytes } from './pdf.ts'

async function main(): Promise<void> {
  const bytes = pdfBytes([{ text: 'Built page one' }, { text: 'Built page two' }])
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf' })
    response.end(Buffer.from(bytes))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const provider = new HttpFetchProvider({
      maxResponseBytes: 100_000,
      maxBodyChars: 1000,
      timeoutMs: 10_000,
      maxRedirects: 0,
      maxPdfPages: 10,
      userAgent: 'pdf-built-test',
    })
    const result = await provider.fetch({ url: `http://127.0.0.1:${address.port}/paper.pdf` })
    process.stdout.write(`${JSON.stringify(result.body)}\n`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
