import { describe, expect, it } from 'vitest'
import { XaiSearchProvider, XAI_DEFAULT_BASE_URL, XAI_DEFAULT_MODEL, XAI_DEFAULT_TIMEOUT_MS } from '@deepseek-ai/dsh-web-search-xai'

/** Real-API probe; self-skips without `XAI_API_KEY` (docs/testing.md key policy). */
const apiKey = process.env.XAI_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('XaiSearchProvider real API', () => {
  it('returns an answer with cited sources for a live query', async () => {
    const provider = new XaiSearchProvider(() => ({
      apiKey: apiKey!,
      baseURL: process.env.XAI_BASE_URL ?? XAI_DEFAULT_BASE_URL,
      model: process.env.XAI_SEARCH_MODEL ?? XAI_DEFAULT_MODEL,
      sources: ['web'],
      timeoutMs: XAI_DEFAULT_TIMEOUT_MS,
    }))
    const result = await provider.search({ query: 'What is xAI Grok?', maxResults: 5 })
    expect(result.content?.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//u)
  }, 90_000)
})
