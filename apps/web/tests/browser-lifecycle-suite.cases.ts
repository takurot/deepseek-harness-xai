/** Vitest subprocess controls for shared browser setup and teardown. */
import { webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { suiteBrowserLifecycle } from './browser-lifecycle.ts'

describe('suite normal close', () => {
  const owner = suiteBrowserLifecycle(webkit)
  let page: Page
  beforeAll(() => owner.setup(async () => {
    page = await (await owner.launch()).newPage()
  }))
  it('owns a live page', () => {
    expect(page.isClosed()).toBe(false)
  })
  afterAll(async () => {
    await owner.close()
    expect(page.isClosed()).toBe(true)
    process.stdout.write('suite normal page closed\n')
  })
})

describe('suite locator failure during setup', () => {
  const owner = suiteBrowserLifecycle(webkit)
  let browser: Browser | undefined
  beforeAll(() => owner.setup(async () => {
    await owner.acquire('scaffold', () => Promise.resolve(null), async () => {
      expect(browser?.isConnected()).toBe(false)
      throw new Error('suite control scaffold failure')
    })
    const owned = await owner.launch()
    browser = owned.browser
    const page = await owned.newPage()
    await page.close()
    await page.getByRole('button').click()
  }))
  it('does not run the scenario', () => {
    throw new Error('suite scenario unexpectedly ran')
  })
  afterAll(() => owner.close())
})

describe('suite browser acquisition after timeout', () => {
  const pending = Promise.withResolvers<Browser>()
  let browser: Browser
  let observedDisconnect = () => false
  let outcome: Promise<string> | undefined
  const owner = suiteBrowserLifecycle(webkit)
  beforeAll(async () => {
    browser = await webkit.launch()
    const observe = vi.spyOn(browser, 'once')
    observedDisconnect = () => observe.mock.calls.some(([event]) => event === 'disconnected')
    vi.spyOn(webkit, 'launch').mockReturnValueOnce(pending.promise)
  })
  beforeAll(() => owner.setup(async () => {
    outcome = owner.launch().then(
      () => 'published',
      (error: unknown) => String(error),
    )
    await outcome
  }), 250)
  it('does not run the scenario', () => {
    throw new Error('suite scenario unexpectedly ran')
  })
  afterAll(async () => {
    const closing = owner.close()
    pending.resolve(browser)
    try {
      await closing
      expect(await outcome).toBe('Error: browser lifecycle is no longer active')
      expect(browser.isConnected()).toBe(false)
      expect(observedDisconnect()).toBe(false)
      process.stdout.write('suite late browser closed without publication or listeners\n')
    } finally {
      vi.restoreAllMocks()
      await browser?.close()
    }
  })
})
