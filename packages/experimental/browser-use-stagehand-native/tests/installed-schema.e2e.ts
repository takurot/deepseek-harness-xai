/** Installed Stagehand extraction with Chromium and its public deterministic model callback. */
import { Stagehand, localBrowser } from '@browserbasehq/stagehand'
import type { ClientLLM } from '@browserbasehq/stagehand'
import { expect, it } from 'vitest'
import { z } from 'zod'

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1')('serializes caller JSON Schema and validates actual SDK extraction responses', { timeout: 120_000, retry: 0 }, async () => {
  const executablePath = process.env.DSH_BROWSER_EXECUTABLE
  if (executablePath === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
  const browser = await localBrowser.launch({ executablePath, headless: true })
  let stagehand: Stagehand | undefined
  const schemas: unknown[] = []
  let heading: string | number = 'Schema fixture'
  const model: ClientLLM = {
    async generate(request) {
      if (request.responseFormat?.type !== 'json_schema') throw new Error('Expected structured extraction')
      schemas.push(request.responseFormat.schema)
      const structuredContent = request.responseFormat.name === 'Metadata' ? { progress: 'Read heading', completed: true } : { heading }
      return { role: 'assistant', content: { type: 'text', text: 'Fixture response' }, outputFormat: 'json_schema', structuredContent }
    },
  }
  try {
    stagehand = await Stagehand.create({ browser, model, logging: { level: 'off' } })
    const page = await browser.context.newPage('data:text/html,<title>Schema fixture</title><h1>Schema fixture</h1>')
    const schema = z.fromJSONSchema({ type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'], additionalProperties: false })
    expect((await stagehand.extract('Read the heading', schema, { page })).data).toEqual({ heading: 'Schema fixture' })
    expect(schemas[0]).toMatchObject({ type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'] })
    heading = 42
    await expect(stagehand.extract('Read the heading again', schema, { page })).rejects.toThrow()
  } finally {
    try {
      await stagehand?.close()
    } finally {
      await browser.close()
    }
  }
})
