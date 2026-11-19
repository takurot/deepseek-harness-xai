# Agent Note: Run budgets on the workflow engine

Status: implemented

English | [中文](2026-11-19-workflow-run-budgets.zh.md)

## Problem

The workflow engine capped a run's concurrency, item count, and total child count, but nothing bounded its cost. A script that loops over `agent()` — the opt-in Ralph loop is exactly that shape — could spend an unbounded amount of wall-clock time and provider tokens, and the deployment had no lever short of cancelling the whole tool call.

Two facts shaped the fix. First, a round of work is a complete child session, so cutting one mid-flight leaves worktree state that no report describes; a budget must therefore stop the *next* child, never a running one. Second, token cost is only observable through the token meter's per-session fold, and a child's usage is only readable while its session still exists.

## Decision

Budgets are run-scoped parameters of the workflow seam, enforced by the guest when `agent()` would publish a child.

- `WorkflowStartRequest` carries optional `maxElapsedMs` and `maxTotalTokens`. They have no engine default: a deployment policy belongs to the consumer that owns the run (Ralph's plugin config), not to every workflow.
- The guest measures elapsed time from a monotonic `performance.now()` taken when it starts running the script, and accumulates each settled child's provider usage.
- The check runs only at `agent()` admission, after any wait for a concurrency slot, so a refused call releases its slot and is not counted as started; a run may overshoot by the children already in flight. Reaching either budget throws a fatal `WorkflowError` with code `BUDGET_EXHAUSTED`; the script decides how to settle. A running child is never cancelled.
- Child usage comes from the token meter: the host captures the child's live `Session` when it publishes the child, then reads `ctx.tokenMeter.sessionUsage(session)` after settlement. A seeded session starts with a copy of its parent's history, so its total cannot be attributed to the child: the child counts as unmeasured, and a run with a token budget rejects a context-inheriting provider before it starts. A child whose session is unavailable, whose token meter is not mounted, or whose log recorded no provider usage is excluded and counted in `WorkflowResult.childrenWithoutUsage`.
- A token budget with an uncountable child refuses the next admission with `BUDGET_UNENFORCEABLE` instead of presenting a partial sum as the whole cost. Ralph catches this code too and settles `budget-limited`, because the completed rounds and their handoff are the reason the hard-failure alternative above was rejected.
- `WorkflowResult` reports the aggregate `usage` and `childrenWithoutUsage`; Ralph echoes both to the parent model, and its fixed script catches `BUDGET_EXHAUSTED` to settle `budget-limited` with the engine's reason text.

## Why the engine, not the script

The alternative was to expose run statistics to scripts (`stats()` returning elapsed time and usage), keep the engine budget-free, and let the deployment-owned script compare them. Ralph would then need no error protocol.

That was rejected for three reasons. A new script hook is a model-facing contract: `tool-workflow`'s description lists every hook, and 95 committed snapshot sidecars capture it, so the change would rewrite the workflow tool's visible contract for a facility only deployment-owned scripts use. Wall-clock access inside model-authored scripts invites nondeterministic branching that the session log cannot reconstruct. And the admission check is the same shape as the existing `maxTotalAgents` backstop, which already lives in the guest; splitting one class of cap across two mechanisms invites drift.

## Alternatives considered

### Script-visible `stats()` hook

**Given up:** the model-facing hook list stays smaller and the engine gains no error vocabulary. Cost: a model-facing description change pinned by 79 tool-schema sidecars and 16 system-prompt sidecars, wall-clock branching in model-authored scripts, and a second place to maintain the usage aggregate.

### Host-side cancellation when the budget is reached

**Given up:** the engine could watch progress events and cancel. Rejected because cancellation is not a budget outcome: it races the script's next `agent()` call, can land mid-round (the exact outcome budgets must avoid), and reports `cancelled` rather than a stopper the worker can explain.

### `SubagentResult.usage` on the subagent seam

**Given up:** child usage would be provider-owned and correct for out-of-process backends too. Rejected for this change because it adds a field and an obligation to every provider, including those that cannot report usage, while the workflow engine can read the same figure through the token meter that already folds it. If a second consumer needs per-child usage, moving the value onto `SubagentResult` becomes the natural extension.

### Hard failure on budget exhaustion

**Given up:** the whole run could error out. Rejected because the completed rounds carry real work and a bounded handoff; converting them into a tool error discards the only summary the parent would see.

## Consequences

- Ralph exposes the budgets as config ceilings plus call parameters that may only tighten them, and returns `budget-limited` with the engine's reason for both an exhausted and an uncountable budget. Its result reports the aggregate child usage and how many children could not be measured.
- A token budget requires a provider whose children record usage through the mounted token meter. The default in-process provider does; an external backend that reports nothing ends the run earlier than the budget would require, with `BUDGET_UNENFORCEABLE` as the stated reason rather than a silently under-counted total.
- `tokenUsage` folds one child session log, so a child that spawns its own descendants contributes only its own turns to the figure. The [workflow engine limitations](../../../../packages/workflow/workflow-ptc/README.md) record this.
- Nothing prices tokens: a spend ceiling still needs a price table per route and is deferred.
