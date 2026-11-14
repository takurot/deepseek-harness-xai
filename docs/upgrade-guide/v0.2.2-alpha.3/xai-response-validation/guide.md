---
kind: upgrade-guide
description: xAI search requires terminal response status and validated output fields, and XaiResponse now requires status and output.
---

# xAI search response validation

English | [中文](guide.zh.md)

## Change

The experimental `@deepseek-ai/dsh-web-search-xai` provider accepts successful search output only when the Responses API reports `status: completed`. Incomplete answers, including answers with citations, fail as `WEB_PROVIDER_ERROR`. Malformed consumed fields also fail. The exported `XaiResponse` type now requires `status` and `output`, and item discriminators must be strings. Direct callers of `mapXaiResponse` and HTTP fixtures are affected.

## Migration

1. Update `XaiResponse` values passed to `mapXaiResponse` to include `status: 'completed'` and an `output` array. Represent incomplete responses with `status: 'incomplete'` and handle `WEB_PROVIDER_ERROR`.
2. Update Responses API fixtures to include string item discriminators, message `content` arrays, and `output_text` blocks with string `text` and `annotations` arrays. Each `url_citation` must have a nonempty string `url`. Unused citation offsets and titles remain optional.
3. Verify that completed cited responses succeed and incomplete responses produce structured errors without exposing partial answers. Keep `truncated` for source-count limits applied by the web service.
