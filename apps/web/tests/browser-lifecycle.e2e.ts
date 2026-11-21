/** Benign WebKit controls for the test runner's failure and teardown reporting. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { execa } from 'execa'
import { webkit, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { browserLifecycle } from './browser-lifecycle.ts'

it('reports failures and closes late resources through real Vitest suite hooks', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const fixture = 'apps/web/tests/browser-lifecycle-suite.cases.ts'
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-suite-lifecycle-'))
  const config = join(scratch, 'vitest.config.mjs')
  try {
    await writeFile(config, `export default ${JSON.stringify({ root, test: { include: [fixture], hookTimeout: 20_000 } })}\n`)
    const cli = fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')))
    const result = await execa(process.execPath, [cli, 'run', '--config', config, '--pool=threads', '--maxWorkers=1'], {
      cwd: root, timeout: 90_000, maxBuffer: 512_000, reject: false, all: true,
    })
    const output = stripVTControlCharacters(result.all ?? '')
    expect(result.timedOut, output).toBe(false)
    expect(result.isTerminated, output).toBe(false)
    expect(result.exitCode, output).toBe(1)
    expect(output).toContain('suite normal page closed')
    expect(output).toContain('locator.click: Target page, context or browser has been closed')
    expect(output).toMatch(/^Error: scaffold cleanup failed: suite control scaffold failure\r?$/m)
    expect(output).toContain('Hook timed out in 250ms')
    expect(output).not.toContain('suite scenario unexpectedly ran')
    expect.soft(output).toContain('suite late browser closed without publication or listeners')
    const firstEvents = output.split('\n').filter(line => line.includes('[web lifecycle] first unexpected event'))
    expect.soft(firstEvents).toEqual([
      expect.stringContaining('"event":"page-close","owner":"context-1/page-1","phase":"scenario","unexpected":true'),
    ])
    expect.soft(output).toContain('"event":"cleanup-error","owner":"scaffold","phase":"teardown"')
  } finally {
    await rm(scratch, { recursive: true })
  }
})

describe('WebKit lifecycle through a deliberate early close', () => {
  let messages: (string | undefined)[] | undefined
  const reports: string[] = []
  const cleanup: string[] = []

  it.fails('reports the page action error and all independent cleanup errors', async (test) => {
    onTestFailed(({ task }) => { messages = task.result?.errors?.map(error => error.message) })
    const lifecycle = browserLifecycle(test, webkit, (line) => { reports.push(line) })
    lifecycle.defer('last cleanup', () => { cleanup.push('last cleanup ran') })
    lifecycle.defer('scaffold', () => {
      throw new AggregateError([new AggregateError([new Error('control: replay was not consumed')]), new Error('control: disposal failed')])
    })
    const owned = await lifecycle.launch()
    const page = await owned.newPage()
    lifecycle.ownWait('turn completion', () => Promise.reject(new Error('control: no turn/end')))
    await page.close()
    await owned.browser.close()
    await page.getByRole('button').click()
  })

  // Vitest inverts the case's outcome only after its failure hooks have run.
  afterAll(() => {
    expect(messages).toEqual([
      expect.stringContaining('locator.click: Target page, context or browser has been closed'),
      'control: no turn/end',
      'control: replay was not consumed',
      'control: disposal failed',
    ])
    expect(cleanup).toEqual(['last cleanup ran'])
    expect(reports).toHaveLength(2)
    const first = '"event":"page-close","owner":"context-1/page-1","phase":"scenario","unexpected":true'
    expect(reports[0]).toContain('first unexpected event')
    expect(reports[0]).toContain(first)
    expect(reports[1]).toContain('timeline')
    expect(reports[1]).toContain(first)
    expect(reports[1]).toContain('"event":"disconnected","owner":"browser","phase":"scenario","unexpected":true')
    expect(reports[1]).toContain('"event":"cleanup-error","owner":"scaffold","phase":"teardown"')
    expect(reports[1]).not.toContain('"event":"page-crash"')
  })
})

it('closes the owned WebKit page without reporting an unexpected event', async (test) => {
  const reports: string[] = []
  const state: { page?: Page } = {}
  onTestFinished(() => {
    expect(state.page?.isClosed()).toBe(true)
    expect(reports).toEqual([])
  })
  const owned = await browserLifecycle(test, webkit, (line) => { reports.push(line) }).launch()
  state.page = await owned.newPage()
  expect(owned.browser.isConnected()).toBe(true)
  expect(state.page.isClosed()).toBe(false)
})

describe('WebKit launch resolving after the Vitest timeout', () => {
  let browser: Browser
  let messages: (string | undefined)[] | undefined
  let outcome: Promise<string> | undefined
  let connectedAfterHooks: boolean | undefined
  let observedLateListener = false

  beforeAll(async () => {
    browser = await webkit.launch()
  })

  it.fails('closes the late browser without handing it to the timed-out test', async (test) => {
    const { onTestFailed, onTestFinished } = test
    const launchResult = Promise.withResolvers<Browser>()
    const launch = vi.spyOn(webkit, 'launch').mockReturnValueOnce(launchResult.promise)
    const observe = vi.spyOn(browser, 'once')
    onTestFinished(() => {
      observedLateListener = observe.mock.calls.some(([event]) => event === 'disconnected')
      observe.mockRestore()
      launch.mockRestore()
    })
    const lifecycle = browserLifecycle(test, webkit, () => {})
    outcome = lifecycle.launch().then(
      () => 'browser published',
      (error: unknown) => String(error),
    )
    // The last LIFO hook releases launch only after Vitest has snapshotted its cleanup hooks.
    onTestFinished(() => { launchResult.resolve(browser) })
    onTestFailed(async ({ task }) => {
      messages = task.result?.errors?.map(error => error.message)
      await outcome
      connectedAfterHooks = browser.isConnected()
    })
    await outcome
  }, 500)

  afterAll(async () => {
    try {
      expect(messages).toEqual([expect.stringContaining('Test timed out in 500ms')])
      expect(connectedAfterHooks).toBe(false)
      expect(await outcome).toBe('Error: browser lifecycle is no longer active')
      expect(observedLateListener).toBe(false)
    } finally {
      await browser?.close()
    }
  })
})

it('closes WebKit while context publication is held after cancellation', async (test) => {
  const browser = await webkit.launch()
  test.onTestFinished(() => browser.close())
  const context = await browser.newContext()
  const started = Promise.withResolvers<undefined>()
  const contextResult = Promise.withResolvers<BrowserContext>()
  const createContext = vi.spyOn(browser, 'newContext').mockImplementationOnce(() => {
    started.resolve(undefined)
    return contextResult.promise
  })
  const observeContext = vi.spyOn(context, 'once')
  const createPage = vi.spyOn(context, 'newPage')
  const launch = vi.spyOn(webkit, 'launch').mockResolvedValueOnce(browser)
  const controller = new AbortController()
  const pending: { outcome?: Promise<string> } = {}
  test.onTestFinished(async () => {
    const connected = browser.isConnected()
    contextResult.resolve(context)
    try {
      expect(await pending.outcome).toBe('Error: browser lifecycle is no longer active')
      expect(connected).toBe(false)
      expect(observeContext).not.toHaveBeenCalled()
      expect(createPage).not.toHaveBeenCalled()
    } finally {
      createPage.mockRestore()
      observeContext.mockRestore()
      createContext.mockRestore()
      launch.mockRestore()
    }
  })
  const lifecycle = browserLifecycle({
    signal: controller.signal,
    onTestFinished: test.onTestFinished,
    onTestFailed: test.onTestFailed,
  }, webkit)
  const owned = await lifecycle.launch()
  pending.outcome = owned.newPage().then(
    () => 'page published',
    (error: unknown) => String(error),
  )
  await started.promise
  controller.abort()
  expect(() => { lifecycle.defer('too late', () => {}) }).toThrow('browser lifecycle is no longer active')
})
