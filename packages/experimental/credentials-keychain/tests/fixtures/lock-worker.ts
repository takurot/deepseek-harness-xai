/** Independent provider process; only the external secret store is a file fixture. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider, macosBackend } from '../../src/index.ts'
import type { KeychainBackend, KeychainCommandRunner } from '../../src/index.ts'

const [root, lockRoot, service, waitText, pause] = process.argv.slice(2) as [string, string, string, string, string | undefined]
const release = Promise.withResolvers<undefined>()

class FileBackend implements KeychainBackend {
  private paused = false

  constructor(private readonly run: KeychainCommandRunner) {}

  private path(account: string): string {
    return join(root, service, Buffer.from(account).toString('base64url'))
  }

  async get(account: string): Promise<string | undefined> {
    try { return await readFile(this.path(account), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async set(account: string, value: string): Promise<void> {
    if (!this.paused && account === 'record-transaction-v1' && pause === 'helper') {
      this.paused = true
      await this.run(process.execPath, [fileURLToPath(new URL('./lock-helper.mjs', import.meta.url)),
        this.path(account), join(root, 'helper-ready'), join(root, 'helper-release')], value)
      return
    }
    const path = this.path(account)
    const temporary = `${path}.${String(process.pid)}.tmp`
    await writeFile(temporary, value, { mode: 0o600 })
    await rename(temporary, path)
    if (!this.paused && account === 'record-transaction-v1' && pause === 'journal') {
      this.paused = true
      process.send!({ kind: 'journal' })
      await release.promise
    }
  }

  async delete(account: string): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.path(account), { force: true })
  }
}

class FixtureProvider extends KeychainCredentialProvider {
  protected override lockDirectory(): string { return lockRoot }
  protected override createBackend(_service: string, run: KeychainCommandRunner): KeychainBackend {
    if (pause?.startsWith('macos')) {
      let paused = false
      return macosBackend(service, (command, args, stdin) => {
        if (pause === 'macos-helper' && !paused && command === '/usr/bin/osascript'
          && stdin !== undefined && (JSON.parse(stdin) as { operation: string }).operation === 'set') {
          paused = true
          const marker = JSON.stringify(join(root, 'helper-ready'))
          const gate = JSON.stringify(join(root, 'helper-release'))
          const barrier = `$(JSON.stringify({pid: Number($.NSProcessInfo.processInfo.processIdentifier)})).dataUsingEncoding($.NSUTF8StringEncoding).writeToFileAtomically(${marker}, true); while (!$.NSFileManager.defaultManager.fileExistsAtPath(${gate})) $.NSThread.sleepForTimeInterval(0.01);`
          return run(command, args.map((arg, index) => index === 3 ? arg.replace('let status = $.SecItemUpdate', barrier + 'let status = $.SecItemUpdate') : arg), stdin)
        }
        return run(command, args, stdin)
      })
    }
    return new FileBackend(run)
  }
}

await mkdir(join(root, service), { recursive: true, mode: 0o700 })
const context = new Context()
const fiber = context.plugin(FixtureProvider, { service, lockWaitMs: Number(waitText) })
await fiber
process.send!({ kind: 'ready' })

interface Command {
  action: 'increment' | 'list' | 'release' | 'dispose'
  id: string
  key?: string
  hold?: boolean
}

async function command(message: Command): Promise<void> {
  if (message.action === 'release') { release.resolve(undefined); return }
  if (message.action === 'dispose') {
    await fiber.dispose()
    process.send!({ kind: 'disposed', id: message.id })
    process.disconnect()
    return
  }
  if (message.action === 'list') {
    process.send!({ kind: 'result', id: message.id, value: await context.credentials.listRecords() })
    return
  }
  process.send!({ kind: 'attempt', id: message.id })
  const record = await context.credentials.modifyRecord(parseCredentialKey(message.key!), async (current) => {
    process.send!({ kind: 'entered', id: message.id })
    if (message.hold) await release.promise
    const n = current?.kind === 'grant' ? (current.payload as { n: number }).n : 0
    return { kind: 'grant', payload: { n: n + 1 } }
  })
  process.send!({ kind: 'result', id: message.id, value: record })
}

process.on('message', (message: Command) => {
  void command(message).catch((error: unknown) => {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    process.send!({ kind: 'failure', id: message.id, code, message: error instanceof Error ? error.message : 'fixture operation failed' })
  })
})
