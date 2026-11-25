/** Windows capability check through the existing restricted-token runner, without Worktree code. */

import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))

const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [workspace, outside] = process.argv.slice(2);
const file = path.join(workspace, 'created.txt');
const fileLink = path.join(workspace, 'file-link');
const dirLink = path.join(workspace, 'directory-link');
function stage(name, run) {
  try {
    run();
    console.error(name + ': ok');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown';
    console.error(name + ': failed (' + code + ')');
    throw error;
  }
}
try {
  stage('file-create', () => fs.writeFileSync(file, 'created in workspace', { flag: 'wx' }));
  stage('file-link', () => fs.symlinkSync(file, fileLink, 'file'));
  stage('file-link-read', () => assert.equal(fs.readFileSync(fileLink, 'utf8'), 'created in workspace'));
  if (outside !== 'ordinary') {
    stage('directory-link', () => fs.symlinkSync(outside, dirLink, 'dir'));
    const viaLink = path.join(dirLink, 'outside.txt');
    stage('outside-read', () => assert.equal(fs.readFileSync(viaLink, 'utf8'), 'outside fixture'));
    stage('outside-write', () => assert.throws(() => fs.writeFileSync(viaLink, 'unexpected write'), error =>
      error.syscall === 'open' && (error.code === 'EACCES' || error.code === 'EPERM')));
    console.log('outside link write denied');
  }
} catch (_error) {
  process.exitCode = 1; // The stage has already reported the error without fixture paths.
}
`

function probeSummary(result: SpawnSyncReturns<string>, stages: readonly string[]): string {
  const observed = new Map<string, string>()
  for (const line of (result.stderr ?? '').split(/\r?\n/u)) {
    const match = /^([a-z-]+): (ok|failed \([A-Z0-9_]{1,32}\)|failed \(unknown\))$/u.exec(line)
    if (match !== null) observed.set(match[1]!, match[2]!)
  }
  const exit = result.error !== undefined ? 'spawn failed or timed out' : result.signal ?? result.status
  return [`exit=${exit}`, ...stages.map(stage => `${stage}=${observed.get(stage) ?? 'not reached'}`)].join('; ')
}

const runnerPrefix = 'windows-acl-run:'
const runnerOperations = new Set([
  'AddMandatoryAce', 'AllocateAndInitializeSid', 'AssignProcessToJobObject', 'CloseHandle',
  'ConvertStringSidToSidW', 'CopySid', 'CreateFileW', 'CreateJobObjectW', 'CreatePipe', 'CreateProcessAsUserW', 'CreateProcessW',
  'CreateRestrictedToken', 'CreateWellKnownSid', 'GetExitCodeProcess', 'GetLengthSid', 'GetNamedSecurityInfoW',
  'GetStdHandle', 'GetTempPathW', 'GetTokenInformation', 'InitializeAcl', 'IsValidSid', 'LocalAlloc', 'LocalFree', 'LockFileEx',
  'OpenProcess', 'OpenProcessToken', 'PeekNamedPipe', 'QueryInformationJobObject', 'ReadFile', 'ResumeThread',
  'SetConsoleCtrlHandler', 'SetEntriesInAclW', 'SetEnvironmentVariableW TEMP', 'SetEnvironmentVariableW TMP',
  'SetHandleInformation', 'SetInformationJobObject', 'SetNamedSecurityInfoW', 'SetTokenInformation',
  'TerminateJobObject', 'UnlockFileEx', 'WaitForSingleObject',
])

function runnerDetail(detail: string): string {
  // The runner may append paths, SIDs, and command details after the Win32 status.
  const win32 = /^([A-Za-z]{1,40}(?: (?:TEMP|TMP))?) failed \(Win32 (\d{1,10})\)(?::|$)/u.exec(detail)
  if (win32 !== null && runnerOperations.has(win32[1]!) && Number(win32[2]) <= 0xffff_ffff) {
    return `${win32[1]} failed (Win32 ${win32[2]})`
  }
  const acl =
    /^AclSandbox (init failed and \d{1,3} cleanup operation\(s\) also failed|dispose completed with \d{1,3} cleanup failure\(s\))$/u
      .exec(detail)
  if (acl !== null) return acl[0]
  const removal = /^(E[A-Z0-9_]{1,12}): [^\r\n]*, (rmdir|unlink) /u.exec(detail)
  if (removal !== null) return `${removal[2]} failed (Node ${removal[1]})`
  return 'detail withheld'
}

function runnerDiagnostics(stderr: string): { startup?: string; cleanup: string[] } {
  const cleanup: string[] = []
  let startup: string | undefined
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.startsWith(runnerPrefix)) continue
    const detail = line.slice(runnerPrefix.length).trimStart()
    if (detail.startsWith('cleanup:')) {
      if (cleanup.length < 2) cleanup.push(`${runnerPrefix} cleanup: ${runnerDetail(detail.slice('cleanup:'.length).trimStart())}`)
    } else {
      startup ??= `${runnerPrefix} ${runnerDetail(detail)}`
    }
  }
  return { startup, cleanup }
}

type RunnerOutcome = Pick<SpawnSyncReturns<string>, 'error' | 'signal' | 'status' | 'stderr'>

function assertRunner(result: RunnerOutcome, restricted: string, diagnostic = runnerDiagnostics(result.stderr ?? '')): void {
  expect(result.error === undefined, 'ACL runner failed to launch or timed out').toBe(true)
  expect(result.signal).toBeNull()
  expect(result.status, [restricted, diagnostic.startup, ...diagnostic.cleanup].filter(Boolean).join('\n')).toBe(0)
  expect(diagnostic.cleanup.length, diagnostic.cleanup.join('\n')).toBe(0)
}

function verifyRunnerDiagnostic(status: number, line: string, expected: RegExp): void {
  const result: RunnerOutcome = { status, signal: null, stderr: line }
  const check = () => assertRunner(result, 'fixture')
  expect(check).toThrow(expected)
  expect(check).not.toThrow(/fixture-private|S-1-5-21-9|ENV_FIXTURE|unrelated stderr/u)
}

function verifyRunnerDiagnostics(): void {
  const privateDetail = 'C:\\fixture-private S-1-5-21-9 ENV_FIXTURE=private\r\nunrelated stderr'
  verifyRunnerDiagnostic(127, `windows-acl-run: CreateProcessAsUserW failed (Win32 1314): ${privateDetail}`, /windows-acl-run: CreateProcessAsUserW failed \(Win32 1314\)(?![^]*fixture-private|[^]*unrelated stderr)/u)
  verifyRunnerDiagnostic(0, `windows-acl-run: cleanup: CloseHandle failed (Win32 6): ${privateDetail}`, /windows-acl-run: cleanup: CloseHandle failed \(Win32 6\)(?![^]*fixture-private|[^]*unrelated stderr)/u)
}

it.skipIf(process.platform !== 'win32')('creates true file and directory symlinks and denies a linked outside write', () => {
  verifyRunnerDiagnostics()
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-worktree-capability-'))
  const fileStages = ['file-create', 'file-link', 'file-link-read']
  const stages = [...fileStages, 'directory-link', 'outside-read', 'outside-write']
  let ordinary = 'not reached'
  let restricted = 'not reached'
  let startup = 'not observed'
  let cleanup = 'not observed'
  let readback = 'not reached'
  let linkTypes = 'not reached'
  try {
    const workspace = join(scratch, 'workspace')
    const control = join(scratch, 'ordinary')
    const privateTemp = join(scratch, 'runner-temp')
    const outside = join(scratch, 'outside')
    for (const path of [workspace, control, privateTemp, outside]) mkdirSync(path)
    const outsideFile = join(outside, 'outside.txt')
    const script = join(scratch, 'probe.cjs')
    writeFileSync(outsideFile, 'outside fixture', { flag: 'wx' })
    writeFileSync(script, probe, { flag: 'wx' })

    const controlResult = spawnSync(process.execPath, [script, control, 'ordinary'], {
      encoding: 'utf8', timeout: 3_000, windowsHide: true,
    })
    ordinary = probeSummary(controlResult, fileStages)

    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', runnerEntry,
      '--workspace', workspace, '--temp', privateTemp, '--mode', 'workspace-write',
      '--', process.execPath, script, workspace, outside,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    restricted = probeSummary(result, stages)
    const diagnostic = runnerDiagnostics(result.stderr ?? '')
    if (diagnostic.startup !== undefined) startup = diagnostic.startup
    else if (result.error === undefined && result.signal === null) startup = 'no failure reported'
    if (diagnostic.cleanup.length > 0) cleanup = diagnostic.cleanup.join('; ')
    else if (result.error === undefined && result.signal === null) cleanup = 'no failure reported'
    assertRunner(result, restricted, diagnostic)
    expect(result.stdout.trim()).toBe('outside link write denied')
    readback = 'started'
    expect(readFileSync(join(workspace, 'created.txt'), 'utf8')).toBe('created in workspace')
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside fixture')
    readback = 'ok'
    linkTypes = 'started'

    // PowerShell reports the Windows reparse type; Node lstat also accepts junctions.
    const links = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "@('file-link', 'directory-link') | ForEach-Object { (Get-Item -LiteralPath $_ -ErrorAction Stop).LinkType }",
    ], { cwd: workspace, encoding: 'utf8', timeout: 5_000, windowsHide: true })
    expect(links.error === undefined, 'LinkType inspection failed to launch or timed out').toBe(true)
    expect(links.signal).toBeNull()
    expect(links.status, 'LinkType inspection failed').toBe(0)
    expect(links.stdout.trim().split(/\r?\n/u)).toEqual(['SymbolicLink', 'SymbolicLink'])
    linkTypes = 'ok'
  } finally {
    console.info(`Ordinary token: ${ordinary}\nRestricted ACL runner: ${restricted}\nRunner startup: ${startup}\nRunner cleanup: ${cleanup}; parent readback: ${readback}; LinkType: ${linkTypes}; Node probe raw Win32 code: unavailable`)
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30_000)
