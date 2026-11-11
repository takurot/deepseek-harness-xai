---
kind: upgrade-guide
description: "Keychain record operations recover pending transactions before reading or writing; older providers cannot recover these transactions."
---

# Recover Keychain records before downgrading

English | [中文](guide.zh.md)

## Change

The opt-in credentials-keychain provider stores a pending record/index transaction before updating either item. It completes interrupted transactions on startup and before subsequent record operations. Failed commits report an unknown stored outcome rather than implying unchanged credentials. Older providers do not understand pending transactions or participate in the OS-user/service writer lock.

## Migration

1. On Linux architectures other than arm64 or x64, keep using `credentials-local`; the prebuilt POSIX lock binding is unavailable. Stop older processes and external writers using the same Keychain service before upgrading. Updated processes share a fixed OS-user/service lock identity; separate `DSH_HOME` values do not isolate writes to one service.
2. If a record operation fails, reopen the updated provider and inspect `readRecord` and `listRecords` before retrying. Mutation callbacks are not automatically repeated.
3. Before downgrading or starting an older provider against that service, let the updated provider recover successfully. Verify the expected record and list entry agree. Preserve the store if recovery refuses a corrupt transaction; repair requires inspecting the affected items without exposing their values in diagnostics.

Lock acquisition waits 30000 milliseconds by default. Set a positive safe integer through `lockWaitMs` in `cordis.yml` to change that budget. Expiry does not start the mutation; disposing the provider cancels acquisition waits but does not force-stop callbacks already running.
