/** Benign WebKit controls for the test runner's failure and teardown reporting. */
import { webkit, type Page } from 'playwright'
import { afterAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { browserLifecycle } from './browser-lifecycle.ts'

describe('WebKit lifecycle through a deliberate early close', () => {
  let messages: (string | undefined)[] | undefined
  const reports: string[] = []
  const cleanup: string[] = []

  it.fails('reports the page action error and all independent cleanup errors', async () => {
    onTestFailed(({ task }) => { messages = task.result?.errors?.map(error => error.message) })
    const lifecycle = browserLifecycle(webkit, (line) => { reports.push(line) })
    lifecycle.defer('last cleanup', () => { cleanup.push('last cleanup ran') })
    lifecycle.defer('scaffold', () => {
      throw new AggregateError([new AggregateError([new Error('control: replay was not consumed')]), new Error('control: disposal failed')])
    })
    const owned = await lifecycle.launch()
    const page = await owned.newPage()
    lifecycle.ownWait('turn completion', Promise.reject(new Error('control: no turn/end')))
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

it('closes the owned WebKit page without reporting an unexpected event', async () => {
  const reports: string[] = []
  const state: { page?: Page } = {}
  onTestFinished(() => {
    expect(state.page?.isClosed()).toBe(true)
    expect(reports).toEqual([])
  })
  const owned = await browserLifecycle(webkit, (line) => { reports.push(line) }).launch()
  state.page = await owned.newPage()
  expect(owned.browser.isConnected()).toBe(true)
  expect(state.page.isClosed()).toBe(false)
})
