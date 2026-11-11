/** Hold a real interactive security process after an OS lookup, with inherited flock and FIFO stdin. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { withServiceLock } from '../../src/service-lock.ts'

const [root, service, fifo] = process.argv.slice(2) as [string, string, string]
await withServiceLock(root, service, 30_000, new AbortController().signal, async (fd) => {
  const input = await open(fifo, constants.O_RDWR)
  const child = spawn('/usr/bin/security', ['-i'], { stdio: [input.fd, 'pipe', 'pipe', fd] })
  let output = ''
  const ready = Promise.withResolvers<undefined>()
  child.stdout!.on('data', (chunk) => { output += String(chunk); if (output.includes('could not be found')) ready.resolve(undefined) })
  child.stderr!.on('data', (chunk) => { output += String(chunk); if (output.includes('could not be found')) ready.resolve(undefined) })
  const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  await input.write(`find-generic-password -s ${service} -a absent -w\n`)
  await ready.promise
  process.send!({ kind: 'ready', pid: child.pid })
  await exited
  await input.close()
})
