---
kind: upgrade-guide
description: "Keychain record operations recover pending transactions before reading or writing; older providers cannot recover these transactions."
---

# Recover Keychain records before downgrading

English | [中文](guide.zh.md)

## Change

The opt-in credentials-keychain provider stores a pending record/index transaction before updating either item. It completes interrupted transactions on startup and before subsequent record operations. Failed commits report an unknown stored outcome rather than implying unchanged credentials. Older providers do not understand pending transactions.

## Migration

1. Stop other processes using the same Keychain service before upgrading.
2. If a record operation fails, reopen the updated provider and inspect `readRecord` and `listRecords` before retrying. Mutation callbacks are not automatically repeated.
3. Before downgrading or starting an older provider against that service, let the updated provider recover successfully. Verify the expected record and list entry agree. Preserve the store if recovery refuses a corrupt transaction; repair requires inspecting the affected items without exposing their values in diagnostics.
