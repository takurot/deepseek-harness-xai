/** Exercise credential persistence while replacing only the external OS command transport. */
import assert from 'node:assert/strict'
import { open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { isDeepStrictEqual } from 'node:util'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider, KeychainStorageLimitError, macosBackend } from '@deepseek-ai/dsh-credentials-keychain'

export const name = 'keychain-long-grant-fixture'

class FixtureKeychain extends KeychainCredentialProvider {
  lockDirectory() {
    return join(process.cwd(), '.dsh', 'keychain-fixture-locks')
  }
  failNextIndexWrite = false

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
          if (this.failNextIndexWrite && request.account === 'v2:index') {
            this.failNextIndexWrite = false
            return result(0, '{"status":-25293}')
          }
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
  const notifications = []
  ctx.on('credentials/record-updated', key => { notifications.push(key) })
  let initialized = false
  ctx.on('agent/pre-step', async (_event, next) => {
    if (!initialized) {
      const key = credentialKey('snapshot', 'long-grant')
      const record = { kind: 'grant', payload: { token: '日本語 "quoted"\n'.repeat(1024) + '  ' } }
      const storedBytes = Buffer.byteLength(JSON.stringify(record))
      assert.ok(storedBytes > 4096)
      const provider = ctx.get('credentials')
      assert.ok(provider instanceof FixtureKeychain)
      provider.failNextIndexWrite = true
      await assert.rejects(provider.modifyRecord(key, async () => record), { code: 'KEYCHAIN_COMMIT_UNKNOWN', outcome: 'unknown' })
      assert.deepEqual(notifications, [])
      const pending = JSON.parse(await readFile(join(process.cwd(), '.dsh', 'keychain-fixture-items.json'), 'utf8'))
      assert.ok(Object.hasOwn(pending, 'v2:record-transaction-v1'))
      assert.equal(Object.hasOwn(pending, 'v2:index'), false)
      assert.deepEqual(JSON.parse(Buffer.from(pending[`v2:record:${key}`], 'base64').toString('utf8')), record)
      await active.dispose()
      active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
      await active
      const reloaded = ctx.get('credentials')
      assert.ok(reloaded)
      assert.deepEqual(notifications, [key])
      assert.deepEqual(await reloaded.readRecord(key), record)
      assert.deepEqual(await reloaded.listRecords(), [{ key, kind: 'grant' }])
      const repaired = JSON.parse(await readFile(join(process.cwd(), '.dsh', 'keychain-fixture-items.json'), 'utf8'))
      assert.equal(Object.hasOwn(repaired, 'v2:record-transaction-v1'), false)
      const peerContext = new Context()
      const peer = peerContext.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
      ctx.effect(() => () => peer.dispose())
      await peer
      const contender = peerContext.get('credentials')
      assert.ok(contender)
      const firstKey = credentialKey('snapshot', 'first-writer')
      const secondKey = credentialKey('snapshot', 'second-writer')
      const firstRecord = { kind: 'api-key', key: 'first-synthetic-key' }
      const secondRecord = { kind: 'api-key', key: 'second-synthetic-key' }
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const first = reloaded.modifyRecord(firstKey, async () => {
        entered.resolve()
        await release.promise
        return firstRecord
      })
      const ready = Promise.race([entered.promise, first.then(() => { throw new Error('mutation completed before its barrier') })])
      let second
      try {
        await ready
        const directory = join(process.cwd(), '.dsh', 'keychain-fixture-locks')
        const files = await readdir(directory)
        assert.equal(files.length, 1)
        assert.ok(files[0].endsWith('.lock'))
        const observer = await open(join(directory, files[0]), 'r+')
        try {
          await assert.rejects(tryLockExclusive(observer.fd), error => error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
        } finally {
          await observer.close()
        }
        second = contender.modifyRecord(secondKey, async () => secondRecord)
      } finally {
        release.resolve()
        const outcomes = await Promise.allSettled([first, second])
        await peer.dispose()
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
      }
      await active.dispose()
      active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
      await active
      const completed = ctx.get('credentials')
      assert.ok(completed)
      assert.deepEqual(await completed.readRecord(key), record)
      assert.deepEqual(await completed.readRecord(firstKey), firstRecord)
      assert.deepEqual(await completed.readRecord(secondKey), secondRecord)
      assert.deepEqual(await completed.listRecords(), [{ key, kind: 'grant' }, { key: firstKey, kind: 'api-key' }, { key: secondKey, kind: 'api-key' }])
      const store = join(process.cwd(), '.dsh', 'keychain-fixture-items.json')
      const beforeInvalid = await readFile(store, 'utf8')
      const notificationBaseline = [...notifications]
      const expectedEntries = await completed.listRecords()
      const assertPreserved = async () => {
        assert.equal(await readFile(store, 'utf8'), beforeInvalid)
        assert.deepEqual(await completed.readRecord(key), record)
        assert.deepEqual(await completed.listRecords(), expectedEntries)
        assert.deepEqual(notifications, notificationBaseline)
      }
      for (const payload of [NaN, { nested: undefined }, -0]) {
        await assert.rejects(completed.modifyRecord(key, async () => ({ kind: 'grant', payload })), TypeError)
        await assertPreserved()
      }
      await assert.rejects(completed.modifyRecord(key, async current => {
        assert.ok(current)
        assert.equal(current.kind, 'grant')
        current.payload.token = 'mutated callback copy'
        return { kind: 'grant', payload: { nested: undefined } }
      }), TypeError)
      await assertPreserved()
      const declined = await completed.modifyRecord(key, async current => {
        assert.ok(current)
        assert.equal(current.kind, 'grant')
        current.payload.token = 'declined callback copy'
        return undefined
      })
      assert.deepEqual(declined, record)
      await assertPreserved()
      const reference = credentialRef('SNAPSHOT_BOUNDED_KEY')
      const originalReference = { value: 'short-reference', source: 'keychain' }
      await completed.set(reference, originalReference.value)
      const originalItems = await readFile(store, 'utf8')
      const budgetNotifications = []
      const stopReference = ctx.on('credentials/reference-updated', () => { budgetNotifications.push('reference') })
      const stopRecord = ctx.on('credentials/record-updated', () => { budgetNotifications.push('record') })
      const unchangedStorageLimit = (error) => {
        assert.ok(error instanceof KeychainStorageLimitError)
        assert.equal(error.code, 'KEYCHAIN_STORAGE_LIMIT')
        assert.equal(error.outcome, 'unchanged')
        assert.equal(error.reason, 'read-budget')
        return true
      }
      const assertBudgetPreserved = async () => {
        assert.equal(await readFile(store, 'utf8') === originalItems, true)
        assert.deepEqual(await completed.resolve(reference), originalReference)
        assert.ok(isDeepStrictEqual(await completed.readRecord(key), record))
        assert.deepEqual(await completed.listRecords(), expectedEntries)
        assert.deepEqual(budgetNotifications, [])
      }
      try {
        const oversized = 'x'.repeat(65536)
        await assert.rejects(completed.set(reference, oversized), unchangedStorageLimit)
        await assertBudgetPreserved()
        await assert.rejects(completed.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: oversized } })), unchangedStorageLimit)
        await assertBudgetPreserved()
      } finally {
        stopReference()
        stopRecord()
      }
      await active.dispose()
      active = ctx.plugin(FixtureKeychain, { service: 'snapshot-long-grant', commandOutputLimitBytes: 65536 })
      await active
      const finalProvider = ctx.get('credentials')
      assert.ok(finalProvider)
      assert.deepEqual(await finalProvider.resolve(reference), originalReference)
      assert.deepEqual(await finalProvider.readRecord(key), record)
      assert.deepEqual(await finalProvider.readRecord(firstKey), firstRecord)
      assert.deepEqual(await finalProvider.readRecord(secondKey), secondRecord)
      assert.deepEqual(await finalProvider.listRecords(), expectedEntries)
      await writeFile('keychain-result.json', JSON.stringify({ storedBytes, roundTrip: true, reloaded: true, listed: true, unknownOutcome: true, recovered: true, serialized: true, allListed: true, invalidRejected: true, invalidPreserved: true, refused: true, preserved: true }) + '\n')
      initialized = true
    }
    return next()
  })
}
