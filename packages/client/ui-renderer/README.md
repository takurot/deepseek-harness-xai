---
description: "Browser UI renderer: React bindings for ordinary Slots and reusable Component Factories, ctx.uiRenderer, and the assembled dsh web application root."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-renderer

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-renderer` mounts the assembled dsh web client GUI: after the complete client plugin roster settles, the boot kernel calls `ctx.uiRenderer.mount(container)`, which hydrates the framework-free boot page and switches to the full React application before the next paint. Business plugins stay plain React components that receive session and workspace data through typed props and never wire subscriptions themselves — the renderer binds the runtime's bare observable sources into selector hooks at the slot outlets. The web shell and the boot kernel are its only direct consumers, so a composition needs it exactly when it wants a React-rendered GUI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Render failures and diagnostics](#render-failures-and-diagnostics)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is infrastructure: the web shell and the boot kernel are its only direct consumers. A composition needs it whenever it wants a React-rendered GUI — `dsh-client-web` loads the roster, waits for it to settle and for the boot audit to accept it, then calls `ctx.uiRenderer.mount(container)`.

### What mounting does

`mount(container)` installs the slot renderer, hydrates the existing boot DOM when present, renders the assembled application into the container before the next paint, and returns a disposer that unmounts the React root. The renderer performs the sole context-level `renderSlot('root')` call; the registered root occupant owns product layout and document metadata.

### For business plugins

A business plugin registers an ordinary Slot entry or a reusable Component Factory; the renderer binds the runtime's session and workspace observable sources into selector hooks at the render position. The plugin receives standard scope props through its derived Component props — it never imports the renderer or touches React internals. Every renderer-created Component can render a Factory occurrence, and a Factory can expose caller-selected local Components without sharing implementation values between packages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one boundary: the object layer (runtime, React-free) owns business state; this renderer is the only place ctx-to-React integration happens — slot renderer, `SessionProvider`, and the `useSyncExternalStore` adapter.

### Activation and mount

The plugin activates after `slots`, `sessions`, and `layout`; it installs `createSlotRenderer()` and reflects the `uiRenderer` service. `mountApp` looks for the boot kernel's `[data-dsh-boot]` element: when present it hydrates through `BootHandoff` (a one-frame pass-through that preserves the loading DOM), otherwise it creates a fresh root and flushes the render synchronously.

### Slot bindings

`createSlotRenderer` connects the slot registry to React: ordinary entry lists and Factory definitions become reactive sources, and each outlet or occurrence renders through the installed renderer. Business plugins pass bare observable sources through typed `hooks`; the renderer binds them at the render position via the uSES adapter. A Factory Store factory stays lazy until an occurrence first materializes; its exclusive handle rejects persistence, render-time records stay weak, and an idempotent effect strongly retains only mounted occurrences while preserving identity across effect replay. Factory errors use the ordinary supervision channel without abdicating the shared definition: the definition and its fallback local Components report against the definition, caller-selected local Components report against the caller registration, and each boundary resets with its own scope incarnation.

### Identity

React, React DOM, Cordis, ui-slots, and ui-primitives retain one browser identity through the web shell's static module table; this package arrives as a dynamic client bundle.

</details>

-----

<a id="render-failures-and-diagnostics"></a>
## Render failures and diagnostics

A crashed `root` registration does not leave a blank page. When every root registration has abdicated, `RootOutlet` renders a standalone failure screen: a localized heading and explanation, a Reload control, and a collapsible diagnostic view with a Copy control. The screen depends on no slot, store, app frame, or Session data, so the broken tree cannot prevent it from rendering. `RootFailureBoundary` wraps only the renderer's own root subtree, for plumbing errors thrown outside an entry boundary; a `SlotAssemblyError` still rethrows, so a miswired boot fails loud instead of degrading into the fallback. A contained child-slot crash keeps the existing per-entry isolation and never reaches this screen.

The copy separates a browser render failure from a server disconnect: the local server keeps running, and Reload neither restarts it nor deletes Session data.

### Diagnostic records

The renderer records each top-level failure under the browser `localStorage` key `dsh.render-failure.v1`; the key holds a JSON array, newest first, and `readRenderFailures()` in `src/client/render-failure-log.ts` is the internal read path (the package's public `/client` entry does not re-export it, so a developer reads the key through the browser's developer tools). Each record is `{ at, name, message, stack, slot }`: the ISO-8601 failure time, the error name, the error message, the stack, and the slot whose render failed (`root` for the application root). The ring keeps at most three records, each bounded to about 4 KB (`message` at most 512 characters, `stack` at most 3072); older records are replaced. Token-like runs are redacted before storage (`sk-…` keys, bearer/basic credentials, `token=`/`password=`/`authorization` values, and long secret-like runs). The renderer never records prompts, conversation text, credentials, or component props.

Recording is best-effort: when `localStorage` is unavailable or throws (privacy mode, quota, sandboxed frame), the fallback still shows the in-memory record of the failure that just happened, but that record is not persisted for a later reload and the diagnostic view reports no stored history. Diagnostics stay in the browser profile, are not uploaded, and nothing reads them at startup.

The fallback's copy comes from the `renderer` locale namespace (all eight built-in locales). When the locale service is unavailable at failure time (a boot-order failure), the fallback uses the English dictionary ladder, and a missing key renders as the key itself.

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the surrounding machinery and the composition model.

- [ui-slots](../ui-slots/README.md) — the slot registry pure core this renderer binds to React.
- [web](../web/README.md) — the shell that loads the roster and calls `mount`.
- [ui-session](../ui-session/README.md) — the adapter that supplies the standard Session sources and hooks this renderer binds.
- [Web client architecture](../../../docs/subsystems/web-client.md) — the loading chain, object layer, and layering red lines.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive composition model.
- [Component Factories](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md) — reusable definitions, local Component selection, and occurrence lifetimes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side render assembly that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the application frame appears and how far per-region readiness goes; they are current package constraints.

- **The first application frame waits for the whole client roster** — the boot kernel hands over the mount point only after the loader roster settles and the boot audit accepts it; per-region readiness remains deferred.
- **Slot rendering has no Suspense integration or per-entry lazy loading** — the complete plugin roster settles before the renderer mounts the root.
- **The fallback covers React render failures only** — a failure before the client roster mounts (for example a bundle that never loads) belongs to the boot page, and a failure outside this React tree still needs a manual reload or external diagnosis.
- **Diagnostics are best-effort and local** — storage denial loses persistence, the ring retains only three bounded records, and redaction reduces rather than eliminates sensitive text that a thrown error may carry.
- **The original blackout cause is unidentified** — this screen changes the failure surface and preserves evidence; it is not a fix for the unreproduced fault.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
