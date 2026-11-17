---
kind: upgrade-guide
description: "`web_fetch` now returns extracted PDF text instead of rejecting `application/pdf`, adding a `pdf` arm to the closed `WebFetchBody` union."
---
# `web_fetch` extracts PDF text

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-web-fetch-http` used to reject an `application/pdf` response with `WEB_UNSUPPORTED_CONTENT_TYPE`. It now extracts the page text in a Worker Thread and returns a `WebFetchResult` whose `body` is the new `pdf` arm: `{ kind: 'pdf', content, pageCount, pagesExtracted }`. `content` joins page text with U+000C FORM FEED. `maxPdfPages` (default `50`) bounds extracted pages, `maxBodyChars` also bounds the extracted text, and `truncated` reports either cut. A scanned PDF returns empty page spans, and OCR remains out of scope.

A response over `maxResponseBytes` fails as `WEB_FETCH_TOO_LARGE` instead of returning a partial document, and a corrupt, encrypted, or unsupported PDF fails as `WEB_PDF_UNREADABLE`. A failure inside the extraction Worker is `WEB_PROVIDER_ERROR`.

Code affected by the change: external TypeScript consumers of the published `WebFetchBody` type whose exhaustive `switch` ends in `assertNever` must handle the `pdf` arm, and callers that pass `HttpFetchLimits` must supply `maxPdfPages`. Model-facing tool users need no change.

## Migration

1. In every `switch (result.body.kind)` over `WebFetchBody`, add a `pdf` case that handles `content`, `pageCount`, and `pagesExtracted`; keep the `assertNever` default.
2. Supply `maxPdfPages` in every `HttpFetchLimits` value, or set `maxPdfPages` in the provider's plugin config.
3. Raise `maxResponseBytes` for a deployment that fetches PDFs larger than the 5,000,000-byte default.
4. Confirm the migration with `pnpm run typecheck`; no `WebFetchBody` switch remains without a `pdf` case.
