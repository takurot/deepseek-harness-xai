/** Process-level tests of the provider's OS-user/service exclusion and crash recovery. */

import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'

const fixture = fileURLToPath(new URL('./fixtures/lock-worker.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

interface Message {
  kind: string
  id?: string
  code?: string
  value?: unknown
}

interface Worker {
  child: ChildProcess
  messages: Message[]
  send(message: object): void
  next(kind: string, id?: string): Promise<Message>
  exited: Promise<void>
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function store(): Promise<{ root: string; locks: string }> {
  const root = await mkdtemp(join(tmpdir(), 'keychain-process-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const locks = join(root, 'locks')
  await mkdir(locks, { mode: 0o700 })
  return { root, locks }
}

async function start(root: string, locks: string, options: { service?: string; waitMs?: number; pause?: string } = {}): Promise<Worker> {
  const child = fork(fixture, [root, locks, options.service ?? 'test', String(options.waitMs ?? 30_000), options.pause ?? ''], {
    execArgv: ['--import', import.meta.resolve('tsx/esm')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: Message[] = []
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  child.stdout!.resume()
  const listeners = new Set<() => void>()
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); for (const listener of listeners) listener() }) })
  child.on('message', (message) => { messages.push(message as Message); for (const listener of listeners) listener() })
  const worker: Worker = {
    child, messages, exited,
    send(message) { child.send(message) },
    next(kind, id) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const message = messages.find(item => item.kind === kind && (id === undefined || item.id === id))
          if (message !== undefined) { listeners.delete(check); resolve(message) }
          else if (child.exitCode !== null || child.signalCode !== null) {
            listeners.delete(check)
            reject(new Error(`fixture exited before ${kind}: ${stderr}`))
          }
        }
        listeners.add(check)
        check()
      })
    },
  }
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await worker.next('ready')
  return worker
}

async function file(path: string): Promise<string> {
  for (;;) {
    try { return await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await wait(10)
  }
}

describe.skipIf(process.platform === 'win32')('cross-process Keychain records', () => {
  it('keeps concurrent distinct creates and serializes token rotation callbacks', async () => {
    const { root, locks } = await store()
    const first = await start(root, locks)
    const second = await start(root, locks)
    first.send({ action: 'increment', id: 'one', key: 'oauth/one', hold: true })
    await first.next('entered', 'one')
    second.send({ action: 'increment', id: 'two', key: 'oauth/two' })
    await second.next('attempt', 'two')
    first.send({ action: 'release', id: 'release' })
    await first.next('result', 'one')
    await second.next('result', 'two')
    first.send({ action: 'list', id: 'listed' })
    expect((await first.next('result', 'listed')).value).toEqual([
      { key: 'oauth/one', kind: 'grant' }, { key: 'oauth/two', kind: 'grant' },
    ])
    first.send({ action: 'increment', id: 'rotate-one', key: 'oauth/one' })
    second.send({ action: 'increment', id: 'rotate-two', key: 'oauth/one' })
    const results = await Promise.all([first.next('result', 'rotate-one'), second.next('result', 'rotate-two')])
    expect(results.map(result => (result.value as { payload: { n: number } }).payload.n).sort()).toEqual([2, 3])
  })

  it('recovers the kernel lock and durable journal after a writer is killed', async () => {
    const { root, locks } = await store()
    const first = await start(root, locks, { pause: 'journal' })
    first.send({ action: 'increment', id: 'crash', key: 'oauth/one' })
    await first.next('journal')
    first.child.kill('SIGKILL')
    await first.exited
    const successor = await start(root, locks)
    successor.send({ action: 'increment', id: 'after', key: 'oauth/one' })
    expect((await successor.next('result', 'after')).value).toEqual({ kind: 'grant', payload: { n: 2 } })
  })

  it('keeps an orphaned external writer locked after its Node parent is killed', async () => {
    const { root, locks } = await store()
    const first = await start(root, locks, { pause: 'helper' })
    first.send({ action: 'increment', id: 'orphan', key: 'oauth/one' })
    const marker = JSON.parse(await file(join(root, 'helper-ready'))) as { pid: number }
    cleanups.push(async () => {
      try { process.kill(marker.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      for (;;) {
        try { process.kill(marker.pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          throw error
        }
        await wait(10)
      }
    })
    first.child.kill('SIGKILL')
    await first.exited
    const blocked = await start(root, locks, { service: 'other' })
    blocked.send({ action: 'increment', id: 'independent', key: 'oauth/other' })
    expect((await blocked.next('result', 'independent')).value).toEqual({ kind: 'grant', payload: { n: 1 } })
    // Startup recovery itself must wait while the orphan retains the inherited lease.
    const pending = start(root, locks, { waitMs: 100 })
    await expect(pending).rejects.toThrow('timed out waiting for the service lock')
    await writeFile(join(root, 'helper-release'), '')
    const successor = await start(root, locks)
    successor.send({ action: 'increment', id: 'after', key: 'oauth/one' })
    expect((await successor.next('result', 'after')).value).toEqual({ kind: 'grant', payload: { n: 2 } })
  })
})
