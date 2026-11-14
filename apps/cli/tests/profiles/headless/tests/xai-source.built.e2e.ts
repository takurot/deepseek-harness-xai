/** Source-path resolution of checkout-only overlays through the production CLI and shipped headless profile. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const overlay = join(repoRoot, 'apps/cli/config/examples/xai.yml')
const tsxImport = import.meta.resolve('tsx/esm')
const fixture = join(repoRoot, 'apps/cli/tests/fixtures/xai-source-model.ts')

interface LaunchOptions {
  key?: string
  invalid?: boolean
  missingPlugin?: boolean
  keychain?: boolean
  model?: boolean
  documented?: boolean
  dump?: boolean
  fetch?: boolean
}

async function launch(options: LaunchOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xai-source-'))
  try {
    await using fetchServer = options.fetch === true ? createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('Fork fetch fixture.')
    }) : undefined
    if (fetchServer !== undefined) {
      await new Promise<void>((resolve, reject) => {
        fetchServer.once('error', reject)
        fetchServer.listen(0, '127.0.0.1', () => {
          fetchServer.off('error', reject)
          resolve()
        })
      })
    }
    const fetchAddress = fetchServer?.address()
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const patch = join(root, 'test.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'xai-fixture', model: 'fixture' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      ...(options.keychain === true ? [{ id: 'credentials-keychain', config: { service: basename(root) } }] : []),
      ...(options.invalid === true ? [{ id: 'web-search-xai', config: { timeoutMs: 0 } }] : []),
      ...(options.invalid === true || options.model === true || options.fetch === true ? [{ id: 'headless-runner', disabled: true }] : []),
      { insert: [{ id: 'xai-source-model', name: fixture, config: { probeProviderMissing: options.invalid === true, verifyModel: options.model === true, verifyCredentials: options.keychain === true, verifyFetch: options.fetch === true } }] },
    ]))
    let selectedOverlay = overlay
    if (options.missingPlugin === true) {
      selectedOverlay = join(root, 'missing.patch.yml')
      await writeFile(selectedOverlay, (await readFile(overlay, 'utf8')).replace(
        '../../../../packages/experimental/web-search-xai/src/index.ts', join(root, 'missing-plugin.ts'),
      ))
    }
    const result = await execa(options.documented === true ? 'pnpm' : process.execPath, [
      ...(options.documented === true ? ['dsh'] : ['--import', tsxImport, join(repoRoot, 'apps/cli/src/bin.ts')]), '--profile', 'headless', '--patch', options.documented === true ? 'apps/cli/config/examples/xai.yml' : selectedOverlay,
      ...(options.keychain === true ? ['--patch', join(repoRoot, 'apps/cli/config/examples/keychain.yml')] : []),
      ...(options.model === true ? ['--patch', join(repoRoot, 'apps/cli/config/examples/xai-model.yml')] : []),
      '--patch', patch,
      ...(options.missingPlugin === true ? ['--dump-config-schema'] : options.dump === true ? ['--dump-config'] : ['Search the web for xAI']),
    ], {
      cwd: options.documented === true ? repoRoot : cwd,
      env: {
        TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'), DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'fixture-deepseek-key', XAI_API_KEY: options.key ?? 'fixture-xai-key',
        DSH_WEB_SEARCH_PROVIDER: '', DSH_XAI_HTTP_TRACE: '1',
        DSH_XAI_FETCH_URL: typeof fetchAddress === 'object' && fetchAddress !== null ? `http://127.0.0.1:${fetchAddress.port}/` : '',
      },
      input: '', timeout: 105_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
    expect(result.signal, `${result.stdout}\n${result.stderr}`).toBeUndefined()
    const paths = await readdir(join(home, 'sessions'), { recursive: true }).catch(() => [])
    const logs = await Promise.all(paths.filter(path => path.endsWith('.jsonl')).map(path => readFile(join(home, 'sessions', path), 'utf8')))
    return { root, result, logs }
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}

describe('fork xAI source overlay', () => {
  it('offers and executes xAI search alongside DeepSeek and persists the result', async () => {
    const run = await launch()
    try {
      const diagnostic = `${run.result.stdout}\n${run.result.stderr}`
      expect(run.result.exitCode, diagnostic).toBe(0)
      expect(run.result.stdout).toContain('XAI_SEARCH_VISIBLE true')
      expect(run.result.stdout).toContain('XAI_FETCH_VISIBLE true')
      expect(run.result.stdout).toContain('XAI_HTTP_REQUEST https://api.x.ai/v1/responses')
      expect(run.result.stdout).toContain('Grok search fixture answer.')
      expect(run.logs).toHaveLength(1)
      const events = parseSessionLog(run.logs[0]!)
      expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['web_search'])
      const results = events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      expect(results[0]!.data.message.isError).toBe(false)
      expect(run.logs[0]).toContain('Grok search fixture answer.')
      expect(run.logs[0]).toContain('https://x.ai/grok')
      expect(run.logs[0]).toContain('"type":"tool/result"')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('runs the documented pnpm dsh source command from the fork root', async () => {
    const run = await launch({ documented: true })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stdout).toContain('Grok search fixture answer.')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('retains the HTTP fetch route alongside keyed search providers', async () => {
    const run = await launch({ fetch: true })
    try {
      expect(run.result.exitCode, `${run.result.stdout}\n${run.result.stderr}`).toBe(0)
      expect(run.result.stdout).toContain('XAI_FETCH_RESULT Fork fetch fixture.')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('disables the local credentials row and inserts one active keychain row', async () => {
    const run = await launch({ keychain: true, dump: true })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stdout.match(/^\s*- id: credentials$/gm)).toHaveLength(1)
      expect(run.result.stdout).toContain('credentials-keychain/src/index.ts')
      expect(run.result.stdout).toMatch(/id: credentials\n\s+name: '@deepseek-ai\/dsh-credentials-local'\n\s+disabled: true/)
      expect(run.result.stdout.match(/^\s*- id: credentials-keychain$/gm)).toHaveLength(1)
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('withholds search without the selected provider key despite an available DeepSeek key', async () => {
    const run = await launch({ key: '' })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stdout).toContain('XAI_SEARCH_VISIBLE false')
      expect(run.result.stdout).not.toContain('XAI_HTTP_REQUEST')
      expect(run.logs.join('')).not.toContain('"type":"tool/call"')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('rejects an unresolvable source plugin in schema inspection', async () => {
    const run = await launch({ missingPlugin: true })
    try {
      expect(run.result.exitCode, `${run.result.stdout}\n${run.result.stderr}`).toBe(1)
      expect(run.result.stderr).toContain('missing-plugin.ts')
      expect(run.result.stdout).not.toContain('XAI_HTTP_REQUEST')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })
  it('reports invalid optional Config without registering usable xAI search', async () => {
    const run = await launch({ invalid: true })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stderr).toContain('web-search-xai')
      expect(run.result.stderr).toContain('timeoutMs')
      expect(run.result.stdout).toContain('XAI_REGISTERED_PROVIDERS ["deepseek-official","deepseek-search-api"]')
      expect(run.result.stdout).not.toContain('XAI_HTTP_REQUEST')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it('loads the optional pi-ai xAI conversation route and catalog model', async () => {
    const run = await launch({ model: true })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stdout).toContain('XAI_MODEL xai/grok-4')
      expect(run.result.stdout).toContain('XAI_REGISTERED_PROVIDERS ["deepseek-official","deepseek-search-api","xai"]')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  it.skipIf(process.platform !== 'darwin')('loads the keychain opt-in on macOS without duplicate credentials registration', async () => {
    const run = await launch({ keychain: true })
    try {
      expect(run.result.exitCode, run.result.stderr).toBe(0)
      expect(run.result.stdout).toContain('Grok search fixture answer.')
      expect(run.result.stdout).toContain('XAI_CREDENTIALS_PROVIDER KeychainCredentialProvider')
      expect(run.result.stderr).not.toContain('already registered')
    } finally { await rm(run.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })
})
