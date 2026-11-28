import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import * as ToolWorktree from '../src/index.ts'

const exec = promisify(execFile)
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('worktree tool through real Loader composition', () => {
  it.each([undefined, 0, 7])('creates and enters a new checkout (setup exit code: %s)', async (exitCode) => {
    const configured = exitCode !== undefined
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-loader-')))
    const repository = join(root, 'repo')
    await mkdir(repository)
    const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    })
    await git('init', '-b', 'main')
    await git('config', 'core.autocrlf', 'false')
    await writeFile(join(repository, 'file.txt'), 'committed\n')
    await git('add', 'file.txt')
    await git('-c', 'user.name=Worktree fixture', '-c', 'user.email=worktree@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'initial')
    const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],

      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
      ['@deepseek-ai/dsh-experimental-worktree', WorktreeService],
      ['@deepseek-ai/dsh-experimental-tool-worktree', ToolWorktree],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    const sentinel = 'loader-environment-fixture'
    const command = [process.execPath, '-e', `const fs = require('node:fs'); if (fs.readFileSync('file.txt', 'utf8').trim() !== 'committed' || !process.env.DSH_SETUP_FIXTURE) process.exit(2); fs.appendFileSync('setup.marker', process.argv[1] + '\\n'); const check = setInterval(() => { if (fs.existsSync('release')) { clearInterval(check); console.log('prepared'); process.exitCode = ${exitCode ?? 0}; } }, 10);`, 'literal ; argument']
    const config = [...modules.keys()].flatMap(name => [
      `- name: 'cordis:${name}'`,
      ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
      ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
      ...configured && name === '@deepseek-ai/dsh-experimental-worktree' ? [
        '  config:', `    setupCommand: ${JSON.stringify(command)}`, `    setupEnv: { DSH_SETUP_FIXTURE: ${JSON.stringify(sentinel)} }`,
      ] : [],
    ]).join('\n') + '\n'
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, config)
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const notices: unknown[][] = []
    context.logger.exporter({ levels: { default: LoggerLevel.INFO }, export: ({ type, args }) => {
      if (type === 'info' && args[0] === 'Running worktree setup') notices.push(args)
    } })
    const agent = await context.agentLoop.create(SessionId('worktree-loader'), {}, { cwd: repository })
    const path = join(repository, '.agents/worktrees/new-checkout')
    const controller = new AbortController()
    let settled = false
    let ready = false
    const pending = executeToolFixture(context, {
      name: 'create_worktree', callId: ToolCallId('new-checkout'), arguments: { name: 'new-checkout' }, agent, signal: controller.signal,
    }).finally(() => { settled = true })
    try {
      if (configured) {
        await vi.waitFor(() => access(join(path, 'setup.marker')), { timeout: 5_000 })
        ready = true
        expect(settled).toBe(false)
        expect(notices).toEqual([['Running worktree setup']])
      }
    } finally {
      try {
        if (ready && !settled) await writeFile(join(path, 'release'), '')
      } finally {
        if (!ready && configured) controller.abort()
        await pending
      }
    }
    const result = await pending
    expect(notices).toHaveLength(configured ? 1 : 0)
    expect(result.isError).not.toBe(true)
    expect(result.value).toEqual({ path, branch: 'new-checkout', baseCommit, repositoryRoot: repository,
      ...configured ? { provision: { command, status: 'exited', exitCode, signal: null, output: 'prepared\n', truncated: false } } : {},
    })
    if (configured) expect(await readFile(join(path, 'setup.marker'), 'utf8')).toBe('literal ; argument\n')
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    expect(JSON.stringify(result.content)).not.toContain(sentinel)
    expect(context.workingDirectory.get(agent.session)).toBe(path)
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('committed\n')

    await context.workingDirectory.set(agent, repository)
    const refused = await executeToolFixture(context, {
      name: 'create_worktree', callId: ToolCallId('forbidden-command'),
      arguments: { name: 'forbidden-command', setupCommand: [process.execPath] }, agent, signal: controller.signal,
    })
    expect(refused.isError).toBe(true)
    expect(await git('branch', '--list', 'forbidden-command')).toMatchObject({ stdout: '' })
    const skipped = await executeToolFixture(context, {
      name: 'create_worktree', callId: ToolCallId('skipped'), arguments: { name: 'skipped', setup: false }, agent, signal: controller.signal,
    })
    expect(skipped.isError).not.toBe(true)
    expect(skipped.value).not.toHaveProperty('provision')
    expect(notices).toHaveLength(configured ? 1 : 0)

    const failure = await executeToolFixture(context, {
      name: 'create_worktree', callId: ToolCallId('no-agent'), arguments: {}, signal: new AbortController().signal,
    })
    expect(failure.isError).toBe(true)
    expect(failure.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('requires a calling agent')
    expect(context.tools.get('create_worktree')!.presentCall!({ name: 'named' })).toEqual({ card: 'generic', title: 'create_worktree', rawInput: { name: 'named' } })
    const entry = [...context.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-tool-worktree')
    await entry!.fiber!.dispose()
    expect(context.tools.schemas().some(tool => tool.name === 'create_worktree')).toBe(false)
  })
})
