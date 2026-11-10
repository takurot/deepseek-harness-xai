import { createServer } from 'node:net'
import { once } from 'node:events'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { WebError } from '@deepseek-ai/dsh-web'

async function main(): Promise<void> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.end([
        'HTTP/1.1 200 OK',
        'Content-Type: text/plain',
        'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip',
        'Content-Length: 100',
        'Connection: close',
        '',
        '',
      ].join('\r\n'))
    })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const provider = new HttpFetchProvider({
      maxResponseBytes: 1000,
      maxBodyChars: 1000,
      timeoutMs: 5000,
      maxRedirects: 0,
      userAgent: 'content-encoding-test',
    })
    try {
      await provider.fetch({ url: `http://127.0.0.1:${address.port}` })
      throw new Error('malformed response unexpectedly succeeded')
    } catch (error) {
      if (!(error instanceof WebError)) throw error
      process.stdout.write(`${JSON.stringify({ code: error.code })}\n`)
    }
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
