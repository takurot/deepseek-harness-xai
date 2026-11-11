/** The OS smoke must select real platform tests and isolated stores without production credentials. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

const path = new URL('../.github/workflows/keychain-os-smoke.yml', import.meta.url)

describe('Keychain OS smoke workflow', () => {
  it('runs both OS stores with Linux opt-in, native prerequisites, and disposable storage', () => {
    const text = readFileSync(path, 'utf8')
    const workflow = yaml.load(text) as {
      permissions: Record<string, string>
      jobs: Record<string, { 'timeout-minutes': number; strategy: { matrix: { os: string[] } }; steps: Array<{ name?: string; run?: string }> }>
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const job = workflow.jobs['real-os']
    if (job === undefined) throw new Error('real OS job missing')
    expect(job.strategy.matrix.os).toEqual(['ubuntu-24.04', 'macos-15'])
    expect(job['timeout-minutes']).toBe(20)
    const linux = job.steps.find(step => step.name === 'Exercise isolated Linux Secret Service')?.run ?? ''
    const macos = job.steps.find(step => step.name === 'Exercise isolated macOS Keychain')?.run ?? ''
    const setup = job.steps.find(step => step.name === 'Install workspace and native lock binding')?.run ?? ''
    expect(linux).toContain('DSH_KEYCHAIN_OS_E2E=1 dbus-run-session')
    expect(linux).toContain('tests/secret-service.e2e.ts --retry 0')
    expect(linux).toContain('XDG_DATA_HOME')
    expect(linux).toContain('XDG_RUNTIME_DIR')
    expect(linux).not.toMatch(/(?:^|\s)(?:export\s+)?HOME=/m)
    expect(macos).toContain('security create-keychain')
    expect(macos).toContain('security delete-keychain')
    expect(macos).toContain('tests/keychain.e2e.ts')
    expect(macos).toContain('tests/helper-lock.e2e.ts --retry 0')
    expect(setup).toContain('pnpm install --frozen-lockfile')
    expect(setup).toContain('pnpm run build:native-system')
    expect(text).not.toContain('pull_request_target')
    expect(text).not.toContain('secrets.')
    expect(text).not.toContain('DEEPSEEK_API_KEY')
  })
})
