---
kind: upgrade-guide
description: A rejected DeepSeek account sign-in now fails web search and fetch as WEB_PROVIDER_AUTH_FAILED instead of WEB_PROVIDER_ERROR.
---

# Web search and fetch report an authentication failure

English | [中文](guide.zh.md)

## Change

When DeepSeek rejects the account sign-in used for a web search or fetch, `@deepseek-ai/dsh-web-search-deepseek` and `@deepseek-ai/dsh-web-deepseek-api` now throw a `WebError` with code `WEB_PROVIDER_AUTH_FAILED` instead of `WEB_PROVIDER_ERROR`. The message and the sign-in guidance are unchanged. Code that branches on `WEB_PROVIDER_ERROR` to detect a rejected account token — retry policy, tool error presentation, or callers of `ctx.web.search`/`ctx.web.fetch` — no longer matches. A rejected API key that follows the endpoint-guidance path keeps `WEB_PROVIDER_ERROR`.

## Migration

1. Branch on `WEB_PROVIDER_AUTH_FAILED` where you currently treat `WEB_PROVIDER_ERROR` from these providers as a sign-in rejection. Keep `WEB_PROVIDER_ERROR` for transport, malformed-response, and endpoint-configuration failures.
2. If you surface the code to users, route `WEB_PROVIDER_AUTH_FAILED` to the "sign in again" flow and leave the endpoint settings untouched.
3. Verify that a 401 for an account token yields `WEB_PROVIDER_AUTH_FAILED` with the sign-in message, and that a network failure still yields `WEB_PROVIDER_ERROR`. `pnpm exec vitest run packages/web/web-deepseek-api/tests packages/web/web-search-deepseek/tests` covers both.
