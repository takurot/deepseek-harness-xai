/**
 * Deterministic search provider for the partial-failure snapshot: two of three
 * queries succeed and the third throws, so the aggregate records a partial
 * failure without contacting any network.
 */
/** Cordis plugin name. */
export const name = 'web-search-partial-fixture'

/** Service whose registry receives the fixture provider. */
export const inject = ['web']

/** Provider id that the composition selects for search. */
const PROVIDER_ID = 'partial-fixture'

/**
 * Register the deterministic search provider; the registration is an effect so
 * disposing the plugin fiber removes it.
 * @param ctx - Cordis context carrying the web service.
 */
export async function apply(ctx) {
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    title: 'Partial fixture',
    available: () => true,
    async search(request) {
      if (request.query === 'beta') {
        // A provider throw without a typed code: the aggregate records it as a
        // per-query failure and reports the generic provider code.
        throw new Error('fixture search failed for "beta"')
      }
      return {
        content: `Fixture answer for ${request.query}.`,
        sources: [{
          url: `https://${request.query}.test/result`,
          title: `Result ${request.query}`,
          snippet: `Snippet for ${request.query}.`,
        }],
        truncated: false,
      }
    },
  }))
}
