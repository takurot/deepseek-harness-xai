/** Actual Secret Service write held in a private test-owned DBus session. */
import { spawn } from 'node:child_process'
import { withServiceLock } from '../../src/service-lock.ts'

const [root, service] = process.argv.slice(2) as [string, string]
await withServiceLock(root, service, 30_000, new AbortController().signal, async (fd) => {
  const child = spawn('secret-tool', ['store', '--label=dsh-test', 'service', service, 'account', 'retained'], {
    stdio: ['pipe', 'pipe', 'pipe', fd],
  })
  child.stdout!.resume()
  child.stderr!.resume()
  const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  child.stdin!.end('synthetic-retained-value')
  process.send!({ pid: child.pid })
  await exited
})
