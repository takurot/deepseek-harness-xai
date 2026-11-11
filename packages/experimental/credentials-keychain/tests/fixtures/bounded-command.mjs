/** Real process fixtures with explicit readiness and owned descendant descriptors. */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, root] = process.argv.slice(2)
if (mode === 'group-leader') {
  writeFileSync(join(root, 'leader'), String(process.pid))
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'group-child', root], {
    stdio: ['ignore', 'ignore', 'ignore', 3, 'ipc'],
  })
  child.once('message', () => {
    child.disconnect()
    writeFileSync(join(root, 'leader-exit'), '')
    process.exit(0)
  })
} else {
  process.on('SIGTERM', () => { if (mode === 'term-zero') process.exit(0) })
  writeFileSync(join(root, mode === 'group-child' ? 'descendant' : 'ready'), String(process.pid))
  if (mode === 'group-child') process.send({ ready: true })
  setInterval(() => {}, 1000)
}
