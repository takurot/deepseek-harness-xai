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

function macStore() {
  const items = new Map<string, string>()
  const calls: Call[] = []
  const run: KeychainCommandRunner = async (command, args, stdin) => {
    calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) })
    const result = (code: number, stdout = '') => ({ code, stdout, stderr: '' })
    if (command === '/usr/bin/osascript') {
      const request = JSON.parse(stdin!) as { operation: string; account: string; secret?: string }
      if (request.operation === 'get') return result(0, JSON.stringify(items.has(request.account) ? { status: 0, secret: items.get(request.account) } : { status: -25300 }))
      if (request.operation === 'delete') { items.delete(request.account); return result(0, '{"status":0}') }
      items.set(request.account, request.secret!)
      return result(0, '{"status":0}')
    }
    if (args[0] === 'find-generic-password') return items.has(args[4]!) ? result(0, items.get(args[4]!)) : result(44)
    if (Buffer.byteLength(stdin!) > 4096) return { ...result(1), stderr: 'interactive input exceeds 4096 bytes' }
    items.delete(stdin!.trim().split(' ').at(-1)!)
    return result(0)
  }
  return { run, calls, items }
}

describe('macosBackend', () => {
  it('preserves a legacy item and reads its successor after an update', async () => {
    const store = macStore()
    store.items.set('a', Buffer.from('old').toString('base64'))
    const backend = macosBackend('dsh', store.run)
    expect(await backend.get('a')).toBe('old')
    await backend.set('a', 'new 日本語\n  ')
    expect(await backend.get('a')).toBe('new 日本語\n  ')
    expect(store.items.get('a')).toBe(Buffer.from('old').toString('base64'))
    expect(store.items.has('v2:a')).toBe(true)
    await backend.delete('a')
    expect(await backend.get('a')).toBeUndefined()
    expect(store.items.size).toBe(0)
    await backend.delete('absent')
  })

  it('round-trips a long Unicode value when the interactive client rejects lines over 4096 bytes', async () => {
    const store = macStore()
    const backend = macosBackend('dsh', store.run)
    const secret = '日本語 "quoted"\n'.repeat(4096) + '  '
    await backend.set('record:oauth/test', secret)
    expect(await backend.get('record:oauth/test')).toBe(secret)
    expect(store.calls.every(call => !call.args.join(' ').includes(secret))).toBe(true)
  })

  it('does not fall back to legacy on native permission failures', async () => {
    const { run, calls } = fake({ stdout: '{"status":-25293}' })
    await expect(macosBackend('dsh', run).get('a')).rejects.toThrow('OS command store')
    expect(calls).toHaveLength(1)
    await expect(macosBackend('dsh', run).set('a', 'secret')).rejects.toThrow('OS command store')
  })

  it('rejects malformed helper responses without retaining secret output or parser causes', async () => {
    for (const response of [
      { code: 1, stdout: '{"status":0,"secret":"PRIVATE_VALUE"}' },
      { stdout: 'PRIVATE_VALUE' }, { stdout: 'null' }, { stdout: '{}' },
      { stdout: '{"status":"PRIVATE_VALUE"}' }, { stdout: '{"status":1e100}' },
      { stdout: '{"status":0}' }, { stdout: '{"status":0,"secret":42}' },
      { stdout: '{"status":0,"secret":"PRIVATE_VALUE","extra":true}' },
      { stdout: '{"status":-25300,"secret":"PRIVATE_VALUE"}' },
    ]) {
      const error = await macosBackend('dsh', fake(response).run).get('a').catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain('PRIVATE_VALUE')
      expect((error as Error).cause).toBeUndefined()
    }
    await expect(macosBackend('dsh', fake({ stdout: '{"status":0,"secret":"private"}' }).run).set('a', 'private')).rejects.toThrow('OS command invalid-result')
  })

  it('rejects noncanonical base64 and malformed UTF-8 without falling back', async () => {
    for (const secret of ['!', 'Zg', '====', '/w==', 'YWJj\n']) {
      const { run, calls } = fake({ stdout: JSON.stringify({ status: 0, secret }) })
      await expect(macosBackend('dsh', run).get('a')).rejects.toMatchObject({ reason: 'invalid-result', outcome: 'unknown' })
      expect(calls).toHaveLength(1)
    }
    const value = '\uFEFF日本語\0\n '
    expect(await macosBackend('dsh', fake({ stdout: JSON.stringify({ status: 0, secret: Buffer.from(value).toString('base64') }) }).run).get('a')).toBe(value)
  })

  it('leaves the successor readable when either deletion fails and completes on retry', async () => {
    for (const phase of ['legacy', 'native'] as const) {
      const store = macStore()
      store.items.set('a', Buffer.from('old').toString('base64'))
      store.items.set('v2:a', Buffer.from('new').toString('base64'))
      let failed = false
      const run: KeychainCommandRunner = async (command, args, stdin) => {
        const request = command === '/usr/bin/osascript' ? JSON.parse(stdin!) as { operation: string } : undefined
        if (!failed && (phase === 'legacy' ? command === 'security' && args[0] === '-i' : request?.operation === 'delete')) {
          failed = true
          return phase === 'legacy' ? { code: 2, stdout: '', stderr: 'denied' } : { code: 0, stdout: '{"status":-25293}', stderr: '' }
        }
        return store.run(command, args, stdin)
      }
      const backend = macosBackend('dsh', run)
      await expect(backend.delete('a')).rejects.toThrow()
      expect(await backend.get('a')).toBe('new')
      expect(store.items.has('a')).toBe(phase === 'legacy')
      await backend.delete('a')
      expect(store.items.size).toBe(0)
    }
  })

  it('reports legacy read failures and treats native absence plus legacy exit44 as absent', async () => {
    const run: KeychainCommandRunner = async command => command === '/usr/bin/osascript'
      ? { code: 0, stdout: '{"status":-25300}', stderr: '' }
      : { code: 1, stdout: '', stderr: 'denied' }
    await expect(macosBackend('dsh', run).get('a')).rejects.toThrow('OS command exit')
    expect(await macosBackend('dsh', macStore().run).get('a')).toBeUndefined()
    await macosBackend('dsh', async command => command === '/usr/bin/osascript'
      ? { code: 0, stdout: '{"status":-25300}', stderr: '' } : { code: 44, stdout: '', stderr: '' }).delete('a')
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
    await expect(secretServiceBackend('dsh', fake({ code: 1, stderr: 'no dbus' }).run).get('a')).rejects.toThrow('OS command exit')
    await expect(secretServiceBackend('dsh', fake({ code: 1, stderr: 'no dbus' }).run).delete('a')).rejects.toThrow('OS command exit')
    await expect(secretServiceBackend('dsh', fake({ code: 2 }).run).get('a')).rejects.toThrow('OS command exit (exit 2)')
    await expect(secretServiceBackend('dsh', fake({ code: 2 }).run).set('a', 'b')).rejects.toThrow('OS command exit')
  })
})

