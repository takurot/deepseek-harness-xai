/** Exercise credential persistence while replacing only the external OS command transport. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider, KeychainStorageLimitError, macosBackend } from '@deepseek-ai/dsh-credentials-keychain'

export const name = 'keychain-long-grant-fixture'

class FixtureKeychain extends KeychainCredentialProvider {
  lockDirectory() {
    return join(process.cwd(), '.dsh', 'keychain-fixture-locks')
  }

  createBackend(service, _run, outputLimitBytes) {
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
        if (request.operation === 'get') {
          return result(0, JSON.stringify(Object.hasOwn(items, request.account) ? { status: 0, secret: items[request.account] } : { status: -25300 }))
        }
        if (request.operation === 'delete') delete items[request.account]
        else {
          assert.equal(request.operation, 'set')
          assert.equal(typeof request.secret, 'string')
          assert.equal(args.join(' ').includes(request.secret), false)
          items[request.account] = request.secret
        }
        await writeFile(filename, JSON.stringify(items))
        return result(0, '{"status":0}')
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
    return macosBackend(service, run, outputLimitBytes)
  }
}

/** Verify reloaded durable state before exposing a nonsecret receipt to the model. */
export async function apply(ctx) {
  let active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
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
      const reference = credentialRef('SNAPSHOT_BOUNDED_KEY')
      const originalReference = { value: 'short-reference', source: 'keychain' }
      await provider.set(reference, originalReference.value)
      await provider.modifyRecord(key, async () => record)
      const filename = join(process.cwd(), '.dsh', 'keychain-fixture-items.json')
      const originalItems = await readFile(filename, 'utf8')
      const notifications = []
      const stopReference = ctx.on('credentials/reference-updated', () => { notifications.push('reference') })
      const stopRecord = ctx.on('credentials/record-updated', () => { notifications.push('record') })
      const unchangedStorageLimit = (error) => {
        assert.ok(error instanceof KeychainStorageLimitError)
        assert.equal(error.code, 'KEYCHAIN_STORAGE_LIMIT')
        assert.equal(error.outcome, 'unchanged')
        assert.equal(error.reason, 'read-budget')
        return true
      }
      const assertPreserved = async () => {
        assert.equal(await readFile(filename, 'utf8') === originalItems, true)
        assert.deepEqual(await provider.resolve(reference), originalReference)
        assert.ok(isDeepStrictEqual(await provider.readRecord(key), record))
        assert.deepEqual(await provider.listRecords(), [{ key, kind: 'grant' }])
        assert.deepEqual(notifications, [])
      }
      try {
        const oversized = 'x'.repeat(65536)
        await assert.rejects(provider.set(reference, oversized), unchangedStorageLimit)
        await assertPreserved()
        await assert.rejects(provider.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: oversized } })), unchangedStorageLimit)
        await assertPreserved()
      } finally {
        stopReference()
        stopRecord()
      }
      await active.dispose()
      active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
      await active
      const reloaded = ctx.get('credentials')
      assert.ok(reloaded)
      assert.deepEqual(await reloaded.resolve(reference), originalReference)
      assert.deepEqual(await reloaded.readRecord(key), record)
      assert.deepEqual(await reloaded.listRecords(), [{ key, kind: 'grant' }])
      await writeFile('keychain-result.json', JSON.stringify({ storedBytes, roundTrip: true, reloaded: true, listed: true, refused: true, preserved: true }) + '\n')
      initialized = true
    }
    return next()
  })
}
