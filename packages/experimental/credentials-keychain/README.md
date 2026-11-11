---
description: "The OS-keychain credentials provider for users and maintainers who want API keys out of a plaintext file: configuration, layering, what it does and does not protect."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-keychain

English | [中文](README.zh.md)

## Summary

`dsh-credentials-keychain` keeps API keys and other credentials in the operating system's secret store — the macOS Keychain or the Linux Secret Service — instead of the plaintext `.credentials.yaml` that `dsh-credentials-local` writes. It implements the same `ctx.credentials` service, so adapters and configuration UIs need no change. It removes the plaintext file; it does not by itself hide keys from an agent's shell (see [Known Limitations](#known-limitations-and-deferred-work)).

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

Load it in place of `dsh-credentials-local`; both implement the same service, so a composition loads one of them.

```yaml
- name: '@deepseek-ai/dsh-credentials-keychain'
  config:
    service: dsh
```

| Field | Default | Meaning |
|---|---|---|
| `service` | `dsh` | Keychain service name shared by every item. Letters, digits, `.`, `_`, and `-` only; anything else fails at load |
| `lockWaitMs` | `30000` | Maximum time to acquire the OS-user/service writer lock; a positive safe integer in milliseconds |

### Where keys come from

A reference resolves from the first layer that holds a non-empty value: the OS keychain (source `keychain`), the inherited process environment (`env`), the invoking project's `.env` (`project-env`), then `$DSH_HOME/.env` (`user-env`). The keychain wins so a key saved in the product takes effect over an exported variable, as with the local provider. Only the keychain layer is writable.

### Platforms

macOS uses the system `osascript` JavaScript bridge for Security API operations and `security` for legacy items; neither requires installation. Linux uses `secret-tool` from libsecret and a running Secret Service session (GNOME Keyring or KeePassXC); a headless server usually has neither. The prebuilt POSIX lock binding supports macOS and Linux on arm64 and x64; other architectures must use `credentials-local`. Windows has no supported store yet. An unsupported platform, a missing tool, or an unreachable store fails when the plugin loads, never later at the first lookup.

### Moving existing keys

Nothing is migrated automatically. Save each key again through the configuration UI or `ctx.credentials.set`, then delete the old `.credentials.yaml`. A migration command is deferred.

<a id="understand-the-implementation"></a>
## Understand the implementation

A reference uses logical account `ref:<NAME>`; a record uses `record:<scope>/<id>` and holds its JSON. An item with account `index` lists the record keys, because the platform tools cannot enumerate items by service. Secret values reach the tools through stdin or stdout, never the argument vector, which other processes of the same user can read through `ps`. macOS operations pass JSON through stdin to the Security APIs, preserving long grants, Unicode, quotes, newlines, and trailing spaces without an interactive line limit. Native items use account `v2:<account>` and base64 values; the same JXA identity reads and writes them without changing legacy access settings. Reads prefer a native successor and fall back to an unversioned item through `security` only when no successor exists. Writes retain old physical copies until deletion. Deletion removes the legacy item first, then the successor, so a failed deletion cannot reveal an older credential. Do not run older providers against the same service: they cannot see successors and may read stale legacy values. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-alpha.3/keychain-macos-native-items/guide.md).

Records use the [shared JSON validation](../../credentials/credentials/README.md#understand-the-implementation) before a transaction is created and when stored records or transaction replacements are read. Invalid data stops the operation before any item changes; parser errors do not expose stored text or causes.

`backend.ts` holds the two platform backends over an injectable command runner; `index.ts` holds `Config`, layering, record validation, and the write queue. Record operations and reference writes hold one exclusive OS-user/service lock across processes, including asynchronous mutation callbacks. A `record-transaction-v1` item saves the complete replacement and target index before either changes; startup and later record operations complete interrupted transactions before reading or mutating records. Corrupt or inconsistent transactions stop record operations without overwriting saved items. Only this provider's writes and completed repairs emit `credentials/reference-updated` and `credentials/record-updated`. Record notifications follow record/index updates and journal removal; a crash after removal may lose the notification. A failed record commit or repair throws `KeychainCommitError` (`code: KEYCHAIN_COMMIT_UNKNOWN`, `outcome: unknown`), which does not promise unchanged storage. Reopen the provider to attempt recovery, then inspect the credential before retrying; mutation callbacks are never retried automatically. Older versions cannot recover a pending journal: complete recovery before downgrading or accessing the same service from an older process.

The native POSIX lock binding owns a persistent file under `<OS user home>/.dsh-keychain-locks/`, named by the service's SHA-256 hash. This identity does not depend on `DSH_HOME`, the profile, or the working directory. Unsafe directory/file ownership or permissions fail before store access. The runner passes the locked open-file description to helpers as descriptor 3; the kernel releases it only after all copies close. Acquisition expiry never starts the operation. Disposal cancels acquisition and drains accepted operations; cancellation of an already-running mutation callback remains its caller's responsibility.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider, config, layering, records, write queue |
| [`src/backend.ts`](src/backend.ts) | macOS and Secret Service backends, command runner |
| [`src/service-lock.ts`](src/service-lock.ts) | Private lock-file validation and bounded POSIX lock acquisition |

<a id="further-exploration"></a>
## Further Exploration

- [dsh-credentials](../../credentials/credentials/README.md) — the service this provider implements.
- [dsh-credentials-local](../../credentials/credentials-local/README.md) — the file-backed provider this package is the keychain counterpart of.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.credentials`, which own any model-facing behavior a stored value enables.

#### KV Cache effect

No direct invalidation; stored values never enter a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A same-UID process can still read the keys** — an agent shell can invoke `osascript` for native macOS items, `security` for legacy items, or `secret-tool` for Linux items using your OS user permissions. This package removes the plaintext file, not that read path; closing it needs an access list limited to a signed harness binary and a sandbox profile that denies keychain access.
- **External changes are invisible** — edits made in Keychain Access or by other tools emit no event and are seen at the next resolve.
- **Only cooperating processes share the lock** — older provider versions and external secret-store writers do not acquire it; stop them before upgrading or updating the same service.
- **Windows is unsupported**, and Linux needs a Secret Service session.
- **No migration command** — keys move by being saved again.
- **Items are visible in the keychain UI** — account names reveal which references and record keys exist, never values.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Command-line clients versus a native binding

Secret-store access stays in platform tools; the existing system addon owns POSIX locking. A binding such as `@napi-rs/keyring` would add Windows and in-process access without child processes, and would let an item's access list name the harness. That is a dependency decision for maintainers.

#### Graduating out of experimental

This package lives under `packages/experimental`; moving it beside `credentials-local` needs a product-use classification.

</details>
