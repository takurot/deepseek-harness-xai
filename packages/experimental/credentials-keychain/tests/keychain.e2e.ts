import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'

import { KeychainCredentialProvider } from '../src/index.ts'

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
    const fiber = ctx.plugin(KeychainCredentialProvider, { service })
    cleanup.push(async () => { await fiber.dispose() })
    await fiber
    const awkward = 'sk-"quoted" \'single\' $HOME\nline2 日本語'
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
