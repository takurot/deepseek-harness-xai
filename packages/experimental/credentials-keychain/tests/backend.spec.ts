import { describe, expect, it } from 'vitest'

import { createBackend, macosBackend, secretServiceBackend, spawnRunner } from '../src/index.ts'
import type { KeychainCommandResult, KeychainCommandRunner } from '../src/index.ts'

interface Call { command: string; args: readonly string[]; stdin?: string }

function fake(result: Partial<KeychainCommandResult>): { run: KeychainCommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: KeychainCommandRunner = (command, args, stdin) => {
    calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) })
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...result })
  }
  return { run, calls }
}

describe('macosBackend', () => {
  it('reads a base64 secret from stdout and keeps the secret out of argv', async () => {
    const { run, calls } = fake({ stdout: `${Buffer.from('s3cret ünï').toString('base64')}\n` })
    expect(await macosBackend('dsh', run).get('ref:KEY')).toBe('s3cret ünï')
    expect(calls[0]).toEqual({ command: 'security', args: ['find-generic-password', '-s', 'dsh', '-a', 'ref:KEY', '-w'] })
  })

  it('maps exit 44 to an absent secret and other failures to errors with the tool diagnostic', async () => {
    expect(await macosBackend('dsh', fake({ code: 44 }).run).get('a')).toBeUndefined()
    await expect(macosBackend('dsh', fake({ code: 1, stderr: 'denied\n' }).run).get('a'))
      .rejects.toThrow('security find-generic-password failed with exit code 1: denied')
    await expect(macosBackend('dsh', fake({ code: null }).run).get('a')).rejects.toThrow('exit code null')
  })

  it('writes through stdin as base64 so quotes cannot reach the interactive parser', async () => {
    const { run, calls } = fake({})
    await macosBackend('dsh', run).set('ref:KEY', 'a "quoted" b')
    expect(calls[0]!.args).toEqual(['-i'])
    expect(calls[0]!.stdin).toBe(`add-generic-password -U -s dsh -a ref:KEY -w ${Buffer.from('a "quoted" b').toString('base64')}\n`)
    expect(JSON.stringify(calls[0]!.args)).not.toContain('quoted')
    await expect(macosBackend('dsh', fake({ code: 1 }).run).set('a', 'b')).rejects.toThrow('add-generic-password failed')
  })

  it('deletes through stdin and treats a missing item as removed', async () => {
    const { run, calls } = fake({})
    await macosBackend('dsh', run).delete('ref:KEY')
    expect(calls[0]!.stdin).toBe('delete-generic-password -s dsh -a ref:KEY\n')
    await macosBackend('dsh', fake({ code: 44 }).run).delete('a')
    await expect(macosBackend('dsh', fake({ code: 2, stderr: 'locked' }).run).delete('a')).rejects.toThrow('locked')
  })
})

describe('secretServiceBackend', () => {
  it('looks up, stores through stdin, and clears', async () => {
    const lookup = fake({ stdout: 'value' })
    expect(await secretServiceBackend('dsh', lookup.run).get('ref:K')).toBe('value')
    expect(lookup.calls[0]!.args).toEqual(['lookup', 'service', 'dsh', 'account', 'ref:K'])
    const store = fake({})
    await secretServiceBackend('dsh', store.run).set('ref:K', 'line1\nline2')
    expect(store.calls[0]!.args).toEqual(['store', '--label=dsh: ref:K', 'service', 'dsh', 'account', 'ref:K'])
    expect(store.calls[0]!.stdin).toBe('line1\nline2')
    const clear = fake({})
    await secretServiceBackend('dsh', clear.run).delete('ref:K')
    expect(clear.calls[0]!.args).toEqual(['clear', 'service', 'dsh', 'account', 'ref:K'])
  })

  it('treats exit 1 with empty stderr as missing and any diagnostic as a failure', async () => {
    expect(await secretServiceBackend('dsh', fake({ code: 1 }).run).get('a')).toBeUndefined()
    await secretServiceBackend('dsh', fake({ code: 1 }).run).delete('a')
    await expect(secretServiceBackend('dsh', fake({ code: 1, stderr: 'no dbus' }).run).get('a')).rejects.toThrow('no dbus')
    await expect(secretServiceBackend('dsh', fake({ code: 1, stderr: 'no dbus' }).run).delete('a')).rejects.toThrow('no dbus')
    await expect(secretServiceBackend('dsh', fake({ code: 2 }).run).get('a')).rejects.toThrow('secret-tool lookup failed with exit code 2')
    await expect(secretServiceBackend('dsh', fake({ code: 2 }).run).set('a', 'b')).rejects.toThrow('secret-tool store failed')
  })
})

describe('createBackend', () => {
  it('selects by platform and rejects unsupported ones', async () => {
    const { run, calls } = fake({ code: 44 })
    await createBackend('darwin', 'dsh', run).get('a')
    expect(calls[0]!.command).toBe('security')
    await createBackend('linux', 'dsh', fake({ code: 1 }).run).get('a')
    await expect(createBackend('linux', 'dsh', run).get('a')).rejects.toThrow()
    calls.push({ command: 'secret-tool', args: [] })
    expect(calls[1]!.command).toBe('secret-tool')
    expect(() => createBackend('win32', 'dsh', run)).toThrow('platform "win32" has no supported secret store')
  })
})

describe('spawnRunner', () => {
  it('captures output, passes stdin, and reports exit codes', async () => {
    const result = await spawnRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);process.stderr.write("e");process.exitCode=3'], 'in')
    expect(result).toEqual({ code: 3, stdout: 'in', stderr: 'e' })
  })

  it('tolerates a child that never reads stdin', async () => {
    const result = await spawnRunner(process.execPath, ['-e', ''], 'x'.repeat(1 << 20))
    expect(result.code).toBe(0)
  })

  it('rejects when the executable is missing', async () => {
    await expect(spawnRunner('dsh-no-such-command', [])).rejects.toThrow()
  })
})
