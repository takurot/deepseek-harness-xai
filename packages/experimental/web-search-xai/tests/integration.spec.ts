/**
 * Integration: the real seam (`dsh-web`) + the real provider (`dsh-web-search-xai`) + the model tool
 * (`dsh-tool-web`), exercised through `executeToolFixture()` so nothing bypasses the tool registry.
 * Only the xAI network boundary is stubbed.
 */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as WebSearchXai from '@deepseek-ai/dsh-web-search-xai'

const signal = new AbortController().signal
const agent = { id: SessionId('web-search-xai-integration') } as Agent

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Compose the shipped web stack with xAI as the only search provider. */
async function compose(env: Record<string, string>): Promise<Context> {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(WebRuntime, { searchProvider: WebSearchXai.XAI_PROVIDER_ID })
  await ctx.plugin(WebSearchXai, { baseURL: 'https://api.xai.test/v1' })
  await ctx.plugin(ToolWeb)
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['tools'] }))
  return ctx
}

describe('web_search over the real xAI provider', () => {
  it('offers web_search and returns the answer with its cited sources', async () => {
    const ctx = await compose({ XAI_API_KEY: 'xai-key' })
    const fetchMock = vi.fn((_endpoint: string, _init: { headers: Record<string, string>; body: string }) => Promise.resolve(new Response(
      JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok is a model.', annotations: [{ type: 'url_citation', url: 'https://x.ai/grok', title: '1' }] }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    vi.stubGlobal('fetch', fetchMock)
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
    try {
      expect(toolSet.view(agent).has('web_search')).toBe(true)
      const out = await executeToolFixture(ctx, { agent, toolSet, signal, callId: ToolCallId('xai-1'), name: 'web_search', arguments: { queries: ['what is grok'] } })
      expect(out.isError).toBe(false)
      const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(text).toContain('Grok is a model.')
      expect(text).toContain('https://x.ai/grok')
      const [endpoint, init] = fetchMock.mock.calls[0]!
      expect(endpoint).toBe('https://api.xai.test/v1/responses')
      expect(init.headers.authorization).toBe('Bearer xai-key')
    } finally {
      toolSet.dispose()
    }
  })

  it('returns a structured tool failure without an incomplete provider answer', async () => {
    const ctx = await compose({ XAI_API_KEY: 'xai-key' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial-answer-marker', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }] }],
    }))))
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
    try {
      const out = await executeToolFixture(ctx, { agent, toolSet, signal, callId: ToolCallId('xai-incomplete'), name: 'web_search', arguments: { queries: ['q'] } })
      expect(out.isError).toBe(true)
      expect(out.error).toMatchObject({ info: { name: 'WebError', code: 'WEB_PROVIDER_ERROR' } })
      expect(JSON.stringify(out)).not.toContain('partial-answer-marker')
    } finally {
      toolSet.dispose()
    }
  })

  it('marks a completed answer as truncated only when the web service caps its source count', async () => {
    const ctx = await compose({ XAI_API_KEY: 'xai-key' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Complete answer.', annotations: [
        { type: 'url_citation', url: 'https://a.test/' },
        { type: 'url_citation', url: 'https://b.test/' },
      ] }] }],
    }))))
    await expect(ctx.web.search({ query: 'q', maxResults: 1 })).resolves.toMatchObject({
      content: 'Complete answer.', sources: [{ url: 'https://a.test/' }], truncated: true,
    })
  })

  it('withholds web_search from the model when no xAI key is configured', async () => {
    const ctx = await compose({})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
    try {
      expect(toolSet.view(agent).has('web_search')).toBe(false)
    } finally {
      toolSet.dispose()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
