---
kind: upgrade-guide
description: "Durable credential providers reject malformed records and grant payloads that cannot survive JSON storage."
---

# Store credential records as plain JSON data

English | [中文](guide.zh.md)

## Change

`credentials-local` and the opt-in `credentials-keychain` now share record validation. Keychain records with wrong-typed API keys or environment values, missing grant payloads, or unknown fields are refused. Both providers reject non-finite numbers, negative zero, nested `undefined`, sparse or extended arrays, cycles, accessors, conversion methods, and custom object instances instead of silently changing their contents during persistence. API-key optional fields with `undefined` normalize to absence. Rejected replacements leave the previous credential unchanged.

## Migration

1. Update credential owners to pass plain JSON data to `modifyRecord`. Represent dates explicitly as strings, omit absent object fields, and supply finite numbers and dense arrays. Keep API keys and environment values as non-empty strings; use an empty `api-key` record for intentional ambient authentication.
2. Preserve the existing store when loading rejects a malformed record or transaction. Repair only the affected record using the owning provider’s documented format; do not discard the store or expose values in diagnostics.
3. Verify a normal `modifyRecord` result equals `readRecord` after reopening the provider. Grant owners remain responsible for validating the meaning of their JSON payloads.
