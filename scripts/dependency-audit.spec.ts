import { describe, expect, it } from 'vitest'
import { captureAuditProcess, classifyDependencyAudit } from './dependency-audit.ts'

const importer = 'packages/experimental/subagent-oar'
const locator = '@earendil-works/pi-coding-agent@1.3.0(peer@2.0.0)'
const audit = {
  advisories: {
    '1164999': {
      id: 1164999, github_advisory_id: 'GHSA-g3hv-75wg-m249', module_name: 'minimatch',
      title: 'Pattern optimization', severity: 'high', vulnerable_versions: '<11.0.1', patched_versions: '>=11.0.1',
      findings: [{
        version: '10.2.6', paths: ['packages__experimental__subagent-oar>@earendil-works/pi-coding-agent>minimatch'],
        dev: false, optional: false, bundled: false,
      }],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    dependencies: 2, devDependencies: 0, optionalDependencies: 0, totalDependencies: 2,
  },
}
const exception = {
  advisory: 'GHSA-g3hv-75wg-m249', package: 'minimatch', version: '10.2.6', importer,
  chain: [{ name: '@earendil-works/pi-coding-agent', version: '1.3.0', locator }, { name: 'minimatch', version: '10.2.6', locator: 'minimatch@10.2.6' }],
  expires: '2026-11-25', trackingIssue: 'https://github.com/takurot/deepseek-harness-xai/issues/40',
  reason: 'Trigger absence inferred from pinned default level 1 callers; source review is recorded separately.',
}
function input() {
  return {
    raw: JSON.stringify(audit), auditExitCode: 1, auditError: null, stderr: '', capturedAt: '2026-11-11T00:00:00.000Z', repositoryCommit: 'fixture',
    importers: [{ dir: importer, name: 'oar' }],
    distributionRoots: [{ manifestPath: 'apps/cli/package.json', verification: 'membership-only' as const, workspacePackages: [{ name: 'oar', manifestPath: `${importer}/package.json` }], failures: [] as string[] }],
    lockfile: {
      lockfileVersion: '9.0',
      importers: { [importer]: { dependencies: { '@earendil-works/pi-coding-agent': { specifier: '1.3.0', version: '1.3.0(peer@2.0.0)' } } } },
      packages: { '@earendil-works/pi-coding-agent@1.3.0': {}, 'minimatch@10.2.6': {} },
      snapshots: { [locator]: { dependencies: { minimatch: '10.2.6' } }, 'minimatch@10.2.6': {} },
    },
    exceptions: { formatVersion: 1, exceptions: [exception] },
  }
}

describe('dependency audit policy', () => {
  it('preserves partial subprocess output and fails an execution error even with complete JSON', () => {
    const captured = captureAuditProcess({ stdout: Buffer.from('{partial'), stderr: 'registry diagnostic', status: null, signal: 'SIGTERM', error: new Error('ENOBUFS') })
    expect(captured).toEqual({ raw: '{partial', stderr: 'registry diagnostic\nENOBUFS\nsignal: SIGTERM', auditExitCode: null, auditError: 'ENOBUFS' })
    expect(classifyDependencyAudit({ ...input(), ...captured }).status).toBe('failed')
    expect(classifyDependencyAudit({ ...input(), auditError: 'ENOBUFS' })).toMatchObject({ status: 'failed', auditError: 'ENOBUFS' })
  })

  it('retains exact identities and matching exception beside the finding', () => {
    expect(classifyDependencyAudit(input())).toMatchObject({
      formatVersion: 1, status: 'passed', auditExitCode: 1,
      counts: { uniqueFindings: 1, byCategory: { 'apps/cli/package.json': 1 }, categoryCountsAreNonAdditive: true },
      findings: [{ advisory: 'GHSA-g3hv-75wg-m249', package: 'minimatch', version: '10.2.6', chains: [{
        importer, identities: exception.chain, categories: ['apps/cli/package.json'], exception: { status: 'matched', trackingIssue: exception.trackingIssue },
      }] }],
    })
  })

  it('accepts only a complete empty result with exit zero', () => {
    const value = input()
    value.raw = JSON.stringify({
      advisories: {}, metadata: { ...audit.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    })
    value.auditExitCode = 0
    expect(classifyDependencyAudit(value)).toMatchObject({ status: 'passed', counts: { uniqueFindings: 0 }, findings: [] })
    value.auditExitCode = 1
    expect(classifyDependencyAudit(value).failures).toContain('audit exit status contradicts findings')
  })

  it.each([
    ['malformed', '{'],
    ['missing metadata', JSON.stringify({ advisories: audit.advisories })],
    ['registry error', JSON.stringify({ ...audit, error: { code: 'ECONNRESET' } })],
    ['contradictory count', JSON.stringify({ ...audit, metadata: { ...audit.metadata, vulnerabilities: { ...audit.metadata.vulnerabilities, high: 0 } } })],
    ['incomplete totals', JSON.stringify({ ...audit, metadata: { vulnerabilities: audit.metadata.vulnerabilities } })],
  ])('fails %s without reporting a clean audit', (_name, raw) => {
    expect(classifyDependencyAudit({ ...input(), raw })).toMatchObject({ status: 'failed', source: null, findings: [], counts: null })
  })

  it('rejects contradictory dependency totals and production records marked development-only', () => {
    const totals = { ...audit, metadata: { ...audit.metadata, totalDependencies: 999 } }
    expect(classifyDependencyAudit({ ...input(), raw: JSON.stringify(totals) }).status).toBe('failed')
    const dev = structuredClone(audit)
    dev.advisories['1164999'].findings[0]!.dev = true
    expect(classifyDependencyAudit({ ...input(), raw: JSON.stringify(dev) }).status).toBe('failed')
  })

  it.each([0, 2, 127])('rejects unexpected status %s while preserving status and stderr', (auditExitCode) => {
    expect(classifyDependencyAudit({ ...input(), auditExitCode, stderr: 'registry diagnostic' })).toMatchObject({ status: 'failed', auditExitCode, stderr: 'registry diagnostic' })
  })

  it('fails the UTC expiry instant and retains the expired finding', () => {
    expect(classifyDependencyAudit({ ...input(), capturedAt: '2026-11-25T00:00:00.000Z' })).toMatchObject({ status: 'failed', findings: [{ chains: [{ exception: { status: 'expired' } }] }] })
  })

  it.each(['parent', 'advisory', 'importer', 'version', 'locator'])('does not broaden an exception when %s changes', (field) => {
    const value = input()
    const changed = structuredClone(exception)
    if (field === 'parent') changed.chain[0]!.version = '1.3.1'
    if (field === 'advisory') changed.advisory = 'GHSA-aaaa-bbbb-cccc'
    if (field === 'importer') changed.importer = 'packages/experimental/other'
    if (field === 'version') changed.version = '10.2.5'
    if (field === 'locator') changed.chain[0]!.locator = '@earendil-works/pi-coding-agent@1.3.0(peer@3.0.0)'
    value.exceptions.exceptions = [changed]
    expect(classifyDependencyAudit(value)).toMatchObject({ status: 'failed', findings: [{ chains: [{ exception: { status: 'unmatched' } }] }] })
  })

  it('rejects a changed locked parent even when the reported advisory path is identical', () => {
    const value = input()
    const changedLocator = '@earendil-works/pi-coding-agent@1.3.1(peer@2.0.0)(patch_hash=fixture)'
    const report = classifyDependencyAudit({
      ...value,
      lockfile: {
        ...value.lockfile,
        importers: { [importer]: { dependencies: { '@earendil-works/pi-coding-agent': {
          specifier: '^1.3.0', version: '1.3.1(peer@2.0.0)(patch_hash=fixture)',
        } } } },
        packages: { '@earendil-works/pi-coding-agent@1.3.1': {}, 'minimatch@10.2.6': {} },
        snapshots: { [changedLocator]: value.lockfile.snapshots[locator], 'minimatch@10.2.6': {} },
      },
    })
    expect(report.status).toBe('failed')
    expect(report.findings[0]?.chains[0]?.identities[0]).toEqual({
      name: '@earendil-works/pi-coding-agent', version: '1.3.1', locator: changedLocator,
    })
    expect(report.findings[0]?.chains[0]?.exception.status).toBe('unmatched')
  })

  it('resolves only a known workspace link and includes the distribution root itself', () => {
    const value = input()
    const raw = structuredClone(audit)
    raw.advisories['1164999'].findings[0]!.paths = ['apps__cli>oar>@earendil-works/pi-coding-agent>minimatch']
    const report = classifyDependencyAudit({
      ...value, raw: JSON.stringify(raw),
      importers: [...value.importers, { dir: 'apps/cli', name: 'cli' }],
      lockfile: { ...value.lockfile, importers: { ...value.lockfile.importers,
        'apps/cli': { dependencies: { oar: { specifier: 'workspace:*', version: 'link:../../packages/experimental/subagent-oar' } } },
      } },
    })
    expect(report.findings[0]?.chains[0]).toMatchObject({ importer: 'apps/cli', categories: ['apps/cli/package.json'], identityFailure: null })
    expect(report.findings[0]?.chains[0]?.identities).toEqual([
      { name: 'oar', version: 'workspace', locator: 'link:packages/experimental/subagent-oar' }, ...exception.chain,
    ])
    expect(report.status).toBe('failed')
  })

  it('rejects ambiguous importer encoding and unsupported alias references', () => {
    const value = input()
    value.importers.push({ dir: 'packages__experimental__subagent-oar', name: 'ambiguous' })
    expect(classifyDependencyAudit(value).findings[0]?.chains[0]?.identityFailure).toBe('unknown or ambiguous importer')
    const alias = input()
    alias.lockfile.importers[importer].dependencies['@earendil-works/pi-coding-agent'].version = 'other@1.3.0'
    expect(classifyDependencyAudit(alias).findings[0]?.chains[0]?.identityFailure)
      .toBe('unresolved package identity @earendil-works/pi-coding-agent@other@1.3.0')
  })

  it('fails unresolved paths and preserves their raw path', () => {
    const value = input()
    value.lockfile.snapshots[locator].dependencies.minimatch = '10.2.5'
    const report = classifyDependencyAudit(value)
    expect(report.status).toBe('failed')
    expect(report.findings[0]?.chains[0]?.identityFailure).toBe('unresolved package identity minimatch@10.2.5')
    expect(report.findings[0]?.chains[0]?.path).toBe('packages__experimental__subagent-oar>@earendil-works/pi-coding-agent>minimatch')
  })

  it('classifies shared runtime and tooling counts without adding them together', () => {
    const value = input()
    value.importers.push({ dir: 'packages/test-support/client-runtime', name: 'tests' })
    const raw = structuredClone(audit)
    raw.advisories['1164999'].findings[0]!.paths.push('packages__test-support__client-runtime>@earendil-works/pi-coding-agent>minimatch')
    const lockfile = { ...value.lockfile, importers: { ...value.lockfile.importers, 'packages/test-support/client-runtime': value.lockfile.importers[importer] } }
    expect(classifyDependencyAudit({ ...value, lockfile, raw: JSON.stringify(raw) })).toMatchObject({
      status: 'failed', counts: { uniqueFindings: 1, byCategory: { 'apps/cli/package.json': 1, 'test-support': 1 } },
    })
  })

  it('keeps nonmember experimental runtimes distinct from test support', () => {
    expect(classifyDependencyAudit({ ...input(), distributionRoots: [] })).toMatchObject({ status: 'passed', counts: { byCategory: { 'experimental-runtime': 1 } } })
  })

  it('rejects unknown importer encoding, missing edges and incompatible leaf versions', () => {
    for (const path of ['unknown>@earendil-works/pi-coding-agent>minimatch', 'packages__experimental__subagent-oar>minimatch', 'packages__experimental__subagent-oar>@earendil-works/pi-coding-agent']) {
      const raw = structuredClone(audit)
      raw.advisories['1164999'].findings[0]!.paths = [path]
      const report = classifyDependencyAudit({ ...input(), raw: JSON.stringify(raw) })
      expect(report.status).toBe('failed')
      expect(typeof report.findings[0]?.chains[0]?.identityFailure).toBe('string')
    }
  })

  it('fails invalid exceptions and closure failures even for valid audit input', () => {
    expect(classifyDependencyAudit({ ...input(), exceptions: { formatVersion: 1, exceptions: [{ ...exception, expires: 'forever' }] } })).toMatchObject({ status: 'failed' })
    const value = input()
    value.distributionRoots[0]!.failures.push('missing required peer')
    expect(classifyDependencyAudit(value).failures).toContain('apps/cli/package.json: missing required peer')
  })
})
