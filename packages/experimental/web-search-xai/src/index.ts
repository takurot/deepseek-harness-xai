/**
 * Register an xAI-backed provider in `ctx.web`. It calls the Responses API with the server-side
 * `web_search` (and optionally `x_search`) tool, so one search is one Grok model call plus per-call
 * search charges. The provider reports itself not ready when no xAI API key is available, which
 * hides `web_search` from the model instead of failing at call time.
 * @module @deepseek-ai/dsh-web-search-xai
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import {
  XaiSearchProvider,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_MODEL,
  XAI_DEFAULT_TIMEOUT_MS,
} from './provider.ts'
import type { XaiSearchProviderOptions, XaiSearchSource } from './provider.ts'

export {
  XaiSearchProvider,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_MODEL,
  XAI_DEFAULT_TIMEOUT_MS,
  XAI_PROVIDER_ID,
  mapXaiResponse,
} from './provider.ts'
export type { XaiResponse, XaiSearchProviderOptions, XaiSearchSource } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-xai'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'XAI_API_KEY'

/** Plugin config (all optional — defaults come from the schema). */
export interface Config {
  /** Literal xAI API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `XAI_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Responses API base, including `/v1`; `/responses` is appended. */
  baseURL: Volatile<string>
  /** Grok model that runs the search turn. */
  model: Volatile<string>
  /** Server-side search tools: `web`, `x` (X posts and profiles). */
  sources: Volatile<XaiSearchSource[]>
  /** Whole-search timeout including credentials and response reading, at most the Node timer limit. */
  timeoutMs: Volatile<number>
}

/* jscpd:ignore-start -- Config fields parallel web-search-deepseek; each provider owns its defaults. */
export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(XAI_DEFAULT_BASE_URL).volatile(),
  model: z.string().default(XAI_DEFAULT_MODEL).volatile(),
  sources: z.array(z.union([z.const('web'), z.const('x')])).default(['web']).volatile(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(XAI_DEFAULT_TIMEOUT_MS).volatile(),
})
/* jscpd:ignore-end */

/**
 * Read and validate the xAI key. An installed credentials service is authoritative, including absence;
 * only deployments without that service read the launch environment. Store and format failures propagate.
 */
async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    return hit === undefined ? undefined : assertUsableApiKey(hit.value, 'web-search-xai', ref)
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient === undefined || ambient.value.length === 0 ? undefined : assertUsableApiKey(ambient.value, 'web-search-xai', ref)
}

/** Check key presence without resolving or validating the stored value; a failed read answers false. */
async function keyConfigured(ctx: Context, ref: CredentialRef): Promise<boolean> {
  try {
    const credentials = ctx.get('credentials')
    return credentials === undefined
      ? (launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) > 0
      : (await credentials.describe(ref)).configured
  } catch (_unreadableStore) { return false /* A store that cannot be read supplies no key to the search either. */ }
}

/**
 * Register the xAI search provider with `ctx.web`. Its `ready()` answers whether a search would
 * have a credential to send, without a network call.
 */
export function apply(ctx: Context, config: Config): void {
  const ref = (): CredentialRef => credentialRef(config.apiKeyEnv.get())
  const options = (): XaiSearchProviderOptions => {
    const literal = config.apiKey.get()
    return {
      ...literal !== undefined && literal.length > 0 ? { apiKey: literal } : {},
      resolveApiKey: () => resolveApiKey(ctx, ref()),
      apiKeyEnv: config.apiKeyEnv.get(),
      baseURL: config.baseURL.get(),
      model: config.model.get(),
      sources: config.sources.get(),
      timeoutMs: config.timeoutMs.get(),
    }
  }
  const provider = new XaiSearchProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    title: provider.title,
    description: provider.description,
    available: () => provider.available(),
    ready: async () => {
      const literal = config.apiKey.get()
      return (literal !== undefined && literal.length > 0) || await keyConfigured(ctx, ref())
    },
    search: (request, signal) => provider.search(request, signal),
  })
}
