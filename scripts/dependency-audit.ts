/** Classify pnpm production audit findings by shipping dependency membership and exact, expiring exceptions. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { z } from 'zod'
import { readWorkspaceManifests } from './check-workspace-constraints.ts'
import { collectRuntimeClosure, verifyRuntimeClosure } from './verify-runtime-closure.ts'

const text = z.string().min(1)
const count = z.number().int().nonnegative()
const severity = z.enum(['info', 'low', 'moderate', 'high', 'critical'])
const severityCounts = z.object({ info: count, low: count, moderate: count, high: count, critical: count })
const auditSchema = z.object({
  advisories: z.record(z.string(), z.object({
    id: count, github_advisory_id: text, module_name: text, title: text, severity,
    vulnerable_versions: text, patched_versions: text,
    findings: z.array(z.object({
      version: text, paths: z.array(text).min(1), dev: z.boolean(), optional: z.boolean(), bundled: z.boolean(),
    })).min(1),
  })),
  metadata: z.object({
    vulnerabilities: severityCounts, dependencies: count, devDependencies: count, optionalDependencies: count, totalDependencies: count,
  }),
}).loose()
const identitySchema = z.object({ name: text, version: text, locator: text }).strict()
const exceptionSchema = z.object({
  formatVersion: z.literal(1),
  exceptions: z.array(z.object({
    advisory: text, package: text, version: text, importer: text, chain: z.array(identitySchema).min(2),
    expires: z.iso.date(),
    trackingIssue: z.url().regex(/^https:\/\/github\.com\/takurot\/deepseek-harness-xai\/issues\/[1-9]\d*$/), reason: text,
  }).strict()),
}).strict()
const dependencyReference = z.union([text, z.object({ specifier: text, version: text })])
const lockEntry = z.object({
  dependencies: z.record(z.string(), dependencyReference).optional(),
  optionalDependencies: z.record(z.string(), dependencyReference).optional(),
})
const lockSchema = z.object({
  lockfileVersion: z.literal('9.0'),
  importers: z.record(z.string(), lockEntry),
  packages: z.record(z.string(), z.object({})),
  snapshots: z.record(z.string(), lockEntry),
})

type Identity = z.infer<typeof identitySchema>
type Exception = z.infer<typeof exceptionSchema>['exceptions'][number]
type Lockfile = z.infer<typeof lockSchema>
type LockEntry = z.infer<typeof lockEntry>

/** A shipping root and the existing closure verifier's membership and failures. */
export interface AuditDistributionRoot {
  manifestPath: string
  verification: 'membership-only' | 'deploy-root-peers-and-presets'
  workspacePackages: Array<{ name: string; manifestPath: string }>
  failures: string[]
}

/** Captured external inputs and the workspace identities used to interpret pnpm importer paths. */
export interface DependencyAuditInput {
  raw: string
  auditExitCode: number | null
  auditError: string | null
  stderr: string
  capturedAt: string
  repositoryCommit: string
  lockfile: unknown
  exceptions: unknown
  importers: Array<{ dir: string; name: string }>
  distributionRoots: AuditDistributionRoot[]
}

interface AuditChain {
  path: string
  importer: string | null
  importerManifestPath: string | null
  identities: Identity[]
  identityFailure: string | null
  categories: string[]
  exception: { status: 'matched' | 'expired' | 'unmatched' | 'none'; reason?: string; expires?: string; trackingIssue?: string }
}

interface ClassifiedFinding {
  advisory: string
  package: string
  version: string
  severity: z.infer<typeof severity>
  title: string
  affectedRange: string
  fixedRange: string
  chains: AuditChain[]
}

/** A failed input never carries zero-finding counts; valid findings remain visible when policy fails. */
export interface DependencyAuditReport {
  formatVersion: 1
  capturedAt: string
  repositoryCommit: string
  auditExitCode: number | null
  auditError: string | null
  stderr: string
  status: 'passed' | 'failed'
  scope: string
  source: z.infer<typeof auditSchema>['metadata'] | null
  distributionRoots: AuditDistributionRoot[]
  findings: ClassifiedFinding[]
  counts: { uniqueFindings: number; byCategory: Record<string, number>; categoryCountsAreNonAdditive: true } | null
  failures: string[]
}

