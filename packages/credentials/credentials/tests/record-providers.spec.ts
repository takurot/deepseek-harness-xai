/** Shared durable record behavior across the file and OS-store providers. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { credentialKey } from '../src/index.ts'
import type { CredentialRecord } from '../src/index.ts'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { KeychainCredentialProvider } from '@deepseek-ai/dsh-credentials-keychain'
import type { KeychainBackend } from '@deepseek-ai/dsh-credentials-keychain'

const KEY = credentialKey('owner', 'route')

async function fixture(kind: 'local' | 'keychain') {
  const root = await mkdtemp(join(tmpdir(), 'credential-admission-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const file = join(root, 'credentials.yaml')
  const items = new Map<string, string>()
  const events: string[] = []
  const backend: KeychainBackend = {
    assertCanStore() {},
    get: async account => items.get(account),
    set: async (account, value) => { items.set(account, value) },
    delete: async (account) => { items.delete(account) },
  }
  class Provider extends KeychainCredentialProvider {
    protected override createBackend(): KeychainBackend { return backend }
    protected override lockDirectory(): string { return join(root, 'locks') }
  }
  const boot = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.on('credentials/record-updated', (key) => { events.push(key) })
    if (kind === 'local') await ctx.plugin(LocalCredentialProvider, { path: file, dshHome: root, watch: false })
    else await ctx.plugin(Provider, {})
    return ctx.credentials
  }
  return {
    boot, events,
    snapshot: async () => kind === 'local' ? await readFile(file, 'utf8') : JSON.stringify([...items]),
    inject: async (record: unknown) => {
      if (kind === 'local') await writeFile(file, JSON.stringify({ version: 1, records: { [KEY]: record } }), { mode: 0o600 })
      else { items.set(`record:${KEY}`, JSON.stringify(record)); items.set('index', JSON.stringify([KEY])) }
    },
  }
}

for (const kind of ['local', 'keychain'] as const) {
  describe(`${kind} durable record admission`, () => {
    it('round trips ordinary records and normalizes optional API key fields', async () => {
      const f = await fixture(kind)
      const provider = await f.boot()
      const repeated = { token: 'same' }
      const prototypeField: unknown = JSON.parse('{"__proto__":{"token":"value"}}')
      const forms: unknown[] = [
        { kind: 'api-key' }, { kind: 'api-key', key: undefined, env: undefined },
        { kind: 'api-key', key: 'secret', env: Object.fromEntries([['__proto__', 'profile']]) },
        ...[null, false, true, 'text', 0, 42, [1, { nested: true }], { a: repeated, b: repeated }, prototypeField]
          .map(payload => ({ kind: 'grant' as const, payload })),
      ]
      for (const record of forms) {
        const expected: unknown = JSON.parse(JSON.stringify(record))
        expect(await provider.modifyRecord(KEY, async () => record as CredentialRecord)).toEqual(expected)
        expect(await provider.readRecord(KEY)).toEqual(expected)
        expect(await (await f.boot()).readRecord(KEY)).toEqual(expected)
      }
    })

    it('refuses lossy grants before changing the old credential or invoking accessors', async () => {
      const f = await fixture(kind)
      const provider = await f.boot()
      const before: CredentialRecord = { kind: 'grant', payload: { token: 'old' } }
      await provider.modifyRecord(KEY, async () => before)
      const saved = await f.snapshot()
      const cyclic: Record<string, unknown> = {}
      cyclic['self'] = cyclic
      let invoked = false
      const getter = Object.defineProperty({}, 'token', { enumerable: true, get() { invoked = true; throw new Error('SENTINEL_SECRET') } })
      const invalid = [
        undefined, NaN, Infinity, -Infinity, -0, { nested: undefined }, cyclic, BigInt(1), () => 1, Symbol('SENTINEL_SECRET'),
        new Date(), Object.assign([1], { extra: 'SENTINEL_SECRET' }), Array(2),
        Object.defineProperty({}, 'secret', { value: 'SENTINEL_SECRET' }),
        { [Symbol('secret')]: 'SENTINEL_SECRET' }, getter, { toJSON() { invoked = true; return 'SENTINEL_SECRET' } },
      ]
      f.events.length = 0
      for (const payload of invalid) {
        const failure = await provider.modifyRecord(KEY, async () => ({ kind: 'grant', payload })).then(() => undefined, (error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).not.toContain('SENTINEL_SECRET')
        expect(failure).not.toHaveProperty('cause')
        expect(await f.snapshot()).toBe(saved)
        expect(await provider.readRecord(KEY)).toEqual(before)
      }
      expect(invoked).toBe(false)
      expect(f.events).toEqual([])
    })

    it('keeps the previous credential when a mutator changes current and declines or returns invalid data', async () => {
      const f = await fixture(kind)
      const provider = await f.boot()
      const original: CredentialRecord = { kind: 'grant', payload: { token: 'old' } }
      await provider.modifyRecord(KEY, async () => original)
      const mutate = (current: CredentialRecord | undefined) => {
        if (current?.kind === 'grant' && typeof current.payload === 'object' && current.payload !== null) {
          Object.assign(current.payload, { token: 'changed' })
        }
      }
      expect(await provider.modifyRecord(KEY, async (current) => { mutate(current); return undefined })).toEqual(original)
      await expect(provider.modifyRecord(KEY, async (current) => { mutate(current); return { kind: 'grant', payload: NaN } })).rejects.toThrow()
      expect(await provider.readRecord(KEY)).toEqual(original)
      expect(await (await f.boot()).readRecord(KEY)).toEqual(original)
    })

    it('refuses malformed persisted records with secret-free diagnostics', async () => {
      for (const record of [
        { kind: 'api-key', key: 42 }, { kind: 'api-key', env: [] }, { kind: 'api-key', env: { 'SENTINEL_SECRET invalid': 'x' } },
        { kind: 'api-key', SENTINEL_SECRET: 'unknown field' }, { kind: 'grant' }, { kind: 'SENTINEL_SECRET' },
      ]) {
        const f = await fixture(kind)
        await f.inject(record)
        const failed = f.boot().then(async (provider) => { await provider.readRecord(KEY) })
        const error = await failed.then(() => undefined, (failure: unknown) => failure)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain('SENTINEL_SECRET')
        expect(error).not.toHaveProperty('cause')
      }
    })
  })
}
