/** Real Linux Secret Service operations and inherited lock ownership in a private DBus session. */

import { fork, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { KeychainCredentialProvider, secretServiceBackend, spawnRunner } from '../src/index.ts'
import { withServiceLock } from '../src/service-lock.ts'
import type { ChildProcess } from 'node:child_process'

const enabled = process.platform === 'linux' && process.env['DSH_KEYCHAIN_OS_E2E'] === '1'

describe.skipIf(!enabled)('real private Linux Secret Service', () => {
  let root: string
  let daemon: ChildProcess | undefined
  let daemonClosed: Promise<void> | undefined

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-secret-service-'))
    const control = join(root, 'control')
    await mkdir(control, { mode: 0o700 })
    daemon = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', '--control-directory', control], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    daemonClosed = new Promise<void>((resolve) => { daemon!.once('close', () => { resolve() }) })
    daemon.once('error', (_startupError) => {
      // The bounded readiness command reports an unavailable test service.
    })
    daemon.stdout!.resume()
    daemon.stderr!.resume()
    daemon.stdin!.end('synthetic-test-keyring-password')
    const ready = await spawnRunner('gdbus', ['wait', '--session', 'org.freedesktop.secrets'], undefined, undefined, { timeoutMs: 10_000 })
    expect(ready.code).toBe(0)
    expect(daemon.exitCode).toBeNull()
    expect(daemon.signalCode).toBeNull()
  })

  afterAll(async () => {
    if (daemon !== undefined) {
      daemon.kill('SIGCONT')
      daemon.kill('SIGTERM')
      await daemonClosed
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('round-trips references, grants, Unicode, trailing whitespace and embedded NUL', async () => {
    const service = `dsh-linux-${randomUUID()}`
    const backend = secretServiceBackend(service, spawnRunner)
    const ref = credentialRef('DSH_LINUX_TEST')
    const key = credentialKey('test', 'linux')
    const ctx = new Context()
    class Provider extends KeychainCredentialProvider {
      protected override lockDirectory(): string { return join(root, service) }
    }
    try {
      await ctx.plugin(Provider, { service })
      const value = 'quoted "日本語"\nembedded\0NUL  '
      await ctx.credentials.set(ref, value)
      expect(await ctx.credentials.resolve(ref)).toEqual({ value, source: 'keychain' })
      await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: value } }))
      expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: { token: value } })
      expect(await ctx.credentials.listRecords()).toEqual([{ key, kind: 'grant' }])
      for (const bytes of [8191, 8192]) {
        await backend.set('boundary', 'x'.repeat(bytes))
        expect(await backend.get('boundary')).toBe('x'.repeat(bytes))
      }
      await expect(backend.set('boundary', 'x'.repeat(8193))).rejects.toMatchObject({ code: 'KEYCHAIN_STORAGE_LIMIT', outcome: 'unchanged' })
      expect(await backend.get('boundary')).toBe('x'.repeat(8192))
    } finally {
      const removed = await Promise.allSettled(['ref:DSH_LINUX_TEST', 'record:test/linux', 'index', 'record-transaction-v1', 'boundary'].map(account => backend.delete(account)))
      await ctx.fiber.dispose()
      expect(removed.every(result => result.status === 'fulfilled')).toBe(true)
    }
  })

  it('retains fd3 while the actual helper waits for its store reply after its Node owner dies', async () => {
    const service = `dsh-linux-lock-${randomUUID()}`
    const locks = join(root, service)
    const backend = secretServiceBackend(service, spawnRunner)
    let owner: ChildProcess | undefined
    let ownerClosed: Promise<void> | undefined
    let helper: number | undefined
    try {
      expect(daemon!.kill('SIGSTOP')).toBe(true)
      owner = fork(fileURLToPath(new URL('./fixtures/secret-service-lock-owner.ts', import.meta.url)), [locks, service], {
        execArgv: ['--import', import.meta.resolve('tsx/esm')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      ownerClosed = new Promise<void>((resolve) => { owner!.once('close', () => { resolve() }) })
      owner.stdout!.resume()
      owner.stderr!.resume()
      helper = await new Promise<number>((resolve, reject) => {
        owner!.once('message', (message: { pid: number }) => { resolve(message.pid) })
        owner!.once('exit', () => { reject(new Error('Secret Service owner exited before helper spawn')) })
      })
      // The helper consumes stdin before opening its DBus socket for the store call.
      for (;;) {
        const descriptors = await readdir(`/proc/${String(helper)}/fd`)
        const links = await Promise.all(descriptors.map(fd => readlink(`/proc/${String(helper)}/fd/${fd}`).catch(() => '')))
        if (links.some(link => link.startsWith('socket:'))) break
        await wait(10)
      }
      owner.kill('SIGKILL')
      await ownerClosed
      const contender = await open(join(locks, createHash('sha256').update(service).digest('hex') + '.lock'), 'r+')
      try { await expect(tryLockExclusive(contender.fd)).rejects.toThrow(/^E(AGAIN|WOULDBLOCK):/) } finally { await contender.close() }
      daemon!.kill('SIGCONT')
      await withServiceLock(locks, service, 10_000, new AbortController().signal, async () => {})
      expect(await backend.get('retained')).toBe('synthetic-retained-value')
    } finally {
      daemon!.kill('SIGCONT')
      if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await ownerClosed
      if (helper !== undefined) {
        try { process.kill(helper, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await backend.delete('retained')
    }
  })
})
