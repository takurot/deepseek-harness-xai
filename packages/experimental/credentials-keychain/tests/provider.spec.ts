import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'

import { KeychainCredentialProvider, resolveService } from '../src/index.ts'
import type { Config, KeychainBackend } from '../src/index.ts'

class MemoryBackend implements KeychainBackend {
  readonly items = new Map<string, string>()
  failNext: Error | undefined

  get(account: string): Promise<string | undefined> {
    return this.settle(() => this.items.get(account))
  }

  set(account: string, secret: string): Promise<void> {
    return this.settle(() => { this.items.set(account, secret) })
  }

  delete(account: string): Promise<void> {
    return this.settle(() => { this.items.delete(account) })
  }

  private settle<T>(action: () => T): Promise<T> {
    if (this.failNext !== undefined) {
      const error = this.failNext
      this.failNext = undefined
      return Promise.reject(error)
    }
    return Promise.resolve(action())
  }
}

class TestProvider extends KeychainCredentialProvider {
  static backend: MemoryBackend
  protected override createBackend(): KeychainBackend {
    return TestProvider.backend
  }
}

const REF = credentialRef('DSH_KEYCHAIN_TEST')
const KEY = credentialKey('llm-test', 'route-one')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function boot(
  backend = new MemoryBackend(),
  config: Config = {},
  env: Record<string, string> = {},
): Promise<{ ctx: Context; backend: MemoryBackend }> {
  TestProvider.backend = backend
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]))
  const fiber = ctx.plugin(TestProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return { ctx, backend }
}

describe('resolveService', () => {
  it('defaults to dsh and rejects names the platform tools cannot take unquoted', () => {
    expect(resolveService({})).toBe('dsh')
    expect(resolveService({ service: 'dsh.work-1_a' })).toBe('dsh.work-1_a')
    expect(() => resolveService({ service: 'a b' })).toThrow('must match')
    expect(() => new TestProvider(new Context(), { service: 'bad name' })).toThrow('must match')
  })
})

describe('references', () => {
  it('stores in the keychain, outranks the environment, and reports its source', async () => {
    const { ctx, backend } = await boot(undefined, {}, { DSH_KEYCHAIN_TEST: 'from-env' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'from-env', source: 'env' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'env', writable: true })
    const seen: CredentialRef[] = []
    ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
    await ctx.credentials.set(REF, 'from-keychain')
    expect(backend.items.get('ref:DSH_KEYCHAIN_TEST')).toBe('from-keychain')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'from-keychain', source: 'keychain' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'keychain', writable: true })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'from-env', source: 'env' })
    expect(seen).toEqual([REF, REF])
  })

  it('falls back to dotenv layers and reports unconfigured when nothing supplies a value', async () => {
    const { ctx } = await boot()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
    const dotenv = new Context()
    dotenv.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: {} },
      { source: 'project-env', values: { DSH_KEYCHAIN_TEST: 'p' } },
    ]))
    TestProvider.backend = new MemoryBackend()
    const fiber = dotenv.plugin(TestProvider, {})
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    expect(await dotenv.credentials.resolve(REF)).toEqual({ value: 'p', source: 'project-env' })
    expect(await dotenv.credentials.describe(REF)).toEqual({ configured: true, source: 'project-env', writable: true })
  })

  it('treats an empty stored item as absent and refuses to store an empty value', async () => {
    const { ctx, backend } = await boot()
    backend.items.set('ref:DSH_KEYCHAIN_TEST', '')
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
    await expect(ctx.credentials.set(REF, '')).rejects.toThrow('use unset')
  })

  it('does not emit when the store refuses the write', async () => {
    const { ctx, backend } = await boot()
    const seen: CredentialRef[] = []
    ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
    backend.failNext = new Error('locked')
    await expect(ctx.credentials.set(REF, 'v')).rejects.toThrow('locked')
    await ctx.credentials.set(REF, 'v')
    expect(seen).toEqual([REF])
  })
})

