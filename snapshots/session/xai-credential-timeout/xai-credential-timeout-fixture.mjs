/** Stalled external secret-store read through the real keychain credential provider. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeychainCredentialProvider } from '@deepseek-ai/dsh-credentials-keychain'

/** Cordis plugin name. */
export const name = 'xai-credential-timeout-fixture'
/** The fixture gates the external read at the actual tool execution. */
export const inject = ['tools']

/** Install a private external-store fixture without changing credential resolution or xAI search. */
export async function apply(ctx) {
  const environment = ctx.get('launchEnvironment')
  if (environment === undefined) throw new Error('xai-credential-timeout-fixture: dsh launch environment is required')
  if (environment.get('DSH_SNAPSHOT_HANG_KEY') !== undefined) {
    throw new Error('xai-credential-timeout-fixture: credential reference must be absent from the launch environment')
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-credential-snapshot-'))
  let reading = false
  const pending = []
  let requests = 0
  const originalFetch = globalThis.fetch
  const fixtureFetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://xai-credential-snapshot.invalid/')) {
      requests++
      throw new Error('xai-credential-timeout-fixture: HTTP dispatched after credential timeout')
    }
    return originalFetch(input, init)
  }
  await ctx.effect(() => {
    globalThis.fetch = fixtureFetch
    return async () => {
      for (const resolve of pending.splice(0)) resolve(undefined)
      if (globalThis.fetch !== fixtureFetch) throw new Error('xai-credential-timeout-fixture: fetch ownership changed')
      globalThis.fetch = originalFetch
      await rm(directory, { recursive: true, force: true })
    }
  })
  class FixtureCredentials extends KeychainCredentialProvider {
    createBackend() {
      return {
        assertCanStore() { throw new Error('unexpected store write') },
        get: (account) => {
          if (account !== 'ref:DSH_SNAPSHOT_HANG_KEY') return Promise.resolve(undefined)
          return reading ? new Promise(resolve => pending.push(resolve)) : Promise.resolve('snapshot-key')
        },
        set() { throw new Error('unexpected store write') },
        delete() { throw new Error('unexpected store delete') },
      }
    }
    lockDirectory() { return directory }
  }
  await ctx.plugin(FixtureCredentials, { service: 'dsh-credential-snapshot' })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_search') return next()
    reading = true
    try { return await next() }
    finally {
      reading = false
      const reads = pending.splice(0)
      for (const resolve of reads) resolve(undefined)
      if (reads.length !== 1 || requests !== 0) {
        throw new Error(`xai-credential-timeout-fixture: expected one abandoned credential read and no HTTP request, received ${String(reads.length)} reads and ${String(requests)} requests`)
      }
    }
  })
}
