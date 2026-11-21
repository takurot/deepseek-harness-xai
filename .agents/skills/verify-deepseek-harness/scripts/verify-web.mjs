#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright')
const feature = process.argv[2]
assert(['appearance', 'workspace', 'plugins'].includes(feature), 'Usage: verify-web.mjs appearance|workspace|plugins')
const cli = join(root, 'apps/cli/lib/bin.js')
const overlay = join(root, 'apps/web/tests/pin-browse-picker.overlay.yml')
const evidenceRoot = join(root, '.artifacts/dsh-web-verification')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, feature + '-'))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-verify-'))
const home = join(scratch, 'home')
const env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  HOME: scratch,
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(scratch, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
}
const args = [cli, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open']
console.log('Evidence directory: ' + evidence)

const redact = value => String(value).replace(/([?&]token=)[^\s"'<>]+/gu, '$1[redacted]')
const actions = []
const browserErrors = []
const record = message => actions.push(redact(message))
const exact = (scope, role, name) => scope.getByRole(role, { name, exact: true })

let output = ''
let browser
let page
let server
let closed
let port
let success = false
const interrupt = () => server?.kill('SIGTERM')
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

async function capture(label) {
  await page.screenshot({ path: join(evidence, label + '.png') })
  await writeFile(join(evidence, label + '.aria.txt'), redact(await page.locator('body').ariaSnapshot()) + '\n')
}

async function dismissSignIn() {
  const dialog = exact(page, 'dialog', 'Get started')
  await exact(dialog, 'button', 'Close').click()
  await dialog.waitFor({ state: 'hidden' })
  record('First-run UI: Get started > Close')
}

async function openSettings() {
  await exact(page, 'button', 'Account menu').click()
  await exact(page, 'menuitem', 'Settings').click()
  return exact(page, 'dialog', 'Settings')
}

try {
  for (const path of [cli, join(root, 'apps/web/dist/index.html')]) await readFile(path)
  const version = execFileSync(process.execPath, [cli, '--version'], { cwd: scratch, env, encoding: 'utf8' }).trim()
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()
  record(JSON.stringify({ feature, revision, trackedChanges: Boolean(dirty), version, node: process.version, args, home }))
  server = spawn(process.execPath, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = Promise.withResolvers()
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      output += chunk
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)\r?\n/mu.exec(output)
      if (match) ready.resolve(new URL(match[1]))
    })
  }
  server.once('error', ready.reject)
  closed = new Promise(resolve => server.once('close', (code, signal) => {
    ready.reject(new Error(`Server exited before ready (code=${code}, signal=${signal})`))
    resolve()
  }))
  const timer = setTimeout(() => ready.reject(new Error('Server readiness timed out')), 45_000)
  const url = await ready.promise.finally(() => clearTimeout(timer))
  port = url.port
  const owners = () => execFileSync('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
  assert.equal(owners(), String(server.pid), 'Listener must belong to the launched server')
  assert.equal((await fetch(url.origin, { signal: AbortSignal.timeout(5_000) })).status, 401)
  browser = await chromium.launch()
  async function authenticate() {
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1680, height: 1000 }, colorScheme: 'light' })
    page.setDefaultTimeout(15_000)
    page.on('pageerror', error => browserErrors.push(redact(error.stack ?? error)))
    page.on('console', message => {
      if (message.type() === 'error' || message.text().startsWith('web boot: warning')) browserErrors.push(redact(message.text()))
    })
    const response = await page.goto(url.href)
    assert.equal(response?.status(), 200, 'Authenticated Web document')
    await page.locator('[class*="frame"]').waitFor()
  }
  await authenticate()
  record(`Doctor: PID ${server.pid} owns ${url.origin}; anonymous HTTP 401; authenticated HTTP 200; application frame mounted`)
  const notice = exact(page, 'dialog', 'Preview Notice')
  await notice.waitFor()
  await capture('first-run')
  record('First-run UI: Preview Notice > Continue')
  await exact(notice, 'button', 'Continue').click()
  await notice.waitFor({ state: 'hidden' })
  await dismissSignIn()
  await exact(page, 'button', 'Account menu').waitFor()
  await capture('before')
  if (feature === 'appearance') {
    record('Account menu > Settings > General > Dark')
    const dialog = await openSettings()
    await exact(dialog, 'button', 'Dark').click()
    await dialog.getByRole('button', { name: 'Dark', exact: true, pressed: true }).waitFor()
    await page.locator('body[data-ds-dark-theme]').waitFor()
    await capture('changed')
    await page.context().close()
    await authenticate()
    await dismissSignIn()
    const restored = await openSettings()
    assert.equal(await exact(restored, 'button', 'Dark').getAttribute('aria-pressed'), 'true')
    await page.locator('body[data-ds-dark-theme]').waitFor()
    record('A fresh authenticated browser context restored Dark and the dark palette from the host')
  } else if (feature === 'workspace') {
    const workspace = join(scratch, 'verification-workspace')
    await mkdir(workspace)
    record('Add workspace > Select Workspace Directory > verification-workspace > Open (' + workspace + ')')
    await exact(page, 'button', 'Add workspace').click()
    const picker = exact(page, 'dialog', 'Select Workspace Directory')
    const folder = exact(picker, 'button', 'verification-workspace')
    await folder.click()
    await folder.and(picker.locator('[aria-current="true"]')).waitFor()
    await capture('selected-directory')
    await exact(picker, 'button', 'Open').click()
    await picker.waitFor({ state: 'hidden' })
    const workspaceTitle = () => exact(exact(page, 'tree', 'Sessions'), 'treeitem', 'verification-workspace')
    await workspaceTitle().waitFor()
    await capture('added')
    await page.context().close()
    await authenticate()
    await dismissSignIn()
    await workspaceTitle().waitFor()
    record('A fresh authenticated browser context listed the adopted workspace in Sessions')
  } else {
    record('Global panels > Plugins')
    await exact(exact(page, 'navigation', 'Global panels'), 'button', 'Plugins').click()
    const panel = page.locator('[data-plugin-panel]')
    await exact(panel, 'heading', 'Plugins').waitFor()
    await exact(panel, 'button', 'Add plugin').waitFor()
    record('Plugins panel and Add plugin action are visible')
  }
  await capture('after')
  assert.deepEqual(browserErrors, [], 'Browser errors and inactive-plugin warnings')
  success = true
} catch (error) {
  record(error.stack ?? error)
  if (page && !page.isClosed()) await capture('failure').catch(error => record(error))
} finally {
  try {
    await browser?.close()
  } finally {
    if (server) {
      const escalation = setTimeout(() => {
        success = false
        record('Cleanup: server required SIGKILL after SIGTERM')
        server.kill('SIGKILL')
      }, 10_000)
      server.kill('SIGTERM')
      await closed
      clearTimeout(escalation)
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await rm(scratch, { recursive: true, force: true })
    if (port) {
      try {
        execFileSync('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'])
        record('Cleanup: previous verification port still has a listener')
        success = false
      } catch (error) {
        if (error.status !== 1) {
          record(error)
          success = false
        } else {
          record('Cleanup: previous verification port has no listener')
        }
      }
    }
    record('Cleanup: verification server exited and scratch home was removed')
    await writeFile(join(evidence, 'run.log'), actions.join('\n') + '\n')
    await writeFile(join(evidence, 'server.log'), redact(output))
    await writeFile(join(evidence, 'browser-errors.log'), browserErrors.join('\n'))
    await readFile(join(evidence, 'run.log'))
  }
}
console.log((success ? 'PASS' : 'FAIL') + ' ' + feature)
process.exitCode = success ? 0 : 1
