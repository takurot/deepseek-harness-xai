import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const bundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))

it.skipIf(!existsSync(bundle) && process.env.DSH_EXAMPLE_MODE !== 'lib')('returns a structured failure without terminating the host for excessive content encodings and a truncated body', { retry: 0 }, () => {
  expect(existsSync(bundle)).toBe(true)
  const fixture = fileURLToPath(new URL('./fixtures/content-encoding.ts', import.meta.url))
  const run = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 15000 })
  expect(run.error, run.stderr).toBeUndefined()
  expect(run.signal, run.stderr).toBeNull()
  expect(run.status, run.stderr).toBe(0)
  expect(run.stdout.trim()).toBe('{"code":"WEB_PROVIDER_ERROR"}')
})