/**
 * Preserve OS subprocess output, including partial output when spawning or capture fails.
 * @param result Completed pnpm process result; null streams indicate no captured bytes.
 * @returns Raw stdout, diagnostic stderr, exact exit code, and a separately fatal execution error.
 */
export function captureAuditProcess(result: {
  stdout: string | Buffer | null
  stderr: string | Buffer | null
  status: number | null
  signal: string | null
  error?: Error
}): Pick<DependencyAuditInput, 'raw' | 'stderr' | 'auditExitCode' | 'auditError'> {
  return {
    raw: result.stdout?.toString() ?? '',
    stderr: `${result.stderr?.toString() ?? ''}${result.error === undefined ? '' : `\n${result.error.message}`}${result.signal === null ? '' : `\nsignal: ${result.signal}`}`,
    auditExitCode: result.status,
    auditError: result.error?.message ?? null,
  }
}

function resolveChain(path: string, packageName: string, version: string, input: DependencyAuditInput, lock: Lockfile): AuditChain {
  const [encoded, ...names] = path.split('>')
  const matches = input.importers.filter(item => item.dir.replaceAll('/', '__') === encoded)
  const importer = matches.length === 1 ? matches[0]?.dir ?? null : null
  const manifestPath = importer === null ? null : importer === '.' ? 'package.json' : `${importer}/package.json`
  const categories = input.distributionRoots.filter(root => root.manifestPath === manifestPath
    || root.workspacePackages.some(member => member.manifestPath === manifestPath)).map(root => root.manifestPath).sort()
  if (categories.length === 0) categories.push(importer === null ? 'unclassified'
    : importer.startsWith('packages/test-support/') ? 'test-support'
      : importer.startsWith('packages/experimental/') ? 'experimental-runtime' : `other:${importer}`)
  const result: AuditChain = { path, importer, importerManifestPath: manifestPath, identities: [], identityFailure: null, categories, exception: { status: 'none' } }
  const fail = (message: string): AuditChain => ({ ...result, identityFailure: message })
  if (importer === null) return fail('unknown or ambiguous importer')
  const rootEntry = lock.importers[importer]
  if (rootEntry === undefined) return fail('importer is missing from lockfile')
  let entry: LockEntry = rootEntry
  let currentImporter = importer
  for (const name of names) {
    const required = entry.dependencies?.[name]
    const optional: z.infer<typeof dependencyReference> | undefined = entry.optionalDependencies?.[name]
    if (required !== undefined && optional !== undefined && JSON.stringify(required) !== JSON.stringify(optional)) return fail(`ambiguous dependency ${name}`)
    const edge = optional ?? required
    if (edge === undefined) return fail(`missing dependency ${name}`)
    const reference = typeof edge === 'string' ? edge : edge.version
    if (reference.startsWith('link:')) {
      const target = posix.normalize(posix.join(currentImporter, reference.slice(5)))
      const members = input.importers.filter(member => member.dir === target && member.name === name)
      const targetEntry = lock.importers[target]
      if (members.length !== 1 || targetEntry === undefined) return fail(`unresolved workspace link ${name}`)
      result.identities.push({ name, version: 'workspace', locator: `link:${target}` })
      entry = targetEntry
      currentImporter = target
      continue
    }
    const baseVersion = /^(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?)(?:\(|$)/.exec(reference)?.[1]
    const locator = `${name}@${reference}`
    const snapshot = lock.snapshots[locator]
    if (baseVersion === undefined || lock.packages[`${name}@${baseVersion}`] === undefined || snapshot === undefined) {
      return fail(`unresolved package identity ${locator}`)
    }
    result.identities.push({ name, version: baseVersion, locator })
    entry = snapshot
  }
  const leaf = result.identities.at(-1)
  if (leaf?.name !== packageName || leaf.version !== version) return fail('advisory leaf does not match locked package and version')
  return result
}

function matchException(chain: AuditChain, finding: ClassifiedFinding, exceptions: Exception[], capturedAt: string): AuditChain['exception'] {
  const match = exceptions.find(entry => entry.advisory === finding.advisory && entry.package === finding.package
    && entry.version === finding.version && entry.importer === chain.importer
    && entry.chain.length === chain.identities.length && entry.chain.every((identity, index) => {
    const resolved = chain.identities[index]
    return resolved !== undefined && identity.name === resolved.name
      && identity.version === resolved.version && identity.locator === resolved.locator
  }))
  if (match === undefined || chain.identityFailure !== null) return { status: exceptions.length === 0 ? 'none' : 'unmatched' }
  return { status: Date.parse(capturedAt) >= Date.parse(`${match.expires}T00:00:00.000Z`) ? 'expired' : 'matched', reason: match.reason, expires: match.expires, trackingIssue: match.trackingIssue }
}

/**
 * Validate captured pnpm JSON, resolve only reported chains, and apply all-severity policy.
 * @param input Captured audit output, lockfile, workspace closures, exceptions, and clock.
 * @returns A serializable report retaining findings and diagnostics on every policy failure.
 */
export function classifyDependencyAudit(input: DependencyAuditInput): DependencyAuditReport {
  const report: DependencyAuditReport = {
    formatVersion: 1, capturedAt: input.capturedAt, repositoryCommit: input.repositoryCommit,
    auditExitCode: input.auditExitCode, auditError: input.auditError, stderr: input.stderr, status: 'failed',
    scope: 'Resolved production dependency membership, including optional platforms; not exploitability or emitted bundle contents. Category counts are non-additive. Source review and live follow-up Issue state are separate delivery evidence.',
    source: null, distributionRoots: input.distributionRoots, findings: [], counts: null,
    failures: input.distributionRoots.flatMap(root => root.failures.map(failure => `${root.manifestPath}: ${failure}`)),
  }
  if (input.auditError !== null) report.failures.push(`audit execution failed: ${input.auditError}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(input.raw)
  } catch (error) {
    report.failures.push(`invalid audit JSON: ${String(error)}`)
    return report
  }
  const audit = auditSchema.safeParse(parsed)
  if (!audit.success || 'error' in audit.data) {
    report.failures.push('invalid or incomplete pnpm audit response')
    return report
  }
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
  for (const advisory of Object.values(audit.data.advisories)) counts[advisory.severity] += advisory.findings.length
  if (Object.entries(counts).some(([level, value]) => value !== audit.data.metadata.vulnerabilities[level as keyof typeof counts])) {
    report.failures.push('audit severity counts contradict advisory/version findings')
    return report
  }
  const metadata = audit.data.metadata
  if (metadata.totalDependencies !== metadata.dependencies + metadata.devDependencies + metadata.optionalDependencies
    || metadata.devDependencies !== 0
    || Object.values(audit.data.advisories).some(advisory => advisory.findings.some(finding => finding.dev))) {
    report.failures.push('audit dependency metadata contradicts production findings')
    return report
  }
  const hasFindings = Object.keys(audit.data.advisories).length > 0
  if (input.auditExitCode !== (hasFindings ? 1 : 0)) report.failures.push('audit exit status contradicts findings')
  const exceptions = exceptionSchema.safeParse(input.exceptions)
  const lock = lockSchema.safeParse(input.lockfile)
  if (!exceptions.success) report.failures.push('invalid dependency audit exceptions')
  if (!lock.success) report.failures.push('invalid or unsupported pnpm lockfile')
  if (!Number.isFinite(Date.parse(input.capturedAt))) report.failures.push('invalid capture timestamp')
  if (!exceptions.success || !lock.success || !Number.isFinite(Date.parse(input.capturedAt))) return report
  report.source = audit.data.metadata
  const findings = new Map<string, ClassifiedFinding>()
  for (const advisory of Object.values(audit.data.advisories)) {
    for (const item of advisory.findings) {
      const key = `${advisory.github_advisory_id}:${advisory.module_name}:${item.version}`
      let finding = findings.get(key)
      if (finding === undefined) {
        finding = {
          advisory: advisory.github_advisory_id, package: advisory.module_name, version: item.version,
          severity: advisory.severity, title: advisory.title,
          affectedRange: advisory.vulnerable_versions, fixedRange: advisory.patched_versions, chains: [],
        }
        findings.set(key, finding)
      }
      for (const path of item.paths) {
        if (finding.chains.some(chain => chain.path === path)) continue
        const chain = resolveChain(path, finding.package, finding.version, input, lock.data)
        chain.exception = matchException(chain, finding, exceptions.data.exceptions, input.capturedAt)
        finding.chains.push(chain)
        if (chain.identityFailure !== null) report.failures.push(`${key}: ${path}: ${chain.identityFailure}`)
        if (chain.exception.status !== 'matched') report.failures.push(`${key}: ${path}: exception ${chain.exception.status}`)
      }
    }
  }
  report.findings = [...findings.values()].sort((a, b) => `${a.advisory}:${a.package}:${a.version}`.localeCompare(`${b.advisory}:${b.package}:${b.version}`))
  const byCategory: Record<string, number> = {}
  for (const finding of report.findings) {
    finding.chains.sort((a, b) => a.path.localeCompare(b.path))
    for (const category of new Set(finding.chains.flatMap(chain => chain.categories))) {
      byCategory[category] = (byCategory[category] ?? 0) + 1
    }
  }
  report.counts = { uniqueFindings: findings.size, byCategory, categoryCountsAreNonAdditive: true }
  report.status = report.failures.length === 0 ? 'passed' : 'failed'
  return report
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'temp/dependency-audit' } } })
  const output = resolve(root, values.output)
  mkdirSync(output, { recursive: true })
  const capturedAt = new Date().toISOString()
  const audit = spawnSync('pnpm', ['audit', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const captured = captureAuditProcess(audit)
  writeFileSync(resolve(output, 'raw.json'), captured.raw)
  writeFileSync(resolve(output, 'stderr.txt'), captured.stderr)
  writeFileSync(resolve(output, 'status.json'), `${JSON.stringify({ exitCode: audit.status, signal: audit.signal, error: captured.auditError, capturedAt })}\n`)
  let report: DependencyAuditReport
  try {
    const distributionRoots: AuditDistributionRoot[] = []
    for (const manifestPath of ['apps/cli/package.json', 'apps/desktop-host/package.json', 'python/sdk-runtime/package.json']) {
      const { workspacePackages } = await collectRuntimeClosure(root, manifestPath)
      if (manifestPath.startsWith('python/')) {
        const { failures } = await verifyRuntimeClosure(root, manifestPath)
        distributionRoots.push({ manifestPath, verification: 'deploy-root-peers-and-presets', workspacePackages, failures })
      } else {
        distributionRoots.push({ manifestPath, verification: 'membership-only', workspacePackages, failures: [] })
      }
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    if (commit.status !== 0) throw new Error('cannot determine repository commit')
    report = classifyDependencyAudit({
      ...captured, capturedAt, repositoryCommit: commit.stdout.trim(),
      lockfile: load(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')),
      exceptions: JSON.parse(readFileSync(resolve(root, 'scripts/dependency-audit-exceptions.json'), 'utf8')),
      importers: readWorkspaceManifests(root).map(({ dir, manifest }) => {
        if (manifest.name === undefined) throw new Error(`${dir}: workspace name is required for audit classification`)
        return { dir, name: manifest.name }
      }),
      distributionRoots,
    })
  } catch (error) {
    report = { formatVersion: 1, capturedAt, repositoryCommit: 'unavailable', auditExitCode: audit.status, auditError: captured.auditError, stderr: captured.stderr, status: 'failed', scope: 'Audit preparation failed; membership is unverified.', source: null, distributionRoots: [], findings: [], counts: null, failures: [String(error)] }
  }
  writeFileSync(resolve(output, 'classified.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`dependency-audit: ${report.status}; ${report.counts?.uniqueFindings ?? 'unknown'} unique findings; evidence in ${output}`)
  for (const failure of report.failures) console.error(failure)
  process.exitCode = report.status === 'passed' ? 0 : 1
}

if (import.meta.main) await main()
