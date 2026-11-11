/** Actual macOS helpers must retain inherited flock across a killed Node owner. */

import { fork, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { withServiceLock } from '../src/service-lock.ts'
import { macosBackend, spawnRunner } from '../src/backend.ts'
import type { ChildProcess } from 'node:child_process'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!() })

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'keychain-helper-lock-'))
  cleanups.push(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

function owner(fixture: string, args: string[]): { child: ChildProcess; exited: Promise<void>; ready: Promise<{ pid: number }> } {
  const child = fork(fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), args, {
    execArgv: ['--import', import.meta.resolve('tsx/esm')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout!.resume()
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  const ready = new Promise<{ pid: number }>((resolve, reject) => {
    child.on('message', (message: { kind: string; pid: number }) => { if (message.kind === 'ready') resolve(message) })
    child.once('exit', () => { reject(new Error(`owner exited before ready: ${stderr}`)) })
  })
  return { child, exited, ready }
}

async function terminate(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGKILL') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  for (;;) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await wait(10)
  }
}

async function marker(path: string): Promise<{ pid: number }> {
  for (;;) {
    try { return JSON.parse(await readFile(path, 'utf8')) as { pid: number } } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await wait(10)
  }
}

async function blocked(locks: string, service: string): Promise<void> {
  const path = join(locks, createHash('sha256').update(service).digest('hex') + '.lock')
  const handle = await open(path, 'r+')
  try { await expect(tryLockExclusive(handle.fd)).rejects.toThrow(/^E(AGAIN|WOULDBLOCK):/) } finally { await handle.close() }
}

describe.skipIf(process.platform !== 'darwin')('actual macOS helper lock inheritance', () => {
  it('keeps security locked after an OS lookup and parent death', async () => {
    const path = await root()
    const service = `dsh-security-lock-${randomUUID()}`
    const fifo = join(path, 'input')
    execFileSync('mkfifo', ['-m', '600', fifo])
    const locks = join(path, 'locks')
    await mkdir(locks, { mode: 0o700 })
    const processOwner = owner('security-lock-owner.ts', [locks, service, fifo])
    const { pid } = await processOwner.ready
    cleanups.push(async () => { await terminate(pid) })
    processOwner.child.kill('SIGKILL')
    await processOwner.exited
    await blocked(locks, service)
    await terminate(pid)
    await withServiceLock(locks, service, 30_000, new AbortController().signal, async () => {})
  })

  it('keeps the production JXA writer locked before its Security API write after parent death', async () => {
    const path = await root()
    const service = `dsh-jxa-lock-${randomUUID()}`
    const locks = join(path, 'locks')
    await mkdir(locks, { mode: 0o700 })
    const backend = macosBackend(service, spawnRunner)
    cleanups.push(async () => {
      const results = await Promise.allSettled(['record-transaction-v1', 'record:oauth/one', 'index'].map(account => backend.delete(account)))
      expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    })
    const processOwner = owner('lock-worker.ts', [path, locks, service, '30000', 'macos-helper'])
    await processOwner.ready
    processOwner.child.send({ action: 'increment', id: 'orphan', key: 'oauth/one' })
    const { pid } = await marker(join(path, 'helper-ready'))
    cleanups.push(async () => { await terminate(pid) })
    processOwner.child.kill('SIGKILL')
    await processOwner.exited
    await blocked(locks, service)
    await writeFile(join(path, 'helper-release'), '')
    await withServiceLock(locks, service, 30_000, new AbortController().signal, async () => {})
  })
})
