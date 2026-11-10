import { z } from 'zod'
/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'

/** Running MCP endpoint and its HTTP request observations. */
export interface HttpMcpFixture {
  url: string
  calls: string[]
  authorization: Array<string | undefined>
  redirects: string[]
  connects: string[]
  requests: string[]
  close: () => Promise<void>
}

/**
 * Start a local MCP endpoint with controlled tool errors, redirects, and optional HTTP proxy handling.
 * @param options - tool failure controls; proxy mode accepts HTTP requests locally and refuses every CONNECT request.
 * @returns the endpoint, request observations, and cleanup that awaits owned connections.
 */
export async function startHttpMcpFixture(
  options: { rejectToolCalls?: boolean; redirectToolCallsTo?: string; proxy?: boolean } = {},
): Promise<HttpMcpFixture> {
  const calls: string[] = []
  const authorization: Array<string | undefined> = []
  const redirects: string[] = []
  const connects: string[] = []
  const requests: string[] = []
  const sockets = new Set<Duplex>()
  const closed: Promise<void>[] = []
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    closed.push(new Promise<void>((resolve) => {
      socket.once('close', () => { sockets.delete(socket); resolve() })
    }))
    socket.on('error', () => { socket.destroy() })
  }
  const handler = createMcpHandler(({ requestInfo }) => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      calls.push('ping')
      if (options.rejectToolCalls) {
        return { isError: true, content: [{ type: 'text', text: `MCP fixture rejected ${requestInfo?.headers.get('authorization')}` }] }
      }
      return { content: [{ type: 'text', text: 'pong' }] }
    })
    return mcp
  })
  const handle = toNodeHandler(handler)
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    requests.push(request.url ?? '')
    if (options.redirectToolCallsTo !== undefined && request.headers['mcp-method'] === 'tools/call') {
      redirects.push('tools/call')
      request.resume()
      response.writeHead(307, { location: options.redirectToolCallsTo }).end()
      return
    }
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  if (options.proxy === true) {
    server.on('connect', (request, socket) => {
      connects.push(request.url ?? '')
      track(socket)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    calls,
    redirects,
    connects,
    requests,
    close: async () => {
      const stopped = new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      try {
        await handler.close()
      } finally {
        for (const socket of sockets) socket.destroy()
        await Promise.all([...closed, stopped])
      }
    },
  }
}
