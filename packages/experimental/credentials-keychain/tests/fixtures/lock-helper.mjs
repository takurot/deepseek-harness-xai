/** Paused external item write; fd 3 remains inherited until this helper exits. */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'

const [target, marker, release] = process.argv.slice(2)
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
await writeFile(marker, JSON.stringify({ pid: process.pid }))
for (;;) {
  try { await readFile(release); break } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await wait(10)
}
const temporary = target + '.helper-tmp'
await writeFile(temporary, Buffer.concat(chunks), { mode: 0o600 })
await rename(temporary, target)
