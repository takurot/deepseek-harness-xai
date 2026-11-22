# Agent Note: Top-level render failures show a recovery screen, not a blank page

Status: implemented

English | [中文](2026-11-22-root-render-failure-fallback.zh.md)

## Problem

On 2026-11-19 the Web client showed an empty black page while the local server kept running in the same process; a browser reload restored the interface. The thrown exception and the triggering operation were never captured, so the fault is unreproduced.

The renderer had two holes on its root path. First, a `root` registration that crashes during render is contained by `SlotErrorBoundary`, which reports the crash through `onEntryError` and abdicates the entry; `RootOutlet` then saw no live root entry, found the registration still on the ledger, and returned an empty `<div data-slot-error="root" />`. The user got no explanation and no recovery action. Second, a renderer plumbing error thrown above the entry boundary had no boundary at all, so React unmounted the whole application. Neither path left evidence a reload could recover.

## Decision

**The dry-root branch owns the user-visible fallback.** `RootOutlet` keeps the latest sanitized record from the root entry's `onEntryError` in a ref before reporting the abdication, and the dry-root branch renders `RootFailure` with that record plus the stored ring. The fallback depends on no slot, store, app frame, or Session data: it is a viewport-fixed panel styled with semantic theme tokens, so a broken layout tree cannot hide it. It shows a localized heading and explanation, a Reload control defaulting to `location.reload`, and a `<details>` diagnostic view with a Copy control. Clipboard denial is caught and the details text stays selectable, so the diagnostics can still be copied by hand.

**A separate `RootFailureBoundary` catches only renderer plumbing errors.** It wraps `RootOutlet` (with the scope provider) for errors thrown outside an entry boundary. `SlotAssemblyError` rethrows through `getDerivedStateFromError`, so a miswired boot still fails loud; contained child-slot crashes keep their existing per-entry isolation and never reach the fallback. The fallback's copy states that this is a browser render failure, not a server disconnect: the local server keeps running, and Reload neither restarts it nor deletes Session data.

**Diagnostics are bounded, redacted, and local.** The renderer records each top-level failure under the browser `localStorage` key `dsh.render-failure.v1` and exports `readRenderFailures()` from the diagnostics module. A record is `{ at, name, message, stack, slot }`: ISO-8601 time, error name, error message, stack, and the slot whose render failed (`root` for the application root). The ring keeps at most three records, each fitted to about 4 KB (`message` at most 512 characters, `stack` at most 3072). Token-like runs are redacted before storage: `sk-…` keys, bearer/basic credentials, `token=`/`password=`/`authorization` values, and long secret-like runs. The recorder receives only the thrown value and the slot label; it never reads prompts, conversation text, credentials, or component props. Storage is best-effort: when `localStorage` is absent or throws, the in-memory record still drives the fallback and nothing is persisted. Nothing reads the records at startup.

**The fallback copy joins the typed locale system.** A new `renderer` namespace carries all eight built-in dictionaries. `apply` registers them on a child fiber created with `ctx.inject(['locale'])` rather than a hard `inject: ['locale']`: the locale plugin injects `slots`, which this package provides during its own `apply`, so requiring the locale service directly would leave both fibers pending forever. At failure time the installed locale face is consulted first; without one, a lookup miss, or a binding/lookup throw, the English dictionary ladder answers and an unknown key renders as the key.

## Alternatives considered

**Wrap the whole application in a new outer boundary and leave `RootOutlet` unchanged.** Rejected: the entry boundary already contains the root crash and abdicates it, so an outer boundary never runs; the blank `<div data-slot-error="root" />` remained the shipped behavior in exactly the reported path.

**Retry by remounting the root in place instead of reloading.** Rejected: the crash may leave broken in-memory state behind the boundary, and a retry loop can hide a persistent fault; a reload is the explicit, user-controlled recovery that also proves the server is still serving.

**Upload diagnostics to the server or a telemetry sink.** Rejected: a render failure is diagnosed from the browser profile, the copy already distinguishes a browser fault from a server fault, and an upload adds a privacy surface the Issue explicitly restricts.

**Persist the whole error object, serialized props, or the Session context.** Rejected: those carry prompts, conversation text, and component props. The record keeps only the error's own name, message, and stack, bounded and redacted.

**Keep an unbounded log or keep every field at full length.** Rejected: `localStorage` is small and shared with other features; an unbounded ring can evict unrelated data, and a long stack has no diagnostic value beyond the first frames.

**Turn `inject` on the package into `['locale']`.** Rejected: a hard dependency deadlocks activation because the locale plugin waits for `slots`, which this package provides. A child fiber created with `ctx.inject` waits for the service without making the renderer depend on it.

**Recover automatically when storage contains a failure record.** Rejected: a record cannot tell a transient crash from a persistent one, and an automatic reload loop is worse than one explicit Reload.

## Consequences

- A top-level render crash now leaves a localized explanation, a Reload control, and diagnostic details instead of an empty page; a healthy root and contained child-slot crashes keep their existing behavior.
- At most three bounded records survive a reload; the newest is shown in the fallback even when storage is denied. Redaction and truncation reduce rather than eliminate sensitive text a thrown error may carry.
- The fallback covers render failures inside the mounted React tree. A failure before the roster mounts (for example a bundle that never loads) belongs to the boot page, and a failure outside this tree still needs a manual reload or external diagnosis.
- The original blackout's cause remains unproven. This change alters the failure surface and preserves evidence; it does not claim to fix the unreproduced fault.
- No Session data, server process, or wire format changes, and no recorded-session snapshot exists because the harness has no failure injection.

## Related

[Locale-owned client UI copy](../architecture/2026-08-23-locale-owned-client-ui-copy.md) owns the namespace/`t` discipline the fallback follows. The [slot system standard](../architecture/2026-07-22-slot-type-chain-implementation.md) owns entry boundaries and the root slot.

## Testing

- `packages/client/ui-renderer/tests/root-failure.client.spec.tsx` pins the throwing-root fallback, persisted readability, the installed-locale copy and English ladder, the healthy root and contained-child cases, storage denial, the reload and copy controls (including clipboard denial), the plumbing boundary, the rethrown assembly error, ring retention, redaction, the 4 KB bound, corrupt storage, and dictionary registration.
- `packages/client/ui-renderer/tests/factory-slots.client.spec.tsx` updates the obsolete `data-slot-error="root"` expectation to the fallback.
- The existing `scoped-slots.client.spec.tsx` suite keeps the partial-slot isolation and boot-order assembly-error coverage.
