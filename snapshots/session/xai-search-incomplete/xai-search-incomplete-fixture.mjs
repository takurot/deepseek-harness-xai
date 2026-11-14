/** Deterministic incomplete Responses API body through the real xAI search provider. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Model-visible endpoint retained by the recorded session. */
const RECORDED_ENDPOINT = 'http://127.0.0.1:43119/v1/responses'
const RECORDED_URL = new URL(RECORDED_ENDPOINT)

/** Cordis plugin name. */
export const name = 'xai-search-incomplete-fixture'

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return undefined
}

function transportInput(input, transportEndpoint) {
  const url = requestUrl(input)
  if (url === RECORDED_ENDPOINT) {
    return input instanceof Request ? new Request(transportEndpoint, input) : transportEndpoint
  }
  if (url === undefined) return input
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return input
  }
  if (parsed.host === RECORDED_URL.host) {
    throw new Error(`xai-search-incomplete-fixture: unexpected URL for recorded authority: ${url}`)
  }
  return input
}

/** Start the local Responses endpoint and stop it with the plugin fiber. */
export async function apply(ctx) {
  let restoreFetch = () => {}
  let receivedHeaders = false
  await applyLoopbackServerEffect(ctx, {
    label: 'xai-search-incomplete-fixture',
    requestListener: (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/responses') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial-answer-marker', annotations: [{ type: 'url_citation', url: 'https://partial.test/' }] }] }],
        }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    },
    onListening: (address) => {
      const transportEndpoint = `http://127.0.0.1:${String(address.port)}/v1/responses`
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => {
        const response = await originalFetch(transportInput(input, transportEndpoint), init)
        if (requestUrl(input) === RECORDED_ENDPOINT) receivedHeaders = true
        return response
      }
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('xai-search-incomplete-fixture: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => {
      restoreFetch()
      if (!receivedHeaders) throw new Error('xai-search-incomplete-fixture: provider did not read the incomplete response')
    },
  })
}
