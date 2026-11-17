import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const bundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const worker = fileURLToPath(new URL('../lib/pdf-worker.js', import.meta.url))

it.skipIf(!existsSync(bundle) && process.env.DSH_EXAMPLE_MODE !== 'lib')('extracts PDF text through the built provider and its bundled Worker', { retry: 0 }, () => {
  expect(existsSync(bundle)).toBe(true)
  // The built provider loads its extraction entry by URL; both artifacts are
  // part of the published file set.
  expect(existsSync(worker)).toBe(true)
  const fixture = fileURLToPath(new URL('./fixtures/pdf-built.ts', import.meta.url))
  const run = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 30_000 })
  expect(run.error, run.stderr).toBeUndefined()
  expect(run.signal, run.stderr).toBeNull()
  expect(run.status, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout.trim())).toEqual({
    kind: 'pdf',
    content: 'Built page one\u000CBuilt page two',
    pageCount: 2,
    pagesExtracted: 2,
  })
})
