import { expect, it } from 'vitest'
import { browserInputs, stagehandModelSchema } from '../src/native.ts'

it('validates native model settings through the installed Stagehand configuration schema', () => {
  expect(stagehandModelSchema.parse({ modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture', headers: { 'x-fixture': 'schema' } }))
    .toEqual({ modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture', headers: { 'x-fixture': 'schema' } })
  expect(() => stagehandModelSchema.parse({ modelName: 'unsupported/fixture', apiKey: 'fixture' })).toThrow()
  expect(() => stagehandModelSchema.parse({ modelName: 'openai/gpt-5.4-mini', apiKey: ' ' })).toThrow('nonblank')
  expect(browserInputs.extract.parse({ instruction: 'Read heading', schema: { type: 'object' } }))
    .toEqual({ instruction: 'Read heading', schema: { type: 'object' } })
  expect(() => browserInputs.extract.parse({ instruction: '' })).toThrow()
})
