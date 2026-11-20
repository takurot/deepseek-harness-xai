/** Own the loopback Chat Completions provider used by the Pi tests. */
import { createServer } from 'node:http'
import type { TestContext } from 'vitest'

/**
 * Replay complete SSE responses and capture request bodies for assertions.
 * @param test - owns socket cleanup.
 * @param responses - one ordered frame list per request, excluding the final DONE marker.
 * @returns The assigned URL and the received UTF-8 request bodies.
 */
export async function piLoopback(test: TestContext, responses: readonly (readonly string[])[]): Promise<{
  baseUrl: string
  bodies: string[]
}> {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (chunk: string) => { body += chunk })
    request.on('error', () => { response.destroy() })
    request.on('end', () => {
      const frames = responses[bodies.length]
      bodies.push(body)
      if (!frames) {
        response.writeHead(500).end('Unexpected fixture request')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${frame}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  test.onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local provider address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, bodies }
}
