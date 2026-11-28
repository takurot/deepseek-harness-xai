import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CreatedWorktree } from '@deepseek-ai/dsh-experimental-worktree'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import * as ToolWorktree from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

it('keeps creating the checkout when the setup notice cannot be logged', async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const created: CreatedWorktree = { path: '/checkout', branch: 'topic', baseCommit: 'abc', repositoryRoot: '/repo' }
  const phases: string[] = []
  ctx.provide('worktrees')
  ctx.worktrees = {
    create: async (_agent, _args, _signal, onPhase) => {
      onPhase?.('provision')
      phases.push('provision')
      return created
    },
  } as Context['worktrees']
  await ctx.plugin(ToolWorktree)
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => { throw new Error('exporter failed') })
  const agent = { id: SessionId('logger-failure') } as Agent
  const result = await executeToolFixture(ctx, {
    name: 'create_worktree', callId: ToolCallId('logger-failure'), arguments: {}, agent, signal: new AbortController().signal,
  })
  expect(info).toHaveBeenCalledWith('Running worktree setup')
  expect(phases).toEqual(['provision'])
  expect(result.isError).not.toBe(true)
  expect(result.value).toEqual(created)
})
