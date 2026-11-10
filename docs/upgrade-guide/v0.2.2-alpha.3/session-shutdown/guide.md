---
kind: upgrade-guide
description: "Session shutdown now waits for pending persistence acquisition and reports combined startup and cleanup failures."
---

# Session shutdown waits for persistence

English | [中文](guide.zh.md)

## Change

Normal shutdown retains Session persistence until active Agents commit their closing events and close their write handles. Removing a persistence provider permanently stops its Agents; replacing the provider does not restart them. Caller, factory, provider, and root disposal also wait for pending persistence `create` or `open` operations and close any handle returned after cancellation. Previously, disposal could finish while those operations remained pending. Public startup cancellation can still reject promptly during acquisition; once Agent initialization begins, rejection still waits for rollback.

If startup and cleanup both fail, the startup promise now rejects with an `AggregateError` containing both failures. Final write failures reject explicit `AgentHandle.dispose()` and appear in framework lifecycle diagnostics; root disposal can resolve after logging the failure. Session formats and configuration keys are unchanged.

## Migration

1. If you provide a custom `SessionPersistence`, ensure pending `create` and `open` operations eventually settle and returned handles complete `close()`. A backend operation that never settles now keeps owner/provider shutdown pending; forced termination cannot confirm durability.
2. Update startup error handlers to inspect `AggregateError.errors` when rollback also fails. Await explicit `AgentHandle.dispose()` where you need a durability result, and monitor lifecycle diagnostics for application shutdown.
3. After provider replacement, explicitly create or resume the required Agents. Verify normal shutdown by reopening the saved Session and checking its final `step/end` and `turn/end` with the disposed abort reason. See the [Agent loop lifecycle](../../../../packages/core/agent-loop/README.md#understand-the-implementation).
