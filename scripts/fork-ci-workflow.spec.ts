import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Job {
  'runs-on'?: unknown
  needs?: string[]
  if?: string
  steps?: Array<{ run?: string; uses?: string }>
}

const workflow = yaml.load(
  readFileSync(resolve(import.meta.dirname, '..', '.github/workflows/fork-ci.yml'), 'utf8'),
) as { on: Record<string, unknown>; jobs: Record<string, Job> }

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
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push'])
  })

  it('gates on static, lint, and an aggregate verdict that fails on skipped needs', () => {
    const runs = (job: Job): string[] => (job.steps ?? []).flatMap(step => step.run === undefined ? [] : [step.run])
    expect(runs(job('static'))).toContain('pnpm run check:ci:static')
    expect(runs(job('lint'))).toEqual(expect.arrayContaining([
      'pnpm run typecheck',
      'pnpm run check:ci:lint:contracts-ready',
    ]))
    const verdict = job('all-checks-passed')
    expect(verdict.needs?.sort()).toEqual(['lint', 'static'])
    expect(verdict.if).toContain('!cancelled()')
    expect(runs(verdict).join('\n')).toContain('exit 1')
  })
})
