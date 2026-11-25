/** Windows capability check through the existing restricted-token runner, without Worktree code. */

import { spawnSync } from 'node:child_process'
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
fs.writeFileSync(file, 'created in workspace', { flag: 'wx' });
fs.symlinkSync(file, fileLink, 'file');
assert.equal(fs.readFileSync(fileLink, 'utf8'), 'created in workspace');
fs.symlinkSync(outside, dirLink, 'dir');
const viaLink = path.join(dirLink, 'outside.txt');
assert.equal(fs.readFileSync(viaLink, 'utf8'), 'outside fixture');
assert.throws(() => fs.writeFileSync(viaLink, 'unexpected write'), error =>
  error.syscall === 'open' && (error.code === 'EACCES' || error.code === 'EPERM'));
console.log('outside link write denied');
`

it.skipIf(process.platform !== 'win32')('creates true file and directory symlinks and denies a linked outside write', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-worktree-capability-'))
  try {
    const workspace = join(scratch, 'workspace')
    const privateTemp = join(scratch, 'runner-temp')
    const outside = join(scratch, 'outside')
    for (const path of [workspace, privateTemp, outside]) mkdirSync(path)
    const outsideFile = join(outside, 'outside.txt')
    const script = join(scratch, 'probe.cjs')
    writeFileSync(outsideFile, 'outside fixture', { flag: 'wx' })
    writeFileSync(script, probe, { flag: 'wx' })

    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', runnerEntry,
      '--workspace', workspace, '--temp', privateTemp, '--mode', 'workspace-write',
      '--', process.execPath, script, workspace, outside,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr, `Windows ACL runner cleanup failed:\n${result.stderr}`).not.toMatch(/^windows-acl-run: cleanup:/mu)
    expect(result.stdout.trim()).toBe('outside link write denied')
    expect(readFileSync(join(workspace, 'created.txt'), 'utf8')).toBe('created in workspace')
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside fixture')

    // PowerShell reports the Windows reparse type; Node lstat also accepts junctions.
    const links = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "@('file-link', 'directory-link') | ForEach-Object { (Get-Item -LiteralPath $_ -ErrorAction Stop).LinkType }",
    ], { cwd: workspace, encoding: 'utf8', timeout: 5_000, windowsHide: true })
    expect(links.error).toBeUndefined()
    expect(links.signal).toBeNull()
    expect(links.status, links.stderr).toBe(0)
    expect(links.stdout.trim().split(/\r?\n/u)).toEqual(['SymbolicLink', 'SymbolicLink'])
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30_000)
