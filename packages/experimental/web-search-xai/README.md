---
description: "The xAI-backed search provider for ctx.web: how deployments mount Grok server-side web and X search through the Responses API, with per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-xai

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-xai`, the harness searches the web, and optionally X, through xAI's server-side `web_search` and `x_search` tools using an `XAI_API_KEY`. Choose it when a deployment routes models through xAI or another non-DeepSeek provider and still wants `web_search`, and accepts that one search is a full Grok model call plus per-call search charges. The answer text becomes `content` and the structured `url_citation` annotations become `sources[]`; URLs are never read from the answer text. The provider is not ready without a key, so `dsh-tool-web` withholds `web_search` from that request; a response without citations fails with a structured error.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service. It registers as the `xai` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend, or pin it with `searchProvider: xai`.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-xai'
  config:
    apiKeyEnv: XAI_API_KEY
    sources: [web, x]
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal xAI API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over `apiKeyEnv` |
| `apiKeyEnv` | `XAI_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that service is absent. A search that finds no key fails as `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `baseURL` | `https://api.x.ai/v1` | Responses API base; `/responses` is appended. An unparseable value makes the provider unavailable |
| `model` | `grok-4.7` | Grok model that runs the search turn |
| `sources` | `[web]` | Server-side tools to enable: `web` adds `web_search`, `x` adds `x_search`. An empty list makes the provider unavailable |
| `timeoutMs` | `60000` | Whole-search timeout, including credentials, HTTP request, and body reads, from `1` to `2147483647` ms; expiry fails as `WEB_TIMEOUT` |

The generated [configuration catalog](../../../docs/config-catalog.md) lists every accepted field.

### What a search returns

`content` is the joined `output_text` of the response. `sources[]` holds one URL-only entry per distinct `url_citation` annotation; xAI's annotation `title` is the visible citation number, so it is not used as a title. The service enforces `maxResults`; `truncated` means it capped the source count. Only a `completed` response succeeds. An `incomplete` response fails as `WEB_PROVIDER_ERROR`, even when it contains citations, and its partial answer is discarded. Missing or invalid consumed fields, nonterminal or unknown statuses, and a response with no `url_citation` also fail as `WEB_PROVIDER_ERROR`. Unknown string item types and unused extra fields are ignored.

### Failures and recovery

HTTP 401 and 403 fail as `WEB_PROVIDER_AUTH_FAILED`, 429 as `WEB_PROVIDER_RATE_LIMITED`, other statuses and transport failures as `WEB_PROVIDER_ERROR`, a timeout as `WEB_TIMEOUT`, and cancellation as `WEB_ABORTED`. The deadline starts before credential resolution and covers HTTP headers and both success and error bodies. Cancellation ends credential waiting without stopping the underlying read; a late result cannot start an HTTP request. The first cancellation cause wins: caller cancellation remains `WEB_ABORTED`, even when its reason is another timeout. Redirects are errors.

<a id="understand-the-implementation"></a>
## Understand the implementation

`provider.ts` holds the HTTP call and response mapping; `index.ts` holds `Config`, credential resolution, and registration. `ready()` checks key presence through `ctx.credentials.describe` (or the launch environment without that service) and makes no network call, so a wrong key counts as ready and fails each call. The request goes through the process-wide proxy dispatcher.

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — the search request/result vocabulary and error codes.
- [Web package map](../../web/README.md) — the web package family.
- [dsh-web](../../web/web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../../web/tool-web/README.md) — the model-facing `web_search` tool.
- [dsh-web-search-deepseek](../../web/web-search-deepseek/README.md) — the DeepSeek counterpart this package mirrors.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary xAI search request

#### What the model sees

A separate Grok model receives `Perform a web search for the query: <query>` as input and the enabled server-side search tools. This request is not part of the conversation model's context.

#### Token effect

Separate provider input and output tokens are incurred for each search, plus xAI's per-call search charges (web search is billed per call; X search per post or profile fetched, per xAI's pricing page).

#### KV Cache effect

Independent of the conversation request cache.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees the answer text and deduplicated source URLs. Failures appear as the messages above: `xAI API error (HTTP <status>)` with xAI's detail, `xAI search timed out after <n> ms`, `xAI search aborted`, `xAI returned an incomplete search response`, `xAI returned an invalid response field: <path>`, `xAI returned no cited sources; ...`, and the missing-key message naming the credential reference.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with the answer length and the returned sources.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

### Conversation tool list, indirectly

#### What the model sees

While this provider is selected, a request for which it is not ready carries neither the `web_search` schema nor its prompt guidance; [`dsh-tool-web`](../../web/tool-web/README.md#search-readiness) owns that effect.

#### Token effect

Withholding removes the `web_search` schema and guidance from the request.

#### KV Cache effect

A returning or removed `web_search` changes the declared tools as `dsh-tool-web` describes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One search is a full Grok model call** — latency, tokens, and per-call charges; a dedicated retrieval API would be cheaper.
- **Readiness checks presence, not validity** — a wrong key counts as ready and each call fails with `WEB_PROVIDER_AUTH_FAILED`.
- **Sources are URL-only** — xAI's annotations carry no page title, date, or snippet.
- **The default model name is unverified against the live API** — it follows the xAI documentation's examples; the real-API test (`XAI_API_KEY`) has not been run in this repository's CI.
- **`x_search` is billed per fetched item** — the cost of a search with `x` enabled is not bounded by one call.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Other search backends on the same template

A plain retrieval REST API such as Tavily or Brave could reuse this provider shape (`ready()` checks only the credential, `search()` maps results to `sources[]`) and would be cheaper than a full model call. None is implemented, and their response fields are unverified.

</details>
