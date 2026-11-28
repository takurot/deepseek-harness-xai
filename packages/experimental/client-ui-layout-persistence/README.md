---
description: "Experimental Web plugin that restores and saves the frame's sidebar and right-panel width preferences in browser local storage."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-layout-persistence

English | [中文](README.zh.md)

## Summary

Keeps the Web frame's shape across page reloads. It saves the frame-wide sidebar preference (closed, or an open width) and the right-panel width preference (never opened, or a width) in browser local storage, and applies them once at startup. It registers no tool, prompt section, Session event, or service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a client composition that provides `layout` and `configForms`. The Host row id is `layout`, so the settings namespace is `layout`.

| Field | Default | Meaning |
| --- | --- | --- |
| `framePersistence` | `local` | `local` restores at startup and saves changes; `off` does neither, and geometry already in memory stays. |
| `minPaneWidth` | `264` | Floor in pixels for a nonzero saved width, applied before the layout's own clamps. |

A saved sidebar of `0` stays closed and a saved right-panel width of `null` stays unset.

Switching the mode to `off` also cancels a pending save. Switching it back to `local` later only resumes saving; it does not restore over the current layout.

### Minimal configuration

```yaml
- id: layout
  name: '@deepseek-ai/dsh-experimental-client-ui-layout-persistence'
```

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The record lives under the local-storage key `dsh.frame-layout.v1` as `{ "version": 1, "sidebar": number, "rightbar": number | null }`. Startup reads it once a ready `layout` settings snapshot arrives (without one the plugin does nothing), validates the version and that each width is a finite non-negative number (or `null` for `rightbar`), floors nonzero widths at `minPaneWidth`, and calls `restoreFrameGeometry`. Later `frameGeometry` changes are debounced by 200 ms, so a drag writes once, and an unchanged geometry is not rewritten.

A missing, corrupt, wrong-version, or wrongly typed record is removed, the default layout stays in place, and one warning is logged. Unavailable storage, a failing read, or a failing write is also logged once and never interrupts the frame; after a failed write, later changes still try to write.

What does not persist: the right panel's dock, tabs, and fullscreen state belong to `@deepseek-ai/dsh-client-ui-sidebar-right`, which already keeps them per Session.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Host `Config` and the settings registration |
| `src/settings.ts` | Namespace, defaults, and the settings type |
| `src/client/index.ts` | Settings subscription and storage access |
| `src/client/persistence.ts` | Restore once, debounced save, mode changes |
| `src/client/storage.ts` | Key, version, validation, and serialization |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-client-ui-layout`](../../client/ui-layout/README.md) — owns the frame geometry this package saves and restores.
- [`@deepseek-ai/dsh-client-ui-sidebar-right`](../../client/ui-sidebar-right/README.md) — owns the right panel's per-Session state.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only stores two window widths in the browser; it registers no tool, prompt section, or model input.

#### KV Cache effect

No effect. The package never constructs a model request and never mutates a prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental.** The package carries no product-support commitment and is not mounted by the default Web bundle.
- **Per browser profile.** Local storage is per origin, so the layout does not follow the user across browsers or devices.
- **A change made within 200 ms of closing the tab can be lost.** The pending write is dropped on unload.
- **No recorded-session snapshot.** The plugin is browser-only and writes no Session event; jsdom unit tests cover restore, clamping, corruption, `off`, and storage failures.
- **No dedicated settings page yet.** The two fields currently appear through the generic Host plugin-configuration surface with no localized page of their own, so the dictionary-backed setting labels required by the issue (acceptance 7) are deferred; enabling the package as an optional bundle row is the current path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin restores only the two frame-owned width preferences; the right panel's expanded, docked, and fullscreen state stays with `ui-sidebar-right` per Session, so the two persistence stores never write the same field.

</details>
