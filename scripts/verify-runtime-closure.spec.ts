import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCordisYaml } from './cordis-yaml.ts'
import { collectRuntimeClosure, verifyRuntimeClosure } from './verify-runtime-closure.ts'

const roots: string[] = []

function fixture(files: Record<string, string | Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-closure-'))
  roots.push(root)
  for (const [relative, value] of Object.entries({
    'package.json': { name: 'fixture-root' },
    'pnpm-workspace.yaml': 'packages: ["packages/*/*", "apps/*", "native/system", "native/system/packages/*", "python/sdk-runtime", "!packages/core/excluded"]\n',
    ...files,
  })) {
    const preset = /^preset:(.+)$/.exec(relative)
    const path = join(root, preset === null ? relative : `packages/bundle/web-app/presets/${preset[1]}.patch.yml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, preset === null ? (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`) : JSON.stringify([{ insert: [{ name: '@deepseek-ai/dsh-agent-preset', config: { id: preset[1], plugins: typeof value === 'string' ? loadCordisYaml(value) : value } }] }]))
  }
  return root
}

const platforms = {
  'linux-x64': { tag: 'manylinux_2_28_x86_64', executable: 'runtime-linux-x64' },
  'linux-arm64': { tag: 'manylinux_2_28_aarch64', executable: 'runtime-linux-arm64' },
  'macos-arm64': { tag: 'macosx_14_0_arm64', executable: 'runtime-macos-arm64' },
  'macos-x64': { tag: 'macosx_14_0_x86_64', executable: 'runtime-macos-x64' },
  'win-x64': { tag: 'win_amd64', executable: 'runtime-win-x64.exe' },
}

