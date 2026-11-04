import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as xaiPlugin from '@deepseek-ai/dsh-web-search-xai'

function urlOf(input: RequestInfo | URL | undefined): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
}

function bodyOf(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : ''
}

afterEach(() => { vi.restoreAllMocks() })

async function boot(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin(xaiPlugin, config)
  return ctx
}

function searchProvider(ctx: Context) {
  const provider = ctx.web.listProviders().search.find(entry => entry.id === 'xai')
  expect(provider).toBeDefined()
  return provider!
}

describe('web-search-xai plugin', () => {
  it('registers the xai search provider with an English description', async () => {
    const ctx = await boot({ apiKey: 'k' })
    expect((searchProvider(ctx).description as { en: string } | undefined)?.en).toMatch(/Grok/u)
  })

  it('searches with the configured endpoint, model, and literal key', async () => {
    const ctx = await boot({ apiKey: 'k', baseURL: 'https://cfg.test/v1', model: 'grok-cfg' })
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'a', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }] }],
    }), { status: 200 }))
    const result = await ctx.web.search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://a.test/' }])
    expect(urlOf(spy.mock.calls[0]![0])).toBe('https://cfg.test/v1/responses')
    expect(JSON.parse(bodyOf(spy.mock.calls[0]![1]?.body))).toMatchObject({ model: 'grok-cfg' })
  })

  it('rejects an invalid sources value at load', async () => {
    await expect(boot({ apiKey: 'k', sources: ['bing'] })).rejects.toThrow()
  })
})

describe('web-search-xai readiness', () => {
  it('is not ready without a credential, so web_search stays hidden', async () => {
    const ctx = await boot({ apiKeyEnv: 'XAI_KEY_FOR_TEST_UNSET' })
    expect(await ctx.web.searchReady()).toBe(false)
  })

  it('is ready with a literal key and never contacts the network', async () => {
    const ctx = await boot({ apiKey: 'k' })
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await ctx.web.searchReady()).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})

const CITED = JSON.stringify({
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'a', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }] }],
})

function bearer(spy: { mock: { calls: unknown[][] } }): string {
  return String(((spy.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>).authorization)
}

describe('web-search-xai credential resolution', () => {
  it('reads the key from the launch environment when no credentials service is installed', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { XAI_API_KEY: 'env-key' } }]))
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(xaiPlugin, {})
    expect(await ctx.web.searchReady()).toBe(true)
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(CITED, { status: 200 }))
    await ctx.web.search({ query: 'q' })
    expect(bearer(spy)).toBe('Bearer env-key')
  })

  it('treats an empty launch-environment value as no key', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { XAI_API_KEY: '' } }]))
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(xaiPlugin, {})
    expect(await ctx.web.searchReady()).toBe(false)
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  })

  it('rejects a malformed key from the launch environment before any request', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { XAI_API_KEY: 'bad key' } }]))
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(xaiPlugin, {})
    const spy = vi.spyOn(globalThis, 'fetch')
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('resolves a stored credential for each search and reports readiness from the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-xai-'))
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(xaiPlugin, {})
      expect(await ctx.web.searchReady()).toBe(false)
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await ctx.credentials.set(credentialRef('XAI_API_KEY'), 'stored-key')
      expect(await ctx.web.searchReady()).toBe(true)
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(CITED, { status: 200 }))
      await ctx.web.search({ query: 'q' })
      expect(bearer(spy)).toBe('Bearer stored-key')
      vi.spyOn(ctx.credentials, 'describe').mockRejectedValue(new Error('unreadable'))
      expect(await ctx.web.searchReady()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
