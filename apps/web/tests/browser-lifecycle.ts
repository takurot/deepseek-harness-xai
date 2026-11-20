/** Test-owned browser observations and independent Vitest cleanup hooks. */
import type { Browser, BrowserContextOptions, BrowserType, Page } from 'playwright'
import type { TestContext } from 'vitest'

type EventKind = 'launch-start' | 'browser-ready' | 'context-ready' | 'page-ready'
  | 'page-crash' | 'page-close' | 'context-close' | 'disconnected'
  | 'cleanup-start' | 'cleanup-finish' | 'cleanup-error'

interface Observation {
  readonly sequence: number
  readonly elapsedMs: number
  readonly event: EventKind
  readonly owner: string
  readonly phase: 'scenario' | 'teardown'
  readonly unexpected: boolean
}

function leafErrors(error: unknown): unknown[] {
  // Vitest expands only the outer AggregateError in a test or hook result.
  return error instanceof AggregateError && error.errors.length > 0 ? error.errors.flatMap(leafErrors) : [error]
}

/**
 * Observe a test's browser resources without recording navigation or page data.
 * Cleanup hooks run in reverse acquisition order and fail independently of the scenario.
 * @param test - Vitest case that owns resources and stops publishing them at timeout.
 * @param engine - Browser engine under test; one launch is owned by this test.
 * @param report - Sink for the first unexpected terminal event and the timeline on failure. Defaults to stderr.
 * @returns Operations to launch the browser, observe pages, and register cleanup on the current test.
 */
export function browserLifecycle(
  test: Pick<TestContext, 'signal' | 'onTestFinished' | 'onTestFailed'>,
  engine: BrowserType,
  report: (line: string) => void = console.error,
) {
  const startedAt = performance.now()
  const identity = { engine: engine.name(), workerPid: process.pid }
  const observations: Observation[] = []
  const detach: (() => void)[] = []
  let phase: Observation['phase'] = 'scenario'
  let version: string | null = null
  let firstUnexpected: Observation | null = null
  let sequence = 0

  function record(event: EventKind, owner: string, unexpected = false): void {
    const observation: Observation = {
      sequence: ++sequence, elapsedMs: Math.round(performance.now() - startedAt), event, owner, phase, unexpected,
    }
    observations.push(observation)
    if (observations.length > 32) observations.shift()
    if (unexpected && firstUnexpected === null) {
      firstUnexpected = observation
      report(`[web lifecycle] first unexpected event ${JSON.stringify({ ...identity, version, firstUnexpected })}`)
    }
  }

  const active = (): boolean => !test.signal.aborted && phase === 'scenario'
  function requireActive(): void {
    if (!active()) throw new Error('browser lifecycle is no longer active')
  }

  test.onTestFinished(() => {
    for (const stop of detach) stop()
  })
  test.onTestFailed(() => {
    report(`[web lifecycle] timeline ${JSON.stringify({ ...identity, version, firstUnexpected, observations })}`)
  })

  function defer(owner: string, cleanup: () => void | Promise<void>): void {
    requireActive()
    test.onTestFinished(async () => {
      phase = 'teardown'
      record('cleanup-start', owner)
      try {
        await cleanup()
        record('cleanup-finish', owner)
      } catch (error) {
        record('cleanup-error', owner)
        throw new AggregateError(leafErrors(error), `${owner} cleanup failed`)
      }
    })
  }

  function track<T>(owner: string, start: () => Promise<T>, dispose?: (value: T) => Promise<void>): () => Promise<T> {
    requireActive()
    const started = Promise.withResolvers<T>()
    const outcome = started.promise.then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let observed = false
    defer(owner, async () => {
      const result = await outcome
      if (result.ok) await dispose?.(result.value)
      else if (!observed) throw result.error
    })
    try {
      started.resolve(start())
    } catch (error) {
      started.reject(error)
    }
    return async () => {
      const result = await outcome
      requireActive()
      observed = true
      if (!result.ok) throw new AggregateError(leafErrors(result.error), `${owner} failed`)
      return result.value
    }
  }

  function acquire<T>(owner: string, start: () => Promise<T>, dispose: (value: T) => Promise<void>): Promise<T> {
    return track(owner, start, dispose)()
  }

  async function launch(): Promise<{ browser: Browser; newPage(options?: BrowserContextOptions): Promise<Page> }> {
    requireActive()
    record('launch-start', 'browser')
    let closeRequested = false
    const browser = await acquire('browser', () => engine.launch(), async (owned) => {
      closeRequested = true
      await owned.close()
    })
    requireActive()
    const onDisconnected = (): void => { record('disconnected', 'browser', !closeRequested) }
    browser.once('disconnected', onDisconnected)
    detach.push(() => { browser.off('disconnected', onDisconnected) })
    version = browser.version()
    record('browser-ready', 'browser')
    let contextCount = 0

    return { browser, async newPage(options) {
      requireActive()
      const contextId = `context-${++contextCount}`
      const context = await browser.newContext(options)
      requireActive()
      let pageCount = 0
      const onContextClose = (): void => { record('context-close', contextId, !closeRequested) }
      const onPage = (page: Page): void => {
        if (!active()) return
        const pageId = `${contextId}/page-${++pageCount}`
        const onCrash = (): void => { record('page-crash', pageId, true) }
        const onClose = (): void => { record('page-close', pageId, !closeRequested) }
        page.once('crash', onCrash)
        page.once('close', onClose)
        detach.push(() => { page.off('crash', onCrash); page.off('close', onClose) })
        record('page-ready', pageId)
      }
      context.once('close', onContextClose)
      context.on('page', onPage)
      detach.push(() => { context.off('close', onContextClose); context.off('page', onPage) })
      record('context-ready', contextId)
      const page = await context.newPage()
      requireActive()
      return page
    } }
  }

  return { acquire, defer, launch, ownWait: track }
}
