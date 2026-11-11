import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'

import { KeychainCredentialProvider, resolveService } from '../src/index.ts'
import type { Config, KeychainBackend, KeychainCommandRunner } from '../src/index.ts'

class MemoryBackend implements KeychainBackend {
  readonly items = new Map<string, string>()
  readonly lockRoot = mkdtempSync(join(tmpdir(), 'keychain-lock-test-'))

  constructor() {
    cleanups.push(async () => { await rm(this.lockRoot, { recursive: true, force: true }) })
  }
  failNext: Error | undefined
  fault: { operation: 'set' | 'delete'; account: string; after: boolean } | undefined

  get(account: string): Promise<string | undefined> {
    return this.settle(() => this.items.get(account))
  }

  set(account: string, secret: string): Promise<void> {
    return this.settle(() => { this.write('set', account, () => { this.items.set(account, secret) }) })
  }

  delete(account: string): Promise<void> {
    return this.settle(() => { this.write('delete', account, () => { this.items.delete(account) }) })
  }

  private write(operation: 'set' | 'delete', account: string, action: () => void): void {
    const fault = this.fault
    if (fault?.operation !== operation || fault.account !== account) { action(); return }
    this.fault = undefined
    if (fault.after) action()
    throw new Error('injected failure with PRIVATE_CREDENTIAL')
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
  protected override lockDirectory(): string {
    return TestProvider.backend.lockRoot
  }

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

  it('repairs an interrupted create before listing, including after restart', async () => {
    const { ctx, backend } = await boot()
    const set = backend.set.bind(backend)
    let fail = true
    backend.set = async (account, value) => {
      if (account === 'index' && fail) { fail = false; throw new Error('injected index failure') }
      await set(account, value)
    }
    const seen: CredentialKey[] = []
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })
    await expect(ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'api-key', key: 'saved' }))).rejects.toThrow()
    expect(seen).toEqual([])
    const restarted = await boot(backend)
    expect(await restarted.ctx.credentials.listRecords()).toEqual([{ key: KEY, kind: 'api-key' }])
    expect(await restarted.ctx.credentials.readRecord(KEY)).toEqual({ kind: 'api-key', key: 'saved' })
  })

  it('removes a stale index entry when the record is already absent', async () => {
    const { ctx, backend } = await boot()
    backend.items.set('index', JSON.stringify([KEY]))
    await ctx.credentials.deleteRecord(KEY)
    expect(backend.items.has('index')).toBe(false)
  })

  it.each(['create', 'update', 'delete'] as const)('recovers every %s write phase before and after its effect', async (mode) => {
    for (const phase of ['journal', 'record', 'index', 'cleanup'] as const) {
      for (const after of [false, true]) {
        const { ctx, backend } = await boot()
        const old = { kind: 'api-key' as const, key: 'old' }
        const next = { kind: 'grant' as const, payload: { token: 'new' } }
        if (mode !== 'create') await ctx.credentials.modifyRecord(KEY, async () => old)
        const seen: CredentialKey[] = []
        ctx.on('credentials/record-updated', (key) => { seen.push(key) })
        backend.fault = {
          operation: phase === 'cleanup' || mode === 'delete' && phase !== 'journal' ? 'delete' : 'set',
          account: phase === 'journal' || phase === 'cleanup' ? 'record-transaction-v1' : phase === 'record' ? `record:${KEY}` : 'index',
          after,
        }
        let mutations = 0
        const change = mode === 'delete' ? ctx.credentials.deleteRecord(KEY) : ctx.credentials.modifyRecord(KEY, async () => { mutations++; return next })
        await expect(change).rejects.toMatchObject({ code: 'KEYCHAIN_COMMIT_UNKNOWN', outcome: 'unknown' })
        expect(seen).toEqual([])
        const restarted = await boot(backend)
        const expected = phase === 'journal' && !after ? mode === 'create' ? undefined : old : mode === 'delete' ? undefined : next
        expect(await restarted.ctx.credentials.readRecord(KEY)).toEqual(expected)
        expect(await restarted.ctx.credentials.listRecords()).toEqual(expected === undefined ? [] : [{ key: KEY, kind: expected.kind }])
        expect(backend.items.has('record-transaction-v1')).toBe(false)
        expect(mutations).toBe(mode === 'delete' ? 0 : 1)
      }
    }
  })

  it('recovers durable items when loaded from a cordis.yml composition', async () => {
    const { ctx, backend } = await boot()
    backend.fault = { operation: 'set', account: 'index', after: false }
    await expect(ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { token: 'saved' } }))).rejects.toThrow()
    const root = await mkdtemp(join(tmpdir(), 'keychain-recovery-loader-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const loaded = new Context()
    cleanups.push(async () => { await loaded.fiber.dispose() })
    TestProvider.backend = backend
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([{ name: 'cordis:keychain' }]))
    await loaded.plugin(Loader)
    loaded.loader.builtins.include = Include
    loaded.loader.builtins.keychain = TestProvider
    await loaded.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await loaded.loader.await()
    for (const entry of loaded.loader.entries()) await entry.fiber?.await()
    expect(await loaded.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'saved' } })
    expect(await loaded.credentials.listRecords()).toEqual([{ key: KEY, kind: 'grant' }])
    expect(backend.items.has('record-transaction-v1')).toBe(false)
  })

  it('retains a failed repair and emits only when a later repair finishes', async () => {
    const { ctx, backend } = await boot()
    const seen: CredentialKey[] = []
    ctx.on('credentials/record-updated', (key) => { seen.push(key) })
    backend.items.set('record-transaction-v1', JSON.stringify({ version: 1, key: KEY, record: '{"kind":"api-key","key":"saved"}', keys: [KEY] }))
    backend.fault = { operation: 'set', account: 'index', after: false }
    await expect(ctx.credentials.listRecords()).rejects.toMatchObject({ code: 'KEYCHAIN_COMMIT_UNKNOWN' })
    expect(seen).toEqual([])
    expect(backend.items.has('record-transaction-v1')).toBe(true)
    expect(await ctx.credentials.listRecords()).toEqual([{ key: KEY, kind: 'api-key' }])
    expect(seen).toEqual([KEY])
  })

  it('refuses corrupt or inconsistent journals without changing stored credentials or leaking parser text', async () => {
    const valid = { version: 1, key: KEY, record: JSON.stringify({ kind: 'api-key', key: 'PRIVATE_CREDENTIAL' }), keys: [KEY] }
    for (const invalid of [
      'PRIVATE_CREDENTIAL', 'null', JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, key: 'PRIVATE_CREDENTIAL' }), JSON.stringify({ ...valid, record: 42 }),
      JSON.stringify({ ...valid, keys: [42] }), JSON.stringify({ ...valid, keys: [KEY, KEY] }),
      JSON.stringify({ ...valid, keys: [] }), JSON.stringify({ ...valid, record: null }),
      JSON.stringify({ ...valid, record: 'PRIVATE_CREDENTIAL' }), JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, record: '{"kind":"api-key","key":42}' }),
      JSON.stringify({ ...valid, record: '{"kind":"grant"}' }),
    ]) {
      const { ctx, backend } = await boot()
      backend.items.set(`record:${KEY}`, valid.record)
      backend.items.set('record-transaction-v1', invalid)
      const before = new Map(backend.items)
      await expect(ctx.credentials.listRecords()).rejects.toThrow('invalid record transaction')
      await expect(ctx.credentials.readRecord(KEY)).rejects.not.toThrow('PRIVATE_CREDENTIAL')
      expect(backend.items).toEqual(before)
    }
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

  it('keeps the OS-user/service lock across an asynchronous record mutation', async () => {
    const { ctx, backend } = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const change = ctx.credentials.modifyRecord(KEY, async () => {
      entered.resolve(undefined)
      await release.promise
      return { kind: 'api-key', key: 'rotated' }
    })
    await entered.promise
    const path = join(backend.lockRoot, createHash('sha256').update('dsh').digest('hex') + '.lock')
    const contender = await open(path, 'a+', 0o600)
    try {
      await expect(tryLockExclusive(contender.fd)).rejects.toThrow(/^E(AGAIN|WOULDBLOCK):/)
    } finally {
      await contender.close()
      release.resolve(undefined)
      await change
    }
  })

  it('expires or disposes a contender without calling its mutation or changing storage', async () => {
    for (const dispose of [false, true]) {
      const { ctx: first, backend } = await boot()
      const { ctx: second } = await boot(backend, { lockWaitMs: 40 })
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const held = first.credentials.modifyRecord(KEY, async () => {
        entered.resolve(undefined)
        await release.promise
        return { kind: 'api-key', key: 'first' }
      })
      await entered.promise
      let called = false
      const pending = second.credentials.modifyRecord(KEY, async () => { called = true; return { kind: 'api-key', key: 'second' } })
      try {
        if (dispose) {
          const stopped = second.fiber.dispose()
          await expect(pending).rejects.toThrow('disposed')
          await stopped
        } else await expect(pending).rejects.toMatchObject({ code: 'KEYCHAIN_LOCK_TIMEOUT' })
        expect(called).toBe(false)
        expect(backend.items.size).toBe(0)
      } finally { release.resolve(undefined); await held }
      expect(await first.credentials.readRecord(KEY)).toEqual({ kind: 'api-key', key: 'first' })
    }
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
    const failure = await ctx.credentials.readRecord(KEY).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain(KEY)
    expect(String(failure)).not.toContain('SECRETVALUE')
    expect(failure).not.toHaveProperty('cause')
    backend.items.set(account, '5')
    await expect(ctx.credentials.readRecord(KEY)).rejects.toThrow('plain mapping')
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

  it('validates the wait budget and derives the default root from the OS user', () => {
    for (const lockWaitMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TestProvider(new Context(), { lockWaitMs })).toThrow('positive safe integer')
    }
    class DirectoryProvider extends KeychainCredentialProvider {
      directory(): string { return this.lockDirectory() }
    }
    expect(new DirectoryProvider(new Context(), {}).directory()).toBe(join(userInfo().homedir, '.dsh-keychain-locks'))
  })

  it('passes its held descriptor to the external command runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keychain-command-lock-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    class CommandProvider extends KeychainCredentialProvider {
      protected override lockDirectory(): string { return root }
      protected override createBackend(_service: string, run: KeychainCommandRunner): KeychainBackend {
        return {
          async get() {
            const result = await run(process.execPath, ['-e', 'process.stdout.write(String(require("node:fs").fstatSync(3).isFile()))'])
            expect(result.stdout).toBe('true')
            return undefined
          },
          async set() {}, async delete() {},
        }
      }
    }
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(CommandProvider)
  })

  it('uses the platform backend when none is injected', async () => {
    const provider = new KeychainCredentialProvider(new Context(), { service: 'dsh-unit' })
    expect(provider).toBeInstanceOf(KeychainCredentialProvider)
  })
})
