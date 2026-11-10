import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { Config } from '../src/index.ts'
import { createTransport } from '../src/transport.ts'

interface RequestObservation {
  method: string | undefined
  path: string | undefined
  apiKey: string | string[] | undefined
  sessionId: string | string[] | undefined
  body: string
}

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

async function observe(request: IncomingMessage): Promise<RequestObservation> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes: unknown = chunk
    if (!(bytes instanceof Uint8Array)) throw new Error('HTTP fixture received a non-byte chunk')
    chunks.push(Buffer.from(bytes))
  }
  return {
    method: request.method,
    path: request.url,
    apiKey: request.headers['x-api-key'],
    sessionId: request.headers['mcp-session-id'],
    body: Buffer.concat(chunks).toString('utf8'),
  }
}

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MCP redirect fixture has no TCP address')
  return `http://127.0.0.1:${address.port}`
}

function respond(request: RequestObservation, response: ServerResponse): void {
  if (request.method !== 'POST') {
    response.writeHead(405).end()
    return
  }
  const message = rpcRequest.parse(JSON.parse(request.body))
  if (message.id === undefined) {
    response.writeHead(202).end()
    return
  }
  const result = message.method === 'initialize'
    ? {
      protocolVersion: z.object({ protocolVersion: z.string() }).parse(message.params).protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'redirect-fixture', version: '1' },
    }
    : { content: [{ type: 'text', text: 'pong' }] }
  response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'redirect-test', version: '1' }, { capabilities: {} })
  onTestFinished(async () => { await client.close() })
  await client.connect(createTransport(Config({
    transport: 'streamable-http', serverName: 'redirect-test', url,
    headers: { 'X-API-Key': 'fixture-api-key' },
  })))
  return client
}

describe('MCP HTTP redirect policy', () => {
  it.each([302, 307, 308])('keeps credentials, the SDK session, and the tool body away from another origin after %i', async (status) => {
    const destination: RequestObservation[] = []
    const target = await listen(async (request, response) => {
      destination.push(await observe(request))
      response.writeHead(403).end('redirect target')
    })
    const source: RequestObservation[] = []
    const origin = await listen(async (request, response) => {
      const seen = await observe(request)
      source.push(seen)
      if (seen.method === 'POST' && rpcRequest.parse(JSON.parse(seen.body)).method === 'tools/call') {
        response.writeHead(status, { location: `${target}/mcp` }).end()
        return
      }
      respond(seen, response)
    })
    const client = await connect(`${origin}/mcp`)
    await expect(client.callTool({ name: 'ping', arguments: { marker: 'fixture-body' } }))
      .rejects.toThrow("redirectPolicy: 'same-origin'")
    const tool = source.find(seen => seen.body.includes('tools/call'))
    expect(tool).toMatchObject({ apiKey: 'fixture-api-key', sessionId: 'fixture-session', method: 'POST' })
    expect(rpcRequest.parse(JSON.parse(tool?.body ?? '')).params).toEqual({ name: 'ping', arguments: { marker: 'fixture-body' } })
    expect(destination).toEqual([])
  })

  it.each([307, 308])('initializes and calls tools through a same-origin %i redirect', async (status) => {
    const requests: RequestObservation[] = []
    const origin = await listen(async (request, response) => {
      const seen = await observe(request)
      requests.push(seen)
      if (seen.path === '/redirect') {
        response.writeHead(status, { location: '/mcp' }).end()
        return
      }
      respond(seen, response)
    })
    const client = await connect(`${origin}/redirect`)
    expect(await client.callTool({ name: 'ping', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'pong' }] })
    expect(requests.some(seen => seen.path === '/mcp' && seen.body.includes('initialize'))).toBe(true)
    expect(requests.find(seen => seen.path === '/mcp' && seen.body.includes('tools/call')))
      .toMatchObject({ apiKey: 'fixture-api-key', sessionId: 'fixture-session', method: 'POST' })
  })

  it.each([301, 302, 303])('rejects a same-origin %i redirect that would change the POST method', async (status) => {
    const requests: RequestObservation[] = []
    const origin = await listen(async (request, response) => {
      requests.push(await observe(request))
      response.writeHead(status, { location: '/mcp' }).end()
    })
    await expect(connect(`${origin}/redirect`)).rejects.toThrow("redirectPolicy: 'same-origin'")
    expect(requests.map(request => ({ method: request.method, path: request.path })))
      .toEqual([{ method: 'POST', path: '/redirect' }])
  })

  it.each([
    { method: 'POST', status: 307 },
    { method: 'POST', status: 308 },
    { method: 'GET', status: 302 },
  ])('rejects a default-port HTTP to HTTPS $method $status redirect before forwarding session data', async ({ method, status }) => {
    const source: RequestObservation[] = []
    const destination: RequestObservation[] = []
    const client = new Client({ name: 'redirect-test', version: '1' }, { capabilities: {} })
    const streamFailure = Promise.withResolvers<Error>()
    client.onerror = (error) => { streamFailure.resolve(error) }
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      const seen: RequestObservation = {
        method: init?.method ?? 'GET', path: url.pathname,
        apiKey: headers.get('x-api-key') ?? undefined,
        sessionId: headers.get('mcp-session-id') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : '',
      }
      if (url.origin === 'https://mcp-origin.invalid') {
        destination.push(seen)
        return new Response('unexpected origin', { status: 403 })
      }
      source.push(seen)
      if (seen.method !== 'POST') {
        return seen.method === method && seen.sessionId === 'fixture-session'
          ? new Response(null, { status, headers: { location: 'https://mcp-origin.invalid/mcp' } })
          : new Response(null, { status: 405 })
      }
      const message = rpcRequest.parse(JSON.parse(seen.body))
      if (message.method === 'tools/call') {
        return new Response(null, { status, headers: { location: 'https://mcp-origin.invalid/mcp' } })
      }
      if (message.id === undefined) return new Response(null, { status: 202 })
      return Response.json({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: z.object({ protocolVersion: z.string() }).parse(message.params).protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'redirect-fixture', version: '1' },
      } }, { headers: { 'mcp-session-id': 'fixture-session' } })
    })
    onTestFinished(() => { stub.mockRestore() })
    try {
      await client.connect(createTransport(Config({
        transport: 'streamable-http', serverName: 'redirect-test', url: 'http://mcp-origin.invalid/mcp',
        headers: { 'X-API-Key': 'fixture-api-key' },
      })))
      if (method === 'POST') {
        await expect(client.callTool({ name: 'ping', arguments: { marker: 'fixture-body' } }))
          .rejects.toThrow('MCP HTTP redirect must stay on the configured origin')
      } else {
        expect(await streamFailure.promise).toMatchObject({ message: 'MCP HTTP redirect must stay on the configured origin' })
      }
      const redirected = source.find(seen => method === 'POST' ? seen.body.includes('tools/call') : seen.method === method)
      expect(redirected).toMatchObject({ apiKey: 'fixture-api-key', sessionId: 'fixture-session', method })
      if (method === 'POST') {
        expect(rpcRequest.parse(JSON.parse(redirected?.body ?? '')).params)
          .toEqual({ name: 'ping', arguments: { marker: 'fixture-body' } })
      }
      expect(destination).toEqual([])
    } finally {
      try { await client.close() } finally { stub.mockRestore() }
    }
  })
})
