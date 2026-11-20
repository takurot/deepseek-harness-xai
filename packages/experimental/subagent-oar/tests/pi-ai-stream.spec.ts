/** Exercise the Pi provider API resolved by the experimental OAR package. */

import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { expect, it } from 'vitest'
import { piLoopback } from './fixtures/pi-loopback.ts'

it('emits tool argument deltas, finalizes the arguments, and replays the Gemini signature', async (test) => {
  const signature = 'fixture-thought-signature'
  const args = ['{"value":', '"hello"}']
  const frames = [
    { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' }, extra_content: { google: { thought_signature: signature } } }] }, finish_reason: null },
    ...args.map(fragment => ({ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, finish_reason: null })),
    { delta: {}, finish_reason: 'tool_calls' },
  ]
  const { baseUrl, bodies } = await piLoopback(test, [frames, [
    { delta: { role: 'assistant', content: 'done' }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' },
  ]].map(choices => choices.map(choice => JSON.stringify({ choices: [{ index: 0, ...choice }] }))))
  const model = {
    id: 'fixture', name: 'Fixture', api: 'openai-completions' as const, provider: 'test',
    baseUrl, reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  }
  const user = { role: 'user' as const, content: 'Echo a greeting.', timestamp: 0 }
  const options = { apiKey: 'fixture-key', signal: test.signal }
  const first = stream(model, normalizeContext({ messages: [user] }), options)
  const deltas: string[] = []
  for await (const event of first) {
    if (event.type === 'error') throw new Error(event.error.errorMessage)
    if (event.type === 'toolcall_delta' && event.delta) deltas.push(event.delta)
  }
  expect(deltas).toEqual(args)
  const assistant = await first.result()
  expect(assistant.content).toContainEqual(expect.objectContaining({
    type: 'toolCall', id: 'call_1', name: 'echo', arguments: { value: 'hello' }, thoughtSignature: signature,
  }))
  const replay = stream(model, normalizeContext({ messages: [user, assistant, {
    role: 'toolResult', toolCallId: 'call_1', toolName: 'echo', timestamp: 0,
    content: [{ type: 'text', text: 'hello' }], isError: false,
  }] }), options)
  expect((await replay.result()).stopReason).toBe('stop')
  expect(bodies).toHaveLength(2)
  const replayBody = JSON.parse(bodies[1]!) as { messages: { role: string; tool_calls?: object[] }[] }
  expect(replayBody.messages.find(message => message.role === 'assistant')?.tool_calls?.[0]).toMatchObject({
    id: 'call_1', extra_content: { google: { thought_signature: signature } },
  })
})
