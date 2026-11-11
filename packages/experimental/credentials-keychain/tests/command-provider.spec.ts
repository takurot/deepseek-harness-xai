/** Provider-level command ownership, preflight admission and interrupted-commit recovery. */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as realWait } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider, secretServiceBackend } from '../src/index.ts'
import type { Config, KeychainBackend, KeychainCommandRunner } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/budget-store.mjs', import.meta.url))
const key = credentialKey('oauth', 'test')
const ref = credentialRef('BUDGET_TEST')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try { while (cleanups.length > 0) await cleanups.pop()!() } finally { vi.useRealTimers() }
})

async function setup(config: Config = {}): Promise<{ root: string; ctx: Context; start: () => PromiseLike<unknown> }> {
  const root = await mkdtemp(join(tmpdir(), 'keychain-provider-budgets-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  class BudgetProvider extends KeychainCredentialProvider {
    protected override lockDirectory(): string { return join(root, 'locks') }
    protected override createBackend(service: string, run: KeychainCommandRunner, limit: number): KeychainBackend {
      return secretServiceBackend(service, (_command, args, stdin) => run(process.execPath, [fixture, root, ...args], stdin), limit)
    }
  }
  const ctx = new Context()
  cleanups.push(async () => {
    const stopping = ctx.fiber.dispose()
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(100_000)
      for (let step = 0; step < 20; step++) { await realWait(5); await vi.advanceTimersByTimeAsync(100) }
    }
    await stopping
  })
  return { root, ctx, start: () => ctx.plugin(BudgetProvider, { commandTimeoutMs: 1000, commandKillGraceMs: 100, ...config }) }
}

async function ready(root: string, count = 1): Promise<number[]> {
  for (;;) {
    const files = (await readdir(root)).filter(name => name.startsWith('ready-'))
    if (files.length >= count) return files.map(name => Number(name.slice(6)))
    await realWait(5)
  }
}

async function expire(pending: PromiseLike<unknown>): Promise<void> {
  let done = false
  void Promise.resolve(pending).then(() => { done = true }, () => { done = true })
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(100)
  for (let count = 0; count < 200 && !done; count++) { await realWait(5); await vi.advanceTimersByTimeAsync(20) }
  expect(done).toBe(true)
}

async function behavior(root: string, value: object): Promise<void> { await writeFile(join(root, 'behavior'), JSON.stringify(value)) }

async function items(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const file of await readdir(join(root, 'items'))) result[file] = await readFile(join(root, 'items', file), 'utf8')
  return result
}

describe.skipIf(process.platform === 'win32')('bounded provider commands', () => {
  it('settles startup when its OS readiness command does not exit', async () => {
    const { root, ctx, start } = await setup()
    await behavior(root, { operation: 'lookup', hang: true, ignoreTerm: true })
    vi.useFakeTimers()
    const loading = Promise.resolve(start())
    void loading.catch(() => {})
    const pids = await ready(root)
    await expire(loading)
    await expect(loading).rejects.toMatchObject({ reason: 'timeout' })
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    await ctx.fiber.dispose()
  })

  it('aborts and drains every unqueued reference read during disposal', async () => {
    const { root, ctx, start } = await setup()
    await start()
    await behavior(root, { operation: 'lookup', hang: true })
    const provider = ctx.credentials
    const reads = [provider.resolve(ref), provider.describe(ref)]
    const outcomes = Promise.allSettled(reads)
    const pids = await ready(root, 2)
    await ctx.fiber.dispose()
    expect((await outcomes).map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    await expect(provider.resolve(ref)).rejects.toMatchObject({ reason: 'cancelled', outcome: 'not-started' })
  })

  it('repairs a timed-out commit before later queued record reads without repeating mutate', async () => {
    const { root, ctx, start } = await setup()
    await start()
    await behavior(root, { operation: 'store', account: 'index', hang: true, ignoreTerm: true, writeFirst: true })
    vi.useFakeTimers()
    let mutations = 0
    const pending = ctx.credentials.modifyRecord(key, async () => { mutations++; return { kind: 'grant', payload: { token: 'saved' } } })
    void pending.catch(() => {})
    await ready(root)
    await expire(pending)
    await expect(pending).rejects.toMatchObject({ code: 'KEYCHAIN_COMMIT_UNKNOWN', commandReason: 'timeout' })
    const repairing = ctx.credentials.listRecords()
    void repairing.catch(() => {})
    await ready(root, 2)
    await expire(repairing)
    await expect(repairing).rejects.toMatchObject({ code: 'KEYCHAIN_COMMIT_UNKNOWN', commandReason: 'timeout' })
    await behavior(root, {})
    expect(await ctx.credentials.listRecords()).toEqual([{ key, kind: 'grant' }])
    expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: { token: 'saved' } })
    expect(mutations).toBe(1)
  })

  it('preserves a reference and every transaction item when read-back preflight refuses a value', async () => {
    const { root, ctx, start } = await setup({ commandOutputLimitBytes: 200 })
    await start()
    await ctx.credentials.set(ref, 'old')
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: 'old' }))
    const before = await items(root)
    const stores = async () => (await readFile(join(root, 'events'), 'utf8')).split('\n').filter(line => line.includes('"operation":"store"')).length
    const written = await stores()
    await expect(ctx.credentials.set(ref, 'x'.repeat(201))).rejects.toMatchObject({ code: 'KEYCHAIN_STORAGE_LIMIT', outcome: 'unchanged' })
    await expect(ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: '\\"'.repeat(100) } })))
      .rejects.toMatchObject({ code: 'KEYCHAIN_STORAGE_LIMIT', outcome: 'unchanged' })
    expect(await items(root)).toEqual(before)
    expect(await stores()).toBe(written)
    expect(await ctx.credentials.resolve(ref)).toEqual({ value: 'old', source: 'keychain' })
    expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'api-key', key: 'old' })
  })
})
