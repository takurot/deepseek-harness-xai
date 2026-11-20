/** Exercise the real Pi SDK through the OAR adapter without a provider account. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'

it('lists the project default, filters package skills, and opens and disposes a Pi session', async (test) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-oar-pi-')))
  test.onTestFinished(() => rm(root, { force: true, recursive: true }))
  const home = join(root, 'home')
  const agent = join(root, 'agent')
  const project = join(root, 'project')
  const pi = join(project, '.pi')
  const resources = join(root, 'resources')
  await Promise.all([home, agent, pi, join(resources, 'skills', 'keep'), join(resources, 'skills', 'drop')]
    .map(directory => mkdir(directory, { recursive: true })))
  await Promise.all([
    writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'fixture-key',
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
    } } })),
    writeFile(join(pi, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'fixture', packages: [{ source: resources, skills: ['skills/keep/**'] }],
    })),
    writeFile(join(resources, 'package.json'), JSON.stringify({ name: 'fixture-resources', pi: { skills: ['skills'] } })),
    ...['keep', 'drop'].map(name => writeFile(join(resources, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture ${name}\n---\nFixture content.\n`)),
  ])
  const script = `
    import assert from 'node:assert/strict'
    import { piRuntime } from '@botiverse/oar'
    const cwd = process.argv[1]
    const installation = await piRuntime.installation({ cwd })
    assert.equal(installation.kind, 'available')
    const result = await piRuntime.listModels(installation, { cwd })
    assert.equal(result.kind, 'ok', JSON.stringify(result))
    assert.deepEqual(result.models.map(({ id, default: selected }) => [id, selected]), [['fixture/fixture', true]])
    const skills = await piRuntime.skills(installation, { cwd })
    assert.equal(skills.kind, 'ok', JSON.stringify(skills))
    assert.deepEqual(skills.scope, { kind: 'workspace', cwd })
    assert.deepEqual(skills.items.map(item => item.name), ['keep'])
    const session = await piRuntime.session(installation, { cwd, model: 'fixture/fixture' })
    try { assert.ok(session.id) } finally { await session.dispose() }
  `
  const result = await execa(process.execPath, ['--input-type=module', '-e', script, project], {
    cwd: import.meta.dirname, extendEnv: false, env: {
      HOME: home, USERPROFILE: home, OAR_PI_AGENT_DIR: agent,
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    }, timeout: 20_000, cancelSignal: test.signal, reject: false,
  })
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.isCanceled, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(0)
}, 30_000)
