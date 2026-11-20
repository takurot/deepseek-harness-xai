/** Recorded-session recovery through Chromium and WebKit's native JSON validation. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { describe, expect, it, onTestFailed } from 'vitest'
import { browserLifecycle } from './browser-lifecycle.ts'
import {
  acknowledgeReloadConnectionLoss, captureExpandedTurnProcessAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/ui-expanded.expected.md', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web session replay', () => {
  it.for([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
    '$name restores an active stream, a completed turn, and a reopened session', async ({ engine }, test) => {
      const lifecycle = browserLifecycle(test, engine)
      const scaffold = await lifecycle.acquire('scaffold',
        () => launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: 'read-only' }),
        scaffold => scaffold.close())
      const release = Promise.withResolvers<undefined>()
      const reached = Promise.withResolvers<string>()
      let paused = false
      // Hold the recorded stream until the reloaded page has received its active baseline.
      const dispose = scaffold.ctx.on('llm/stream', async function* (_options, next) {
        for await (const chunk of next()) {
          yield chunk
          if (!paused && chunk.type === 'text-delta' && chunk.text.trim()) {
            paused = true
            reached.resolve(chunk.text.trim())
            await release.promise
          }
        }
      }, { prepend: true })
      lifecycle.defer('stream listener', () => { release.resolve(undefined); dispose() })
      const browser = await lifecycle.launch()
      const page = await newEnglishPage(browser)
      onTestFailed(() => saveFailureShot(page, `session-replay-reload-${engine.name()}`))
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const prompts = fixtureUserPrompts(await readFile(await selectedSessionFixture(FIXTURE), 'utf8'))
      expect(prompts).toHaveLength(1)
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill(prompts[0]!)
      await input.press('Enter')
      const partial = await reached.promise
      const waitForTurn = lifecycle.ownWait('released turn completion', () => scaffold.whenTurnSettled())
      lifecycle.defer('release paused stream', () => { release.resolve(undefined) })
      const streaming = page.locator('[data-streaming="true"]').getByText(partial, { exact: true })
      await streaming.waitFor({ timeout: 15_000 })
      const activeWarningStart = tripwire.warnings.length
      await page.reload()
      await streaming.waitFor({ timeout: 15_000 })
      acknowledgeReloadConnectionLoss(tripwire, activeWarningStart)
      expect(tripwire.pageErrors).toEqual([])
      release.resolve(undefined)
      await waitForTurn()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      const warningStart = tripwire.warnings.length
      await page.reload()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await compareOrRefreshGolden(UI_EXPECTED,
        await captureExpandedTurnProcessAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), 'replay')

      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await page.getByText('Into the Unknown', { exact: true }).waitFor()
      await page.getByRole('treeitem').filter({ has: page.getByText('Use the bash tool to', { exact: true }) }).click()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      await compareOrRefreshGolden(UI_EXPECTED,
        await captureExpandedTurnProcessAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), 'replay')
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    },
  )
})
