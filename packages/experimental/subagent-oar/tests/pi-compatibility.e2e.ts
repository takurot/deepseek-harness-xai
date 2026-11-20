/** Exercise the real Pi SDK through the OAR adapter without a provider account. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { piLoopback } from './fixtures/pi-loopback.ts'

it('selects project models and skills and completes a DSH Pi delegation', async (test) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-oar-pi-')))
  test.onTestFinished(() => rm(root, { force: true, recursive: true }))
  const home = join(root, 'home')
  const agent = join(root, 'agent')
  const project = join(root, 'project')
  const pi = join(project, '.pi')
  const resources = join(root, 'resources')
  await Promise.all([home, agent, pi, join(resources, 'skills', 'keep'), join(resources, 'skills', 'drop')]
    .map(directory => mkdir(directory, { recursive: true })))
  const { baseUrl, bodies } = await piLoopback(test, [[
    '{"choices":[{"index":0,"delta":{"role":"assistant","content":"Pi fixture answer"},"finish_reason":null}]}',
    '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  ]])
  await Promise.all([
    writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl, api: 'openai-completions', apiKey: 'fixture-key',
      models: ['selected', 'excluded'].map(id => ({ id, name: id, input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024 })),
    } } })),
    writeFile(join(pi, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'selected', enabledModels: ['FIXTURE/SELECT*'],
      packages: [{ source: resources, skills: ['skills/keep/**'] }],
    })),
    writeFile(join(resources, 'package.json'), JSON.stringify({ name: 'fixture-resources', pi: { skills: ['skills'] } })),
    ...['keep', 'drop'].map(name => writeFile(join(resources, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture ${name}\n---\nFixture content.\n`)),
  ])
  const script = `
    import assert from 'node:assert/strict'
    import { piRuntime } from '@botiverse/oar'
    import { Context } from '@deepseek-ai/cordis'
    import { createAgentSessionServices, resolveModelScopeWithDiagnostics, SettingsManager } from '@earendil-works/pi-coding-agent'
    import * as provider from '../src/index.ts'
    const cwd = process.argv[1]
    const installation = await piRuntime.installation({ cwd })
    assert.equal(installation.kind, 'available')
    const result = await piRuntime.listModels(installation, { cwd })
    assert.equal(result.kind, 'ok', JSON.stringify(result))
    assert.deepEqual(result.models.map(model => model.id).sort(), ['fixture/excluded', 'fixture/selected'])
    assert.deepEqual(result.models.filter(model => model.default).map(model => model.id), ['fixture/selected'])
    const agentDir = process.env.OAR_PI_AGENT_DIR
    const settings = SettingsManager.create(cwd, agentDir)
    const { modelRuntime } = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings })
    const scope = await resolveModelScopeWithDiagnostics(settings.getEnabledModels(), modelRuntime)
    assert.deepEqual(scope.diagnostics, [])
    assert.deepEqual(scope.scopedModels.map(({ model }) => model.id), ['selected'])
    const skills = await piRuntime.skills(installation, { cwd })
    assert.equal(skills.kind, 'ok', JSON.stringify(skills))
    assert.deepEqual(skills.scope, { kind: 'workspace', cwd })
    assert.deepEqual(skills.items.map(item => item.name), ['keep'])
    const ctx = new Context()
    let registered
    ctx.provide('subagents', { registerProvider(value) { registered = value; return () => {} } })
    try {
      await ctx.plugin(provider, { runtime: 'pi', providerName: 'pi-fixture' })
      assert.ok(registered)
      const run = await registered.start({ cwd, signal: new AbortController().signal,
        parent: { id: 'pi-fixture-parent', session: { header: { cwd: process.env.HOME } } },
        prompt: [{ type: 'text', text: 'Return the fixture answer.' }] })
      try {
        const result = await run.result
        assert.equal(result.stopReason, 'completed', JSON.stringify(result))
        assert.deepEqual(result.output, [{ type: 'text', text: 'Pi fixture answer' }])
      } finally { await run.dispose() }
    } finally { await ctx.fiber.dispose() }
  `
  const result = await execa(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script, project], {
    cwd: import.meta.dirname, extendEnv: false, env: {
      HOME: home, USERPROFILE: home, OAR_PI_AGENT_DIR: agent,
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    }, cancelSignal: test.signal, reject: false,
  })
  expect(result.isCanceled, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(0)
  expect(bodies).toHaveLength(1)
  const request = JSON.parse(bodies[0]!) as { model: string; messages: { role: string; content: string }[] }
  expect(request.model).toBe('selected')
  expect(request.messages.find(message => message.role === 'system')?.content).toContain(project)
})
