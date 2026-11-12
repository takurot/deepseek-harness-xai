---
kind: upgrade-guide
description: "Keychain commands now enforce deadlines and byte limits, refusing unreadable or truncated writes before changing storage."
---

# Set Keychain command budgets

English | [中文](guide.zh.md)

## Change

The opt-in credentials-keychain provider limits each OS command to 30000 milliseconds and 4194304 combined stdout/stderr bytes by default. It sends TERM, allows 1000 milliseconds, then kills the owned process group and waits for descriptor cleanup. Cancellation and deadlines remain failures even when a handler exits 0. Disposal aborts all owned commands and waits for them.

Values that cannot fit their complete read-back are refused before storage changes. Linux's secret-tool stdin transport also limits each item to 8192 UTF-8 bytes; larger references, records, indexes, or journals are now rejected instead of risking truncation. Increasing the output budget does not raise this intrinsic limit. Low-level nonzero command results no longer return raw output: stdout is empty and stderr is `!` when diagnostics were present.

## Migration

1. Review `commandTimeoutMs`, `commandOutputLimitBytes`, and `commandKillGraceMs` in the credentials-keychain row of `cordis.yml`. Timers require positive integers no greater than 2147483647; output limits must fit Node's Buffer and string limits.
2. If an item exceeds the read-back budget, increase the configured output limit before saving. For Linux items above 8192 bytes, use another provider; existing stored credentials are preserved on refusal.
3. After an in-flight write fails, inspect the credential before retrying. Reopen the provider to recover pending record transactions. `KEYCHAIN_STORAGE_LIMIT` with outcome `unchanged` is a preflight refusal; `KeychainCommitError` and started-command failures can mean the write took effect. Mutation callbacks are not automatically repeated.
