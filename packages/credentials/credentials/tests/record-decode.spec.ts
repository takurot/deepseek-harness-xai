/** Durable input validation never quotes supplied record contents. */
import { describe, expect, it } from 'vitest'
import { decodeCredentialRecord } from '../src/index.ts'

const SUBJECT = 'credential record'

describe('decodeCredentialRecord', () => {
  it('copies JSON data independently while permitting repeated references', () => {
    const repeated = { token: 'secret' }
    const input = { kind: 'grant', payload: { a: repeated, b: repeated, empty: [] } }
    const output = decodeCredentialRecord(input, SUBJECT)
    expect(output).toEqual(input)
    expect(output).not.toBe(input)
    expect(output.kind === 'grant' && output.payload).not.toBe(input.payload)
  })

  it('normalizes optional API-key fields and preserves unusual valid environment names', () => {
    expect(decodeCredentialRecord({ kind: 'api-key', key: undefined, env: undefined }, SUBJECT)).toEqual({ kind: 'api-key' })
    const env: unknown = JSON.parse('{"__proto__":"profile","REGION":"eu"}')
    expect(decodeCredentialRecord({ kind: 'api-key', env }, SUBJECT)).toEqual({ kind: 'api-key', env })
  })

  it.each([
    null, [], 5, new (class Record { kind = 'api-key' })(),
    {}, { kind: 'private-secret' }, { kind: 'grant' },
    { kind: 'api-key', key: '' }, { kind: 'api-key', key: 5 },
    { kind: 'api-key', env: null }, { kind: 'api-key', env: [] },
    { kind: 'api-key', env: { 'private-secret': 'value' } },
    { kind: 'api-key', env: { OK: '' } }, { kind: 'api-key', env: { OK: 5 } },
    { kind: 'api-key', 'private-secret': true },
  ])('refuses invalid record fields without echoing them: %#', (value) => {
    expect(() => decodeCredentialRecord(value, SUBJECT)).toThrow(TypeError)
    try { decodeCredentialRecord(value, SUBJECT) } catch (error) {
      expect(String(error)).not.toContain('private-secret')
      expect(error).not.toHaveProperty('cause')
    }
  })

  it('rejects lossy payload fields, sparse arrays and accessors without evaluating them', () => {
    let invoked = false
    const accessor = { get secret() { invoked = true; return 'private-secret' } }
    const accessorArray = [1]
    Object.defineProperty(accessorArray, '0', { get() { invoked = true; return 'private-secret' } })
    const hiddenArray = [1]
    Object.defineProperty(hiddenArray, '0', { enumerable: false })
    const holeWithExtra = Object.assign(Array(1), { extra: 'private-secret' })
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const nullPrototype: unknown = Object.create(null)
    const invalid = [nullPrototype,
      undefined, NaN, Infinity, -Infinity, -0, BigInt(1), Symbol('private-secret'), () => 1,
      { nested: undefined }, cyclic, new Date(),
      new (class Payload { token = 'value' })(), new (class List extends Array<number> {})(),
      Object.assign([1], { extra: true }), Array(1), holeWithExtra, accessorArray, hiddenArray,
      Object.defineProperty({}, 'secret', { value: 'private-secret' }),
      { [Symbol('secret')]: 'private-secret' }, accessor, { toJSON() { invoked = true; return 'private-secret' } },
    ]
    for (const payload of invalid) {
      expect(() => decodeCredentialRecord({ kind: 'grant', payload }, SUBJECT)).toThrow(TypeError)
    }
    for (const value of [accessor, { kind: 'api-key', env: accessor }]) {
      expect(() => decodeCredentialRecord(value, SUBJECT)).toThrow(TypeError)
    }
    expect(invoked).toBe(false)
  })
})
