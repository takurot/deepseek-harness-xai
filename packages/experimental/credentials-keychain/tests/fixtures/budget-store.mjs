/** External Secret Service command fixture; values travel only through stdin/stdout. */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [root, operation, ...attributes] = process.argv.slice(2)
const account = attributes.at(-1)
const directory = join(root, 'items')
await mkdir(directory, { recursive: true, mode: 0o700 })
const path = join(directory, Buffer.from(account).toString('base64url'))
let behavior = {}
try { behavior = JSON.parse(await readFile(join(root, 'behavior'), 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await appendFile(join(root, 'events'), JSON.stringify({ operation, account }) + '\n')
let value = ''
if (operation === 'store') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  value = Buffer.concat(chunks).toString('utf8')
}
const selected = operation === behavior.operation && (behavior.account === undefined || behavior.account === account)
async function store() {
  const temporary = path + '.' + String(process.pid)
  await writeFile(temporary, value, { mode: 0o600 })
  await rename(temporary, path)
}
if (selected && behavior.writeFirst) await store()
if (selected && behavior.hang) {
  process.on('SIGTERM', () => { if (!behavior.ignoreTerm) process.exit(0) })
  await writeFile(join(root, 'ready-' + String(process.pid)), JSON.stringify({ pid: process.pid, operation, account }))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (selected && behavior.fail) {
  process.stderr.write('PRIVATE_STORE_VALUE')
  process.exit(2)
}
if (operation === 'store') await store()
if (operation === 'clear') await rm(path, { force: true })
if (operation === 'lookup') {
  try { process.stdout.write(await readFile(path)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    process.exitCode = 1
  }
}
