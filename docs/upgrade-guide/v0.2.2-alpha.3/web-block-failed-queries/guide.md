---
kind: upgrade-guide
description: WebBlockLabels now requires a failedQueries label, and a web search card shows the queries whose searches failed.
---

# Web search cards list failed queries

English | [中文](guide.zh.md)

## Change

A multi-query `web_search` no longer discards its successful results when one query fails. The completed web-search card now shows the failed queries, so `WebBlockLabels` in `@deepseek-ai/dsh-client-ui-primitives` requires a new `failedQueries` label string. Code that builds `WebBlockLabels` values — a deck that renders `WebBlock` with its own labels — stops compiling until it supplies the label. Delegations that already pass the conversation plugin's labels are unaffected.

`WebSearchBlockProps` accepts an optional `failedQueries` list of `{ query, code }`, and `WebSearchResultView` in `@deepseek-ai/dsh-tools` carries the same optional field. Both are additive: omitting the field renders the card exactly as before. The labels the chat tool row passes are built by `webBlockLabels` in `@deepseek-ai/dsh-client-ui-tool`, whose strings come from the `conversation` locale dictionaries.

## Migration

1. Add the label to every `WebBlockLabels` value you construct, for example `failedQueries: 'Failed queries'`. Keep it next to the existing `noResults` and `sourcesTruncated` labels, and translate it per locale.
2. Forward the field from a completed result when you build the card: pass `resultView.failedQueries` (or the tool result metadata's `failedQueries`) as `WebSearchBlockProps.failedQueries`. Omit it when the array is empty.
3. Verify that a `web_search` call whose queries partially fail renders one row per failed query under the label, and that a fully successful call renders none. `pnpm run verify-client-ui-i18n` confirms the label string lives in a locale dictionary rather than in component code.
