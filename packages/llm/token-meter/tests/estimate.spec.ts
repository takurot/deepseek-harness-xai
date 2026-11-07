import { describe, expect, it } from 'vitest'

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { estimateContent, estimateSystemMessage, estimateText, estimateToolsTokens } from '../src/estimate.ts'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'

describe('estimateText', () => {
  it('prices ASCII at four characters per token, rounded up', () => {
    expect(estimateText('')).toBe(0)
    expect(estimateText('abcd')).toBe(1)
    expect(estimateText('abcde')).toBe(2)
  })

  it('prices each CJK code point at one token', () => {
    expect(estimateText('日本語')).toBe(3)
    expect(estimateText('こんにちは')).toBe(5)
    expect(estimateText('한국어')).toBe(3)
    expect(estimateText('，。')).toBe(2)
    expect(estimateText('豈')).toBe(1)
    expect(estimateText('𠀀')).toBe(1)
  })

  it('prices other non-ASCII scripts at two characters per token', () => {
    expect(estimateText('привет!')).toBe(Math.ceil((6 * 2 + 1) / 4))
    expect(estimateText('éé')).toBe(1)
  })

  it('counts a surrogate pair outside the CJK planes once', () => {
    expect(estimateText('😀')).toBe(1)
    expect(estimateText('😀😀')).toBe(1)
    expect(estimateText('😀😀😀')).toBe(2)
  })

  it('prices a lone surrogate as one other code point', () => {
    expect(estimateText('\ud83d')).toBe(1)
    expect(estimateText('\ud83dx')).toBe(1)
  })

  it('sums mixed scripts before rounding', () => {
    expect(estimateText('abc日')).toBe(Math.ceil((3 + 4) / 4))
  })
})

describe('estimate callers use script-aware pricing', () => {
  it('prices CJK text, reasoning, and tool-call arguments above the four-character figure', () => {
    const text = '日本語のテキストです'
    expect(estimateContent([{ type: 'text', text }])).toBe(text.length + 4)
    expect(estimateContent([{ type: 'reasoning', text }] as ContentBlock[])).toBe(text.length + 4)
    expect(estimateContent([{ type: 'tool-call', id: 'c' as never, name: 'bash', arguments: '{"q":"日本"}' }]))
      .toBe(1 + estimateText('{"q":"日本"}') + 4)
  })

  it('prices CJK system text and tool schemas by script', () => {
    expect(estimateSystemMessage(createSystemMessage('日本語'))).toBe(3 + 4)
    const tools = [{ name: 'x', description: '日本語', parameters: { type: 'object' } }]
    expect(estimateToolsTokens({ config: {} as never, tools }))
      .toBe(estimateText(JSON.stringify(tools)) + 4)
  })
})
