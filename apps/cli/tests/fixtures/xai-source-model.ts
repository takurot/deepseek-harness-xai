/** Deterministic conversation adapter and external xAI HTTP fixture for checkout acceptance. */
import { apply as applyHttpFixture } from './xai-source-http.ts'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

class XaiFixtureAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result === undefined) {
      const visible = options.tools?.some(tool => tool.name === 'web_search') === true
      process.stdout.write(`XAI_SEARCH_VISIBLE ${String(visible)}\n`)
      process.stdout.write(`XAI_FETCH_VISIBLE ${String(options.tools?.some(tool => tool.name === 'web_fetch') === true)}\n`)
      if (visible) {
        const call = { type: 'tool-call' as const, id: ToolCallId('xai-source-call'), name: 'web_search', arguments: JSON.stringify({ queries: ['xAI'] }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
    }
    const text = result === undefined ? 'Search is unavailable.' : result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Services needed by the fixture's conversation adapter. */
export const inject = ['llm', 'web']

/**
 * Replace only conversation nondeterminism and external search HTTP.
 * @param ctx - Loader-owned fixture context.
 * @param config - Optional startup verification.
 */
export function apply(ctx: Context, config: {
  probeProviderMissing?: boolean
  verifyModel?: boolean
  verifyCredentials?: boolean
  verifyFetch?: boolean
}): void {
  ctx.effect(() => ctx.llm.registerAdapter(['xai-fixture'], new XaiFixtureAdapter()))
  applyHttpFixture(ctx)
  if (config.probeProviderMissing === true || config.verifyModel === true
    || config.verifyCredentials === true || config.verifyFetch === true) {
    const ready = ctx.get('appReady')
    const exit = ctx.get('appExit')
    if (ready === undefined || exit === undefined) throw new Error('Profile probe requires app lifecycle services')
    const probe = async (): Promise<void> => {
      if (config.verifyCredentials === true) process.stdout.write(`XAI_CREDENTIALS_PROVIDER ${ctx.get('credentials')?.constructor.name}\n`)
      const providers = ctx.web.listProviders().search.map(provider => provider.id)
      process.stdout.write(`XAI_REGISTERED_PROVIDERS ${JSON.stringify(providers)}\n`)
      if (config.verifyFetch === true) {
        const url = process.env.DSH_XAI_FETCH_URL
        if (url === undefined) throw new Error('Fetch probe requires its loopback fixture URL')
        const result = await ctx.web.fetch({ url })
        process.stdout.write(`XAI_FETCH_RESULT ${result.body.content}\n`)
      }
      if (config.verifyModel === true) {
        const model = await ctx.llm.resolveModelInfo('xai', 'grok-4')
        process.stdout.write(`XAI_MODEL ${model.provider}/${model.id}\n`)
      }
      if (config.probeProviderMissing === true || config.verifyModel === true || config.verifyFetch === true) exit(0)
    }
    ctx.effect(() => ready.onReady(() => {
      void probe().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        exit(1)
      })
    }))
  }
}