function workspace(root: string, name: string, manifest: Record<string, unknown>): void {
  const packageName = name.replace('@scope/', '')
  const path = join(root, 'packages/core', packageName, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyRuntimeClosure', () => {
  it('follows declared apps, native children and root optionals once, excluding dev and excluded members', async () => {
    const root = fixture({
      'apps/carrier/package.json': { name: 'carrier', dependencies: { cli: 'workspace:*' }, optionalDependencies: { native: 'workspace:*' }, devDependencies: { dev: 'workspace:*' } },
      'apps/cli/package.json': { name: 'cli', dependencies: { leaf: 'workspace:*', excluded: 'workspace:*' } },
      'packages/core/leaf/package.json': { name: 'leaf', dependencies: { cli: 'workspace:*' } },
      'native/system/package.json': { name: 'native', optionalDependencies: { platform: 'workspace:*' } },
      'native/system/packages/platform/package.json': { name: 'platform' },
      'packages/core/dev/package.json': { name: 'dev' },
      'packages/core/excluded/package.json': { name: 'excluded' },
    })
    expect(await verifyRuntimeClosure(root, 'apps/carrier/package.json', false)).toEqual({
      failures: [], presetCount: 0, workspacePackageCount: 4,
      workspacePackages: [
        { name: 'cli', manifestPath: 'apps/cli/package.json' },
        { name: 'leaf', manifestPath: 'packages/core/leaf/package.json' },
        { name: 'native', manifestPath: 'native/system/package.json' },
        { name: 'platform', manifestPath: 'native/system/packages/platform/package.json' },
      ],
    })
  })

  it('reports membership without claiming root-direct peers are supplied', async () => {
    const root = fixture({
      'apps/carrier/package.json': { name: 'carrier', dependencies: { '@scope/child': 'workspace:*' } },
    })
    workspace(root, '@scope/child', { dependencies: { '@scope/peer': 'workspace:*' }, peerDependencies: { '@scope/peer': 'workspace:*' } })
    workspace(root, '@scope/peer', {})
    expect(await collectRuntimeClosure(root, 'apps/carrier/package.json')).toEqual({
      workspacePackages: [
        { name: '@scope/child', manifestPath: 'packages/core/child/package.json' },
        { name: '@scope/peer', manifestPath: 'packages/core/peer/package.json' },
      ],
      requiredWorkspacePeers: [{ name: '@scope/peer', chain: 'carrier -> @scope/child -> @scope/peer' }],
    })
    expect((await verifyRuntimeClosure(root, 'apps/carrier/package.json', false)).failures)
      .toEqual(['carrier -> @scope/child -> @scope/peer'])
  })

  it('counts optional root members without satisfying required deployment dependencies', async () => {
    const manifestPath = 'python/sdk-runtime/package.json'
    const root = fixture({
      [manifestPath]: {
        name: 'runtime', dependencies: { '@scope/child': 'workspace:*' },
        optionalDependencies: { '@scope/peer': 'workspace:*' },
      },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': "- name: '@scope/peer'",
    })
    workspace(root, '@scope/child', { peerDependencies: { '@scope/peer': 'workspace:*' } })
    workspace(root, '@scope/peer', {})
    const result = await verifyRuntimeClosure(root, manifestPath)
    expect(result.workspacePackages.map(member => member.name)).toEqual(['@scope/child', '@scope/peer'])
    expect(result.failures).toEqual([
      'standard preset -> @scope/peer (linux-arm64, linux-x64, macos-arm64, macos-x64, win-x64)',
      'runtime -> @scope/child -> @scope/peer',
    ])
  })

  it('keeps launcher opt-ins in membership and checks peers reached by a required path', async () => {
    const cli = '@deepseek-ai/dsh'
    const bundle = '@deepseek-ai/dsh-experimental-forge-bundle'
    const manifestPath = 'python/sdk-runtime/package.json'
    const root = fixture({
      [manifestPath]: { name: 'runtime', dependencies: { [cli]: 'workspace:*' } },
      'apps/cli/package.json': { name: cli, dependencies: { [bundle]: 'workspace:*' } },
      'packages/experimental/forge-bundle/package.json': { name: bundle, peerDependencies: { '@scope/peer': 'workspace:*' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `- name: '${cli}'`,
    })
    workspace(root, '@scope/peer', {})

    expect((await collectRuntimeClosure(root, manifestPath)).workspacePackages.map(member => member.name))
      .toEqual([cli, bundle])
    expect((await verifyRuntimeClosure(root, manifestPath)).failures).toEqual([])

    workspace(root, '@scope/required', { dependencies: { [bundle]: 'workspace:*' } })
    writeFileSync(join(root, manifestPath), JSON.stringify({
      name: 'runtime', dependencies: { [cli]: 'workspace:*', '@scope/required': 'workspace:*' },
    }))
    expect((await verifyRuntimeClosure(root, manifestPath)).failures)
      .toEqual([`runtime -> @scope/required -> ${bundle} -> @scope/peer`])
  })

  it('checks a private worker closure without requiring application presets', async () => {
    const manifestPath = 'packages/ssh/ssh-helper-runtime/package.json'
    const root = fixture({ [manifestPath]: { name: 'helper', dependencies: { '@scope/worker': 'workspace:^' } } })
    workspace(root, '@scope/worker', { peerDependencies: { '@scope/peer': 'workspace:^' } })
    workspace(root, '@scope/peer', {})
    expect((await verifyRuntimeClosure(root, manifestPath, false)).failures).toEqual(['helper -> @scope/worker -> @scope/peer'])
    writeFileSync(join(root, manifestPath), JSON.stringify({ name: 'helper', dependencies: { '@scope/worker': 'workspace:^', '@scope/peer': 'workspace:^' } }))
    expect(await verifyRuntimeClosure(root, manifestPath, false)).toMatchObject({ failures: [], presetCount: 0 })
  })

  it('requires only plugins active for each published target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/shared': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: tools
  name: cordis:group
  group: true
  config:
    - id: shared
      name: '@scope/shared'
    - id: linux
      name: '@scope/linux'
      disabled: !!js process.platform !== 'linux'
    - id: macos
      name: '@scope/macos'
      disabled: !!js process.platform !== 'darwin'
    - id: windows
      name: '@scope/windows'
      disabled: !!js process.platform !== 'win32'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(1)
    expect(result.failures).toEqual([
      'standard preset -> @scope/linux (linux-arm64, linux-x64)',
      'standard preset -> @scope/macos (macos-arm64, macos-x64)',
      'standard preset -> @scope/windows (win-x64)',
    ])
  })

  it('treats an unsupported disabled expression as active on every target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: conditional
  name: '@scope/conditional'
  disabled: !!js process.env.DSH_DISABLE_CONDITIONAL === '1'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/conditional (linux-arm64, linux-x64, macos-arm64, macos-x64, win-x64)',
    ])
  })

  it('does not interpret an ordinary plugin array config as nested Loader entries', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: plugin
  name: '@scope/plugin'
  config:
    - name: '@scope/config-value'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([])
  })

  it('requires preset plugins to be linked from the workspace', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': '1.2.3' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:standard': `
- id: plugin
  name: '@scope/plugin'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/plugin [runtime dependency is "1.2.3"; expected workspace:] (linux-arm64, linux-x64, macos-arm64, macos-x64, win-x64)',
    ])
  })

  it('fails when no shipped preset is discovered', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': platforms,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(0)
    expect(result.failures).toEqual([
      'no agent presets matched packages/bundle/web-app/presets/*.patch.yml',
    ])
  })

  it('fails when the runtime platform manifest has no targets', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': {},
      'preset:standard': '[]\n',
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'python/sdk-runtime/platforms.json defines no runtime targets',
    ])
  })

  it('retains the required workspace-peer closure check', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/root': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'preset:minimal': '[]\n',
    })
    workspace(root, '@scope/root', {
      peerDependencies: { '@scope/required': 'workspace:^', '@scope/optional': 'workspace:^' },
      peerDependenciesMeta: { '@scope/optional': { optional: true } },
    })
    workspace(root, '@scope/required', {})
    workspace(root, '@scope/optional', {})

    const result = await verifyRuntimeClosure(root)

    expect(result.workspacePackageCount).toBe(1)
    expect(result.failures).toEqual(['runtime -> @scope/root -> @scope/required'])
  })
})
