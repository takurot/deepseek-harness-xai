import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Job {
  'runs-on'?: unknown
  needs?: string[]
  strategy?: { matrix?: { node?: string[] }; 'fail-fast'?: boolean; 'max-parallel'?: number }
  if?: string
  steps?: Array<{
    run?: string
    if?: string
    'continue-on-error'?: boolean
    uses?: string
    env?: Record<string, string>
    with?: Record<string, unknown>
  }>
}

const workflow = yaml.load(
  readFileSync(resolve(import.meta.dirname, '..', '.github/workflows/fork-ci.yml'), 'utf8'),
) as { on: Record<string, unknown>; jobs: Record<string, Job> }

function expectCommandsInOrder(entry: Job, commands: string[]): void {
  let previous = -1
  for (const command of commands) {
    const index = entry.steps?.findIndex(step => step.run?.includes(command)) ?? -1
    expect(index, command).toBeGreaterThan(previous)
    expect(entry.steps?.[index]?.if, command).toBeUndefined()
    expect(entry.steps?.[index]?.['continue-on-error'], command).toBeUndefined()
    previous = index
  }
}

function job(name: string): Job {
  const found = workflow.jobs[name]
  if (found === undefined) throw new TypeError(`fork-ci.yml must define the ${name} job`)
  return found
}

describe('Fork CI workflow', () => {
  it('runs every job on a GitHub-hosted runner', () => {
    for (const [name, entry] of Object.entries(workflow.jobs)) {
      expect(entry['runs-on'], name).toBe('ubuntu-latest')
    }
  })

  it('triggers on pull_request and master pushes without pull_request_target', () => {
    expect(workflow.on).toEqual({ pull_request: null, push: { branches: ['master'] } })
  })

  it('compares archived notes with the PR base or the commit before a master push', () => {
    const staticSteps = job('static').steps ?? []
    const gates = staticSteps.find(step => step.run === 'pnpm run check:ci:static')
    expect(gates?.env?.DSH_ARCHIVE_BASE_REF)
      .toBe('${{ github.event.pull_request.base.sha || github.event.before }}')
    const checkout = staticSteps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['fetch-depth']).toBe(0)
  })

  it('runs full coverage after installing dependencies and preparing Linux confinement', () => {
    expect(job('coverage')).toMatchObject({
      env: { DSH_GATE_CONCURRENCY: '1', DSH_COVERAGE_MAX_WORKERS: '3' },
    })
    expectCommandsInOrder(job('coverage'), [
      'pnpm install --frozen-lockfile',
      'bash scripts/prepare-ci-bubblewrap.sh',
      'pnpm run check:ci:coverage',
    ])
  })

  it('prepares browser and Office runtime prerequisites before running artifact consumers', () => {
    expect(job('consumers')).toMatchObject({
      env: { DSH_GATE_CONCURRENCY: '1', DSH_WEB_SNAPSHOT_WORKERS: '2' },
    })
    expectCommandsInOrder(job('consumers'), [
      'pnpm install --frozen-lockfile',
      'bash scripts/prepare-ci-bubblewrap.sh',
      'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit',
      'pnpm run prepare:primary-runtime --target linux-x64',
      'pnpm run check:ci:consumers',
      'pnpm run build:check',
      'pnpm run rescope-vendor:check',
    ])
  })

  it('runs the compatibility and Loader checks on both supported version lanes', () => {
    const compatibility = job('node-compat')
    expect(compatibility.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 1, matrix: { node: ['24.9', '26'] },
    })
    expect(compatibility.steps?.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version'])
      .toBe('${{ matrix.node }}')
    expectCommandsInOrder(compatibility, [
      'pnpm install --frozen-lockfile',
      'bash scripts/prepare-ci-bubblewrap.sh',
      'pnpm run check:node-compat',
      'pnpm exec vitest run packages/boot/app-boot/tests/loader-shape.compat.spec.ts',
    ])
  })

  it.each(['coverage', 'consumers', 'node-compat'])('retains resource measurements from %s after a failure', (name) => {
    const entry = job(name)
    const commands = entry.steps?.map(step => step.run ?? '').join('\n')
    expect(commands).toContain('/usr/bin/time -v')
    expect(commands).toContain('df -h')
    expect(commands).toContain('$GITHUB_STEP_SUMMARY')
    expect(commands).toContain('/sys/fs/cgroup/memory.peak')
    expect(entry.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.if)
      .toBe('${{ !cancelled() }}')
  })

  it('retains raw and classified audit evidence even when the required policy fails', () => {
    const steps = job('dependency-audit').steps ?? []
    expect(steps.some(step => step.run === 'pnpm run dependency-audit')).toBe(true)
    const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload).toMatchObject({ if: 'always()', with: { path: 'temp/dependency-audit/', 'if-no-files-found': 'error' } })
    expect(steps.map(step => step.run).join('\n')).not.toContain('|| true')
  })

  it('gates on every job and rejects failed, cancelled, or skipped dependencies', () => {
    const runs = (job: Job): string[] => (job.steps ?? []).flatMap(step => step.run === undefined ? [] : [step.run])
    expect(runs(job('static'))).toContain('pnpm run check:ci:static')
    expect(runs(job('lint'))).toEqual(expect.arrayContaining([
      'pnpm run typecheck',
      'pnpm run check:ci:lint:contracts-ready',
    ]))
    const verdict = job('all-checks-passed')
    expect(verdict.needs?.toSorted()).toEqual(Object.keys(workflow.jobs).filter(name => name !== 'all-checks-passed').toSorted())
    const failure = verdict.steps?.find(step => step.run?.includes('exit 1'))
    expect(failure?.if).toBe("contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')")
    expect(verdict.if).toContain('!cancelled()')
    expect(runs(verdict).join('\n')).toContain('exit 1')
  })
})
