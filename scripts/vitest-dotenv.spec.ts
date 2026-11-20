import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const vitestCli = join(root, 'node_modules/vitest/vitest.mjs')
const fixtureFiles = [
  'vitest.shared.ts',
  'scripts/test-proxy-environment.ts',
  'packages/util/http-proxy/src/policy.ts',
]
const lanes = [
  { config: 'e2e', probe: 'apps/cli/tests/dotenv.e2e.ts', mode: undefined },
  { config: 'web', probe: 'apps/web/tests/dotenv.e2e.ts', mode: undefined },
  { config: 'snapshot', probe: 'snapshots/dotenv.snapshot.ts', mode: 'record' },
]
const key = 'DEEPSEEK_API_KEY'
const marker = 'synthetic-dotenv-probe'
const childTimeout = 60_000
const testTimeout = { timeout: 65_000 }

function expectProbe(
  lane: typeof lanes[number],
  directoryName: string,
  { dotenv, expectedToRun }: { dotenv: boolean; expectedToRun: boolean },
): void {
  // Outside the checkout, so even a checkout path containing spaces has a plain-path control.
  const fixture = mkdtempSync(join(tmpdir(), `dsh-vitest-${directoryName}-`))
  try {
    const configPath = `vitest.${lane.config}.config.ts`
    for (const path of [configPath, ...fixtureFiles]) {
      const destination = join(fixture, path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(root, path), destination)
    }
    const dependencies = join(fixture, 'node_modules')
    mkdirSync(dependencies)
    for (const dependency of ['vitest', 'vite-tsconfig-paths', 'typescript']) {
      symlinkSync(realpathSync(join(root, 'node_modules', dependency)), join(dependencies, dependency), 'junction')
    }
    writeFileSync(join(fixture, 'package.json'), '{ "type": "module" }\n')
    writeFileSync(join(fixture, 'tsconfig.base.json'), '{}\n')
    if (dotenv) writeFileSync(join(fixture, '.env'), `${key}=${marker}\n`)

    const probe = join(fixture, lane.probe)
    mkdirSync(dirname(probe), { recursive: true })
    writeFileSync(probe, [
      "import { expect, it } from 'vitest'",
      `const key = process.env.${key}`,
      `it.skipIf(key === undefined)('receives the synthetic credential', () => expect(key).toBe(${JSON.stringify(marker)}))`,
      '',
    ].join('\n'))

    const reportPath = join(fixture, 'vitest-report.json')
    const child = spawnSync(process.execPath, [
      vitestCli, 'run', '--config', configPath, '--no-cache', '--reporter=json', '--outputFile', reportPath,
    ], {
      cwd: fixture,
      env: {
        SystemRoot: process.env.SystemRoot,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        TMPDIR: process.env.TMPDIR,
        DSH_SNAPSHOT: lane.mode,
      },
      encoding: 'utf8',
      timeout: childTimeout,
      killSignal: 'SIGKILL',
    })
    if (child.error !== undefined) throw child.error
    const diagnostic = `${configPath} in ${realpathSync(fixture)}\n${child.stdout}\n${child.stderr}`
    expect(child.signal, diagnostic).toBeNull()
    expect(child.status, diagnostic).toBe(0)
    expect(JSON.parse(readFileSync(reportPath, 'utf8')), diagnostic).toMatchObject({
      numTotalTests: 1,
      numPassedTests: Number(expectedToRun),
      numPendingTests: Number(!expectedToRun),
      numFailedTests: 0,
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

describe('Vitest .env loading', () => {
  for (const lane of lanes) {
    describe(lane.mode === undefined ? lane.config : `${lane.config} ${lane.mode}`, () => {
      it.each(['plain', 'with spaces', '日本語'])('runs the key-gated probe in a %s path', testTimeout, (name) => {
        expectProbe(lane, name, { dotenv: true, expectedToRun: true })
      })
      it('skips the key-gated probe when .env is absent', testTimeout, () => {
        expectProbe(lane, 'with spaces', { dotenv: false, expectedToRun: false })
      })
    })
  }

  it.each([undefined, 'replay', 'refresh'])('ignores .env when snapshot mode is %s', testTimeout, (mode) => {
    expectProbe({ config: 'snapshot', probe: 'snapshots/dotenv.snapshot.ts', mode }, 'plain', {
      dotenv: true,
      expectedToRun: false,
    })
  })
})
