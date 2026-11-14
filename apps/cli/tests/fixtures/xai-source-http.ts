/** External xAI HTTP fixture shared by source launch and recorded-session replay. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Intercept external HTTP while retaining the real provider and tool implementation.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const original = globalThis.fetch
    const fixture: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'https://api.x.ai/v1/responses') throw new Error(`Unexpected external HTTP request: ${url}`)
      if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Expected JSON POST body')
      const body: unknown = JSON.parse(init.body)
      if (!JSON.stringify(body).includes('web_search')) throw new Error('Expected xAI server-side web search request')
      if (process.env.DSH_XAI_HTTP_TRACE === '1') process.stdout.write(`XAI_HTTP_REQUEST ${url}\n`)
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok search fixture answer.', annotations: [{ type: 'url_citation', url: 'https://x.ai/grok', title: '1' }] }] }] })
    }
    globalThis.fetch = fixture
    return () => {
      if (globalThis.fetch !== fixture) throw new Error('xAI HTTP fixture lost fetch ownership before disposal')
      globalThis.fetch = original
    }
  })
}
