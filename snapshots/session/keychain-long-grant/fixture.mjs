/** Exercise credential persistence while replacing only the external OS command transport. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider, macosBackend } from '@deepseek-ai/dsh-credentials-keychain'

export const name = 'keychain-long-grant-fixture'

class FixtureKeychain extends KeychainCredentialProvider {
  createBackend(service) {
    const filename = join(process.cwd(), '.dsh', 'keychain-fixture-items.json')
    const result = (code, stdout = '') => ({ code, stdout, stderr: '' })
    const load = async () => {
      try {
        return JSON.parse(await readFile(filename, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return {}
        throw error
      }
    }
    const run = async (command, args, stdin) => {
      const items = await load()
      if (command === '/usr/bin/osascript') {
        assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e'])
        const request = JSON.parse(stdin)
        assert.equal(request.service, service)
        assert.equal(typeof request.account, 'string')
        assert.equal(typeof request.secret, 'string')
        assert.equal(args.join(' ').includes(request.secret), false)
        items[request.account] = request.secret
        await writeFile(filename, JSON.stringify(items))
        return result(0, '0\n')
      }
      assert.equal(command, 'security')
      if (args[0] === 'find-generic-password') {
        assert.deepEqual(args, ['find-generic-password', '-s', service, '-a', args[4], '-w'])
        return Object.hasOwn(items, args[4]) ? result(0, `${items[args[4]]}\n`) : result(44)
      }
      assert.deepEqual(args, ['-i'])
      if (Buffer.byteLength(stdin) > 4096) return { ...result(1), stderr: 'interactive input exceeds 4096 bytes' }
      const words = stdin.trim().split(' ')
      assert.equal(words[words.indexOf('-s') + 1], service)
      const account = words[words.indexOf('-a') + 1]
      if (words[0] === 'add-generic-password') items[account] = words[words.indexOf('-w') + 1]
      else {
        assert.equal(words[0], 'delete-generic-password')
        delete items[account]
      }
      await writeFile(filename, JSON.stringify(items))
      return result(0)
    }
    return macosBackend(service, run)
  }
}

/** Verify reloaded durable state before exposing a nonsecret receipt to the model. */
export async function apply(ctx) {
  let active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant' })
  await active
  let initialized = false
  ctx.on('agent/pre-step', async (_event, next) => {
    if (!initialized) {
      const key = credentialKey('snapshot', 'long-grant')
      const record = { kind: 'grant', payload: { token: '日本語 "quoted"\n'.repeat(1024) + '  ' } }
      const storedBytes = Buffer.byteLength(JSON.stringify(record))
      assert.ok(storedBytes > 4096)
      const provider = ctx.get('credentials')
      assert.ok(provider)
      await provider.modifyRecord(key, async () => record)
      await active.dispose()
      active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant' })
      await active
      const reloaded = ctx.get('credentials')
      assert.ok(reloaded)
      assert.deepEqual(await reloaded.readRecord(key), record)
      assert.deepEqual(await reloaded.listRecords(), [{ key, kind: 'grant' }])
      await writeFile('keychain-result.json', JSON.stringify({ storedBytes, roundTrip: true, reloaded: true, listed: true }) + '\n')
      initialized = true
    }
    return next()
  })
}