describe('createBackend', () => {
  it('selects by platform and rejects unsupported ones', async () => {
    const { run, calls } = macStore()
    await createBackend('darwin', 'dsh', run).get('a')
    expect(calls[0]!.command).toBe('/usr/bin/osascript')
    await createBackend('linux', 'dsh', fake({ code: 1 }).run).get('a')
    await expect(createBackend('linux', 'dsh', run).get('a')).rejects.toThrow()
    const linux = fake({ code: 1 })
    await createBackend('linux', 'dsh', linux.run).get('a')
    expect(linux.calls[0]!.command).toBe('secret-tool')
    expect(() => createBackend('win32', 'dsh', run)).toThrow('platform "win32" has no supported secret store')
  })
})

describe('spawnRunner', () => {
  it('captures output, passes stdin, and reports exit codes', async () => {
    const result = await spawnRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);process.stderr.write("e");process.exitCode=3'], 'in')
    expect(result).toEqual({ code: 3, stdout: '', stderr: '!' })
  })

  it('tolerates a child that never reads stdin', async () => {
    const result = await spawnRunner(process.execPath, ['-e', ''], 'x'.repeat(1 << 20))
    expect(result.code).toBe(0)
  })

  it('rejects when the executable is missing', async () => {
    await expect(spawnRunner('dsh-no-such-command', [])).rejects.toThrow()
  })
})


describe('storage preflight', () => {
  it('includes the entire macOS read JSON, base64 and final newline before any write', async () => {
    const wire = '{"status":0,"secret":"YWJj"}\n'
    const exact = Buffer.byteLength(wire)
    const allowed = fake({ stdout: '{"status":0}\n' })
    await macosBackend('dsh', allowed.run, exact).set('ref:K', 'abc')
    expect(allowed.calls).toHaveLength(1)
    const denied = fake({})
    await expect(macosBackend('dsh', denied.run, exact - 1).set('ref:K', 'abc'))
      .rejects.toMatchObject({ code: 'KEYCHAIN_STORAGE_LIMIT', outcome: 'unchanged', reason: 'read-budget' })
    expect(denied.calls).toHaveLength(0)
  })

  it('accepts exact Linux byte limits and refuses intrinsic overflow before any command', async () => {
    const exact = fake({})
    await secretServiceBackend('dsh', exact.run, 8192).set('ref:K', 'x'.repeat(8192))
    expect(exact.calls).toHaveLength(1)
    const denied = fake({})
    await expect(secretServiceBackend('dsh', denied.run, 16384).set('ref:K', 'x'.repeat(8193)))
      .rejects.toMatchObject({ reason: 'platform-input', outcome: 'unchanged' })
    await expect(secretServiceBackend('dsh', denied.run, 3).set('ref:K', '日本語'))
      .rejects.toMatchObject({ reason: 'read-budget', outcome: 'unchanged' })
    expect(denied.calls).toHaveLength(0)
    expect(() =>{  secretServiceBackend('dsh', denied.run).assertCanStore('embedded\0日本語') }).not.toThrow()
  })
})
