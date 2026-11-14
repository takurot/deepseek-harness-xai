import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { XaiSearchProvider } from '../src/provider.ts'

const OPTIONS = {
  baseURL: 'https://xai.test/v1',
  model: 'grok-test',
  sources: ['web'] as const,
  timeoutMs: 5_000,
  apiKey: 'xai-key',
}

function textBlock() {
  return { type: 'output_text', text: 'The answer.', annotations: [{ type: 'url_citation', url: 'https://a.test/' }] }
}

function completed(output: unknown = [{ type: 'message', content: [textBlock()] }]) {
  return { status: 'completed', output }
}

function search(body: unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
  return new XaiSearchProvider(() => OPTIONS).search({ query: 'q' })
}

afterEach(() => { vi.restoreAllMocks() })

describe('xAI response validation through search', () => {
  it('returns the completed answer and leaves source-count truncation to the web service', async () => {
    await expect(search(completed())).resolves.toEqual({
      content: 'The answer.', sources: [{ url: 'https://a.test/' }], truncated: false,
    })
  })

  it.each([true, false])('rejects an incomplete answer even when citations are present: %s', async (cited) => {
    const body = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ ...textBlock(), annotations: cited ? textBlock().annotations : [] }] }],
    }
    await expect(search(body)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'xAI returned an incomplete search response' })
  })

  it.each([undefined, null, 1, 'in_progress', 'queued', 'failed', 'cancelled', 'future_status'])('rejects status %s despite valid citations', async (status) => {
    await expect(search({ ...completed(), status })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it.each([
    ['null body', null],
    ['array body', []],
    ['string body', 'secret-body-marker'],
    ['missing output', { status: 'completed' }],
    ['null output', completed(null)],
    ['object output', completed({})],
    ['string output', completed('secret-body-marker')],
    ['null item', completed([null])],
    ['item without type', completed([{}, { type: 'message', content: [textBlock()] }])],
    ['non-string item type', completed([{ type: 1 }, { type: 'message', content: [textBlock()] }])],
    ['missing message content', completed([{ type: 'message' }, { type: 'message', content: [textBlock()] }])],
    ['null message content', completed([{ type: 'message', content: null }])],
    ['object message content', completed([{ type: 'message', content: {} }])],
    ['null block', completed([{ type: 'message', content: [null, textBlock()] }])],
    ['block without type', completed([{ type: 'message', content: [{}, textBlock()] }])],
    ['non-string block type', completed([{ type: 'message', content: [{ type: 1 }, textBlock()] }])],
    ['missing text', completed([{ type: 'message', content: [{ type: 'output_text', annotations: textBlock().annotations }] }])],
    ['null text', completed([{ type: 'message', content: [{ ...textBlock(), text: null }] }])],
    ['numeric text', completed([{ type: 'message', content: [{ ...textBlock(), text: 1 }] }])],
    ['object text', completed([{ type: 'message', content: [{ ...textBlock(), text: { secret: 'secret-body-marker' } }] }])],
    ['missing annotations', completed([{ type: 'message', content: [{ type: 'output_text', text: 'answer' }, textBlock()] }])],
    ['null annotations', completed([{ type: 'message', content: [{ ...textBlock(), annotations: null }] }])],
    ['object annotations', completed([{ type: 'message', content: [{ ...textBlock(), annotations: {} }] }])],
  ])('reports a structured provider failure for %s', async (_name, body) => {
    const failure = await search(body).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WebError)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(String(failure)).not.toContain('secret-body-marker')
  })

  it.each([
    null,
    {},
    { type: 1 },
    { type: 'url_citation' },
    { type: 'url_citation', url: null },
    { type: 'url_citation', url: 123 },
    { type: 'url_citation', url: {} },
    { type: 'url_citation', url: '' },
  ])('rejects malformed annotations beside a valid citation: %j', async (annotation) => {
    const body = completed([{ type: 'message', content: [{ ...textBlock(), annotations: [annotation, ...textBlock().annotations] }] }])
    await expect(search(body)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('ignores new string discriminators and unused fields without requiring citation offsets or titles', async () => {
    const body = {
      ...completed([
        { type: 'future_search_call', content: null },
        { type: 'message', content: [
          { type: 'future_content', text: null, annotations: null },
          { ...textBlock(), annotations: [{ type: 'future_annotation', url: null }, ...textBlock().annotations] },
        ] },
      ]),
      id: null,
      usage: 'unused',
    }
    await expect(search(body)).resolves.toMatchObject({ content: 'The answer.', sources: [{ url: 'https://a.test/' }] })
  })

  it('keeps the no-citation failure for a valid completed response', async () => {
    await expect(search(completed([]))).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'xAI returned no cited sources; the request may not have triggered server-side search' })
  })

  it('does not expose malformed JSON response text in its diagnostic', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('secret-body-marker', { status: 200 }))
    const failure = await new XaiSearchProvider(() => OPTIONS).search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(String(failure)).not.toContain('secret-body-marker')
    expect(failure).not.toHaveProperty('cause')
  })

  it.each([
    [401, 'WEB_PROVIDER_AUTH_FAILED'],
    [403, 'WEB_PROVIDER_AUTH_FAILED'],
    [429, 'WEB_PROVIDER_RATE_LIMITED'],
    [502, 'WEB_PROVIDER_ERROR'],
  ])('retains HTTP %i taxonomy when error detail is malformed', async (status, code) => {
    const failure = await search({ error: { message: ['secret-body-marker'] }, message: { secret: 'secret-body-marker' } }, status)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WebError)
    expect(failure).toMatchObject({ code, message: `xAI API error (HTTP ${String(status)})` })
  })

  it.each([null, [], { error: null }, { error: 123 }, { message: ['secret-body-marker'] }])('uses the HTTP fallback for unrecognized error JSON: %j', async (body) => {
    await expect(search(body, 429)).rejects.toMatchObject({ code: 'WEB_PROVIDER_RATE_LIMITED', message: 'xAI API error (HTTP 429)' })
  })
})
