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

### Where keys come from

A reference resolves from the first layer that holds a non-empty value: the OS keychain (source `keychain`), the inherited process environment (`env`), the invoking project's `.env` (`project-env`), then `$DSH_HOME/.env` (`user-env`). The keychain wins so a key saved in the product takes effect over an exported variable, as with the local provider. Only the keychain layer is writable.

### Platforms

macOS uses the system `osascript` JavaScript bridge for Security API writes and `security` for reads and deletes; neither requires installation. Linux uses `secret-tool` from libsecret and a running Secret Service session (GNOME Keyring or KeePassXC); a headless server usually has neither. Windows has no supported store yet. An unsupported platform, a missing tool, or an unreachable store fails when the plugin loads, never later at the first lookup.

### Moving existing keys

Nothing is migrated automatically. Save each key again through the configuration UI or `ctx.credentials.set`, then delete the old `.credentials.yaml`. A migration command is deferred.

<a id="understand-the-implementation"></a>
## Understand the implementation

Each reference is one keychain item with account `ref:<NAME>`; each record is one item with account `record:<scope>/<id>` holding its JSON. An item with account `index` lists the record keys, because the platform tools cannot enumerate items by service. Secret values reach the tools through stdin or stdout, never the argument vector, which other processes of the same user can read through `ps`. macOS writes pass JSON through stdin to the Security APIs, preserving long grants, Unicode, quotes, newlines, and trailing spaces without an interactive line limit. Base64 storage remains compatible with existing items. New items trust `/usr/bin/osascript` and `/usr/bin/security`; updates preserve existing access settings. Failed writes report no helper output.

`backend.ts` holds the two platform backends over an injectable command runner; `index.ts` holds `Config`, layering, record validation, and the write queue. Record operations run one at a time inside this process. A `record-transaction-v1` item saves the complete replacement and target index before either changes; startup and later record operations complete interrupted transactions before reading or mutating records. Corrupt or inconsistent transactions stop record operations without overwriting saved items. Cross-process exclusion is not yet provided. Only this provider's writes and completed repairs emit `credentials/reference-updated` and `credentials/record-updated`. Record notifications follow record/index updates and journal removal; a crash after removal may lose the notification. A failed record commit or repair throws `KeychainCommitError` (`code: KEYCHAIN_COMMIT_UNKNOWN`, `outcome: unknown`), which does not promise unchanged storage. Reopen the provider to attempt recovery, then inspect the credential before retrying; mutation callbacks are never retried automatically. Older versions cannot recover a pending journal: complete recovery before downgrading or accessing the same service from an older process.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider, config, layering, records, write queue |
| [`src/backend.ts`](src/backend.ts) | macOS and Secret Service backends, command runner |

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

- **A same-UID process can still read the keys** — the `security` and `secret-tool` clients answer any process of your OS user without a prompt, so an agent shell can run `security find-generic-password -s dsh -a ref:NAME -w`. This package removes the plaintext file, not that read path; closing it needs an access list limited to a signed harness binary and a sandbox profile that denies keychain access.
- **External changes are invisible** — edits made in Keychain Access or by other tools emit no event and are seen at the next resolve.
- **No cross-process write lock** — two harness processes updating one record can lose an update.
- **Windows is unsupported**, and Linux needs a Secret Service session.
- **No migration command** — keys move by being saved again.
- **Items are visible in the keychain UI** — account names reveal which references and record keys exist, never values.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Command-line clients versus a native binding

The package shells out to the platform tools to avoid a native dependency. A binding such as `@napi-rs/keyring` would add Windows and in-process access without child processes, and would let an item's access list name the harness. That is a dependency decision for maintainers.

#### Graduating out of experimental

This package lives under `packages/experimental`; moving it beside `credentials-local` needs a product-use classification.

</details>
