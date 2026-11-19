/**
 * Host-only workflow request and live-run handles. The browser-safe durable
 * vocabulary remains in `./types` so Client programs never import Agent or
 * host Cordis context declarations.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  WorkflowMeta, WorkflowResult, WorkflowRunId,
} from './types.ts'

/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
export interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /**
   * Optional elapsed-time budget in milliseconds, measured from the moment the
   * guest starts running the script. Once reached, `agent()` refuses to start
   * another child with a fatal `BUDGET_EXHAUSTED` error; a running child is
   * never cancelled.
   */
  maxElapsedMs?: number
  /**
   * Optional token budget: cumulative provider-reported usage of the run's
   * settled children. Once reached, `agent()` refuses to start another child
   * with a fatal `BUDGET_EXHAUSTED` error; a running child is never cancelled.
   * A run whose children report no readable usage fails with
   * `BUDGET_UNENFORCEABLE` instead of silently under-counting.
   */
  maxTotalTokens?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}

/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await script and child cleanup. */
  dispose(): Promise<void>
}