describe('records', () => {
  it('round-trips api-key and grant records under a readable account and lists them', async () => {
    const { ctx, backend } = await boot()
    const seen: CredentialKey[] = []
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })
    expect(await ctx.credentials.describeRecord(KEY)).toEqual({ configured: false, writable: true })
    const written = await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'k', env: { AWS_PROFILE: 'p' } }))
    expect(written).toEqual({ kind: 'api-key', key: 'k', env: { AWS_PROFILE: 'p' } })
    const account = `record:${KEY}`
    expect(backend.items.has(account)).toBe(true)
    expect(await ctx.credentials.readRecord(KEY)).toEqual(written)
    expect(await ctx.credentials.describeRecord(KEY)).toEqual({ configured: true, kind: 'api-key', writable: true })
    const grantKey = credentialKey('plugin', 'g')
    await ctx.credentials.modifyRecord(grantKey, () => Promise.resolve({ kind: 'grant', payload: { token: 't' } }))
    expect(await ctx.credentials.listRecords()).toEqual([{ key: KEY, kind: 'api-key' }, { key: grantKey, kind: 'grant' }])
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'k2' }))
    expect(JSON.parse(backend.items.get('index')!)).toEqual([KEY, grantKey])
    expect(seen).toEqual([KEY, grantKey, KEY])
  })

  it('leaves the record untouched when mutate declines, and sees the current value', async () => {
    const { ctx } = await boot()
    expect(await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(undefined))).toBeUndefined()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'k' }))
    let observed: unknown
    const kept = await ctx.credentials.modifyRecord(KEY, (current) => { observed = current; return Promise.resolve(undefined) })
    expect(observed).toEqual({ kind: 'api-key', key: 'k' })
    expect(kept).toEqual({ kind: 'api-key', key: 'k' })
  })

  it('serializes concurrent modifications so no update is lost', async () => {
    const { ctx } = await boot()
    await Promise.all(Array.from({ length: 5 }, () => ctx.credentials.modifyRecord(KEY, async (current) => {
      await new Promise(resolve => setTimeout(resolve, 2))
      const count = current?.kind === 'grant' ? (current.payload as { n: number }).n : 0
      return { kind: 'grant', payload: { n: count + 1 } }
    })))
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { n: 5 } })
  })

  it('rejects records the read path would refuse, before storing them', async () => {
    const { ctx, backend } = await boot()
    await expect(ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: '' }))).rejects.toThrow('empty key')
    await expect(ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', env: { 'bad name': 'x' } }))).rejects.toThrow()
    await expect(ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', env: { OK: '' } }))).rejects.toThrow('non-empty')
    await expect(ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: undefined }))).rejects.toThrow('JSON-serializable')
    expect(backend.items.size).toBe(0)
  })

  it('keeps an empty api-key record, which states ambient authentication', async () => {
    const { ctx } = await boot()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key' }))
    expect(await ctx.credentials.describeRecord(KEY)).toEqual({ configured: true, kind: 'api-key', writable: true })
  })

  it('deletes a record and its index entry, tolerating absent records', async () => {
    const { ctx, backend } = await boot()
    const seen: CredentialKey[] = []
    await ctx.credentials.deleteRecord(KEY)
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'k' }))
    const other = credentialKey('plugin', 'o')
    await ctx.credentials.modifyRecord(other, () => Promise.resolve({ kind: 'api-key', key: 'o' }))
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })
    await ctx.credentials.deleteRecord(KEY)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(JSON.parse(backend.items.get('index')!)).toEqual([other])
    await ctx.credentials.deleteRecord(other)
    expect(backend.items.has('index')).toBe(false)
    expect(seen).toEqual([KEY, other])
  })

  it('skips an index entry whose item is gone and tolerates a stale index on removal', async () => {
    const { ctx, backend } = await boot()
    backend.items.set('index', JSON.stringify([KEY]))
    expect(await ctx.credentials.listRecords()).toEqual([])
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'k' }))
    backend.items.set('index', '[]')
    await ctx.credentials.deleteRecord(KEY)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('names the record, never its value, when a stored item is damaged', async () => {
    const { ctx, backend } = await boot()
    const account = `record:${KEY}`
    backend.items.set(account, 'not json SECRETVALUE')
    const failure = await ctx.credentials.readRecord(KEY).then(() => 'resolved', (error: unknown) => (error as Error).message)
    expect(failure).toContain(KEY)
    expect(failure).not.toContain('SECRETVALUE')
    backend.items.set(account, '5')
    await expect(ctx.credentials.readRecord(KEY)).rejects.toThrow('has no kind')
    backend.items.set(account, '{"kind":"other"}')
    await expect(ctx.credentials.readRecord(KEY)).rejects.toThrow('unknown kind')
  })
})

describe('lifecycle', () => {
  it('fails loud at load when the store is unreachable or the index is damaged', async () => {
    const unreachable = new MemoryBackend()
    unreachable.failNext = new Error('no secret service')
    TestProvider.backend = unreachable
    await expect(new Context().plugin(TestProvider, {})).rejects.toThrow('no secret service')
    for (const [text, message] of [['nope', 'not valid JSON'], ['{}', 'not a list']] as const) {
      const backend = new MemoryBackend()
      backend.items.set('index', text)
      TestProvider.backend = backend
      await expect(new Context().plugin(TestProvider, {})).rejects.toThrow(message)
    }
  })

  it('refuses writes after disposal', async () => {
    TestProvider.backend = new MemoryBackend()
    const ctx = new Context()
    const fiber = ctx.plugin(TestProvider, {})
    await fiber
    const provider = ctx.credentials
    await fiber.dispose()
    await expect(provider.set(REF, 'v')).rejects.toThrow('disposed')
  })

  it('uses the platform backend when none is injected', async () => {
    const provider = new KeychainCredentialProvider(new Context(), { service: 'dsh-unit' })
    expect(provider).toBeInstanceOf(KeychainCredentialProvider)
  })
})
