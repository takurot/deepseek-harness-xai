---
kind: upgrade-guide
description: "macOS Keychain writes use versioned native items that older credential providers cannot read."
---

# Use the native macOS credential items

English | [中文](guide.zh.md)

## Change

The opt-in credentials-keychain provider writes macOS values through `osascript` under `v2:<account>`. Native reads prefer these successors; an absent successor falls back to the old `security` item. Permission failures do not fall back. This avoids changing legacy item permissions while supporting long credentials. Linux storage is unchanged.

Old physical items remain until deletion. Older binaries cannot read successors and can return stale legacy values. Native items are accessible through the same OS-user `osascript` identity; the provider does not conceal credentials from a same-user shell. External scripts using `security` do not automatically gain access to native successors.

## Migration

1. Stop older processes using the same Keychain service before upgrading. Keep them stopped while native successors are in use.
2. Continue using the credentials service. It reads legacy values and writes successors automatically. Verify the expected record with `readRecord` and `listRecords` after saving.
3. Use the updated provider's `unset` or `deleteRecord` to remove both generations. A failed deletion can leave the current value in place; inspect and retry. Deletion removes legacy first so an interrupted operation cannot reveal a stale value.
4. Before downgrading, export or resave the intended credentials through a compatible provider without logging their values. Do not assume retained legacy copies contain the latest credentials.
