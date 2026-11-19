import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId  } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolRalph from '../src/index.ts'
import { mountWorkflowRuntime } from '../../../workflow/workflow-ptc/tests/setup.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]
const testToolSignal = new AbortController().signal

async function mountExecution(ctx: Context): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ralph-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })
  await mountWorkflowRuntime(ctx, { cwd })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(cwd, '.sessions') })
  return cwd
}

/** Mount the shipped Ralph execution stack around one keyless model script. */
async function mountRalph(script: MockScript, config: toolRalph.Config) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const cwd = await mountExecution(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(PtcWorkflowEngine, {})
  await ctx.plugin(toolRalph, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('ralph-parent'),
    meta: { cwd },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, parentHandle, parent: parentHandle.agent }
}

describe('dsh-tool-ralph over the real spawn and sandboxed PTC stack', () => {
  it('uses distinct empty-seed children, shared cwd, and only the prior bounded handoff', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'ROUND_ONE_HANDOFF',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const finalReport = {
      status: 'complete',
      summary: 'Both migration slices are complete.',
      evidence: ['Focused migration tests pass.'],
      nextSteps: [],
      blocker: '',
    }
    const ctx = new Context()
    const adapter = new MockAdapter([
      textResponse('PARENT_HISTORY_MARKER'),
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
      toolCallResponse('round-2', STRUCTURED_OUTPUT_TOOL, finalReport),
    ])
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const cwd = await mountExecution(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(PtcWorkflowEngine, {})
    await ctx.plugin(toolRalph, { maxRounds: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('ralph-parent'),
      meta: { cwd },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_PROMPT_MARKER' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const children: Agent[] = []
    const phases: string[] = []
    ctx.on('workflow/phase', (_run, title) => { phases.push(title) })
    ctx.on('subagent/start', (child) => {
      const agent = ctx.agents.get(child.id)
      expect(agent).toBeDefined()
      children.push(agent!)
    })
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('ralph-integration'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text)
      .toContain('Ralph worker reported completion after 2 rounds.')
    expect(phases).toEqual(['Fresh-agent rounds'])
    expect(children).toHaveLength(2)
    expect(new Set(children.map(child => child.id)).size).toBe(2)
    for (const child of children) {
      expect(child.session.header.cwd).toBe(cwd)
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(child.session.header.isSeeded).toBe(false)
      expect(child.session.inheritedEventCount).toBe(0)
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    expect(adapter.requests).toHaveLength(3)
    const firstChildRequest = JSON.stringify(adapter.requests[1]!.messages)
    const secondChildRequest = JSON.stringify(adapter.requests[2]!.messages)
    expect(firstChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(firstChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(firstChildRequest).not.toContain('ROUND_ONE_HANDOFF')
    expect(secondChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(secondChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(secondChildRequest).toContain('ROUND_ONE_HANDOFF')

    await parentHandle.dispose()
  })

  it('stops before the next round when the run reaches its token budget', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'TOKEN_BUDGET_ROUND_ONE',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    // Round one already spends more than the budget, so round two must never start.
    const { ctx, adapter, parentHandle, parent } = await mountRalph([
      textResponse('PARENT_HISTORY_MARKER'),
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
    ], { maxRounds: 4, maxTotalTokens: 10 })
    const children: string[] = []
    ctx.on('subagent/start', (child) => { children.push(child.id) })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_PROMPT_MARKER' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('ralph-token-budget'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 4 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Ralph stopped after 1 round.')
    expect(text).toContain('Reason: this run reached its token budget')
    expect(text).toContain('TOKEN_BUDGET_ROUND_ONE')
    expect(text).toContain('Child token usage:')
    expect(children).toHaveLength(1)
    // The parent request plus the single admitted round.
    expect(adapter.requests).toHaveLength(2)
    expect(result.value).toMatchObject({
      agentsStarted: 1,
      childrenWithoutUsage: 0,
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const usage = (result.value as { usage: { uncachedInputTokens: number; outputTokens: number } }).usage
    expect(usage.uncachedInputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
    await parentHandle.dispose()
  })

  it('fails loudly when a token budget cannot be enforced', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'UNMEASURED_ROUND_ONE',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const unmeasured = (callId: string, args: object) => {
      const chunks = toolCallResponse(callId, STRUCTURED_OUTPUT_TOOL, args)
      return chunks.filter(chunk => chunk.type !== 'usage')
    }
    const { ctx, parentHandle, parent } = await mountRalph([
      textResponse('PARENT_HISTORY_MARKER'),
      unmeasured('round-1', firstReport),
    ], { maxRounds: 4, maxTotalTokens: 10 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_PROMPT_MARKER' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('ralph-unenforceable-budget'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 4 },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text)
      .toContain('cannot enforce its token budget')
    await parentHandle.dispose()
  })

  it('reports the failed round and last good handoff when a child fails', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'ROUND_ONE_HANDOFF',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const { ctx, parent, parentHandle } = await mountRalph([
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
      maxTokensResponse('unfinished child output'),
    ], { maxRounds: 2 })
    const childIds: SessionId[] = []
    ctx.on('workflow/agent-start', (_run, child) => { childIds.push(child.childId) })

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('ralph-child-failure'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Ralph round 2 child failed before producing a structured report.')
    expect(text).toContain('Last successful handoff:')
    expect(text).toContain('ROUND_ONE_HANDOFF')
    expect(childIds).toHaveLength(2)
    for (const childId of childIds) expect(ctx.agents.get(childId)).toBeUndefined()
    await parentHandle.dispose()
  })

  it.each([
    {
      name: 'blocked',
      report: {
        status: 'blocked',
        summary: 'External authorization is required.',
        evidence: ['The local implementation is ready.'],
        nextSteps: ['Continue after authorization.'],
        blocker: 'The required external authorization is unavailable.',
      },
      config: { maxRounds: 2 },
      expectedError: false,
      expectedText: 'Ralph worker reported a blocker after 1 round.',
    },
    {
      name: 'budget-limited',
      report: {
        status: 'continue',
        summary: 'One slice is complete.',
        evidence: ['The first focused test passes.'],
        nextSteps: ['Implement the remaining slice.'],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: false,
      expectedText: 'Ralph stopped after 1 round.\nReason: this run reached its 1-round limit.',
    },
    {
      name: 'unnormalized report',
      report: {
        status: 'continue',
        summary: ' padded summary ',
        evidence: ['A focused test passes.'],
        nextSteps: ['Continue implementation.'],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'summary must be non-empty and normalized',
    },
    {
      name: 'invalid continuing report',
      report: {
        status: 'continue',
        summary: 'Work remains.',
        evidence: ['A focused test passes.'],
        nextSteps: [],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'a continuing Ralph report needs nextSteps and an empty blocker',
    },
    {
      name: 'oversized report',
      report: {
        status: 'continue',
        summary: 'x'.repeat(300),
        evidence: ['A focused test passes.'],
        nextSteps: ['Continue implementation.'],
        blocker: '',
      },
      config: { maxRounds: 1, maxHandoffChars: 100 },
      expectedError: true,
      expectedText: 'Ralph round report exceeds maxHandoffChars',
    },
  ])('enforces the fixed script for $name', async ({ report, config, expectedError, expectedText }) => {
    const { ctx, parent, parentHandle } = await mountRalph([
      toolCallResponse('round-report', STRUCTURED_OUTPUT_TOOL, report),
    ], config)

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('ralph-script-enforcement'),
      name: 'ralph',
      arguments: { objective: 'Complete the scoped work.', maxRounds: config.maxRounds },
      agent: parent,
    })

    expect(result.isError).toBe(expectedError)
    expect((result.content[0] as { text: string }).text).toContain(expectedText)
    await parentHandle.dispose()
  })

  it('cancels the sandboxed process and fresh child to quiescence', { timeout: 90_000 }, async () => {
    const { ctx, parent, parentHandle } = await mountRalph(['hang'], { maxRounds: 2 })
    const children: Agent[] = []
    const outcomes: string[] = []
    let resolveChildStarted!: (child: Agent) => void
    const childStarted = new Promise<Agent>((resolve) => { resolveChildStarted = resolve })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) {
        children.push(agent)
        resolveChildStarted(agent)
      }
    })
    ctx.on('workflow/agent-end', (_run, child) => { outcomes.push(child.outcome) })
    const controller = new AbortController()
    const pending = executeToolFixture(ctx, {
      callId: ToolCallId('ralph-real-cancel'),
      name: 'ralph',
      arguments: { objective: 'Keep working until cancelled.', maxRounds: 2 },
      agent: parent,
      signal: controller.signal,
    })
    try {
      await Promise.race([
        childStarted,
        pending.then((result) => { throw new Error(`Ralph settled before its child started: ${JSON.stringify(result.content)}`) }),
      ])
      controller.abort()
      const result = await pending
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('Ralph workflow was cancelled')
      expect(outcomes).toEqual(['cancelled'])
      expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
    } finally {
      controller.abort()
      await pending
      await parentHandle.dispose()
    }
  })
})
