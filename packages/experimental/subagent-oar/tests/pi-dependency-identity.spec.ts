/** Verify the published Pi package includes the qualified CLI matcher as well as the external dependency. */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

function manifest(name: string, from = new URL(import.meta.url)): URL {
  const resolved = findPackageJSON(name, from)
  if (!resolved) throw new Error(`Cannot find ${name} from ${from.href}`)
  return pathToFileURL(realpathSync(resolved))
}

function version(url: URL): string {
  const value = JSON.parse(readFileSync(url, 'utf8')) as { version: string }
  return value.version
}

it('resolves the qualified Pi pair from both the provider and source OAR, with fixed external minimatch', () => {
  const oar = manifest('@botiverse/oar')
  const agent = manifest('@earendil-works/pi-coding-agent')
  const ai = manifest('@earendil-works/pi-ai')
  expect(manifest('@earendil-works/pi-coding-agent', oar)).toEqual(agent)
  expect(manifest('@earendil-works/pi-ai', oar)).toEqual(ai)
  expect(manifest('@earendil-works/pi-ai', agent)).toEqual(ai)
  expect(version(agent)).toBe('1.5.2')
  expect(version(ai)).toBe('1.5.2')
  expect(version(manifest('minimatch', agent))).toBe('11.0.3')
})

it('ships the qualified embedded matcher in the Pi CLI and RPC bundle', () => {
  const agent = manifest('@earendil-works/pi-coding-agent')
  const chunk = 'chunks/chunk-VEJDBY3O.js'
  for (const entry of ['cli-runtime.js', 'rpc-entry.js']) {
    expect(readFileSync(new URL(`dist/bundle/${entry}`, agent), 'utf8')).toContain(`./${chunk}`)
  }
  const contents = readFileSync(new URL(`dist/bundle/${chunk}`, agent))
  // Hash the distributed chunk reviewed against minimatch 11.0.3, not the external package.
  expect(createHash('sha256').update(contents).digest('hex'))
    .toBe('effbbd5d6247983dc11c7ae5796eb24bda88f9ebf78c707d3f92ca73cbb8b51e')
})
