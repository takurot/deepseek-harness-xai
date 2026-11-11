import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'

import { KeychainCredentialProvider, macosBackend, spawnRunner } from '../src/index.ts'

// Real OS secret store: macOS only here; Linux needs a running Secret Service session.
const enabled = process.platform === 'darwin'
const service = `dsh-e2e-${randomUUID()}`
const REF = credentialRef('DSH_KEYCHAIN_E2E')
const KEY = credentialKey('e2e', 'route-one')

describe.skipIf(!enabled)('KeychainCredentialProvider against the macOS Keychain', () => {
  const ctx = new Context()
  const cleanup: Array<() => Promise<void>> = []

  afterAll(async () => {
    const provider = ctx.credentials
    await provider.unset(REF).catch(() => {})
    await provider.deleteRecord(KEY).catch(() => {})
    while (cleanup.length > 0) await cleanup.pop()!()
  })

  it('stores, resolves, and removes a reference and a record, with awkward characters intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keychain-loader-'))
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
    cleanup.push(async () => { await ctx.fiber.dispose() })
    const config = join(root, 'cordis.yml')
    await writeFile(config, JSON.stringify([{ name: 'cordis:keychain', config: { service } }]))
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.keychain = KeychainCredentialProvider
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const awkward = '日本語'.repeat(8192) + 'sk-"quoted" \'single\' $HOME\nline2 日本語'
    await ctx.credentials.set(REF, awkward)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: awkward, source: 'keychain' })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: awkward } }))
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: awkward } })
    expect(await ctx.credentials.listRecords()).toEqual([{ key: KEY, kind: 'grant' }])
    await ctx.credentials.unset(REF)
    await ctx.credentials.deleteRecord(KEY)
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.listRecords()).toEqual([])
  })
})


describe.skipIf(!enabled)('macOS long-item compatibility', () => {
  it('preserves boundary values, a long grant, a large index, and legacy items', async () => {
    const service = `dsh-long-${randomUUID()}`
    const backend = macosBackend(service, spawnRunner)
    const accounts = ['boundary', 'record:oauth/test', 'index', 'legacy']
    try {
      for (const size of [4095, 4096, 4097, 65536]) {
        const value = 'x'.repeat(size) + '\n日本語 "quoted" \'single\'  '
        await backend.set('boundary', value)
        expect(await backend.get('boundary')).toBe(value)
      }
      const legacy = await spawnRunner('security', ['-i'], `add-generic-password -U -s ${service} -a legacy -w b2xk\n`)
      expect(legacy.code).toBe(0)
      expect(await backend.get('legacy')).toBe('old')
      await backend.set('legacy', 'replacement 日本語\n  ')
      expect(await backend.get('legacy')).toBe('replacement 日本語\n  ')
      const grant = JSON.stringify({ kind: 'grant', payload: { refreshToken: '日本語'.repeat(8192) + '\n  ' } })
      await backend.set('record:oauth/test', grant)
      expect(await backend.get('record:oauth/test')).toBe(grant)
      const index = JSON.stringify(Array.from({ length: 1024 }, (_, n) => `oauth/route-${String(n)}`))
      expect(Buffer.byteLength(index)).toBeGreaterThan(4096)
      await backend.set('index', index)
      expect(await backend.get('index')).toBe(index)
    } finally {
      const removed = await Promise.allSettled(accounts.map(account => backend.delete(account)))
      expect(removed.every(result => result.status === 'fulfilled')).toBe(true)
    }
  })
})
