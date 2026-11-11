import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

const script = readFileSync(resolve(import.meta.dirname, 'prepare-ci-bubblewrap.sh'), 'utf8')
const payload = 'verified bubblewrap fixture\n'
const digest = createHash('sha256').update(payload).digest('hex')

interface CommandCall { command: string; args: string[] }

/** Offline command adapters preserve the shell script's download/check/extract/probe ordering. */
const adapter = String.raw`
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const { createHash } = require('node:crypto')
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const mode = process.env.BWRAP_FIXTURE_MODE
appendFileSync(process.env.BWRAP_FIXTURE_LOG, JSON.stringify({ command, args }) + '\n')
if (command === 'uname') {
  process.stdout.write(args[0] === '-s' ? 'Linux\n' : 'x86_64\n')
} else if (command === 'curl') {
  const primary = args.at(-1).startsWith('https://launchpad.net/')
  const destination = args[args.indexOf('--output') + 1]
  if (primary && ['fallback', 'corrupt-fallback', 'both-fail'].includes(mode) || mode === 'both-fail') {
    writeFileSync(destination, 'partial download')
    process.exit(6)
  }
  writeFileSync(destination, mode === 'corrupt-primary' || mode === 'corrupt-fallback'
    ? 'corrupt download' : 'verified bubblewrap fixture\n')
} else if (command === 'sha256sum') {
  const input = readFileSync(0, 'utf8')
  const match = /^([a-f0-9]{64})  (.+)\n$/.exec(input)
  if (!match || args.join(' ') !== '--check --status') process.exit(2)
  const actual = createHash('sha256').update(readFileSync(match[2])).digest('hex')
  process.exit(actual === match[1] ? 0 : 1)
} else if (command === 'dpkg-deb') {
  if (mode === 'extract-fail') process.exit(1)
  if (args[0] !== '--extract') process.exit(2)
  const bin = join(args[2], 'usr', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bwrap'), readFileSync(process.argv[1]), { mode: 0o755 })
} else if (command === 'sudo') {
  process.exit(mode === 'sysctl-fail' ? 1 : 0)
} else if (command === 'bwrap') {
  if (args[0] === '--version') {
    process.stdout.write('bubblewrap 0.12.0\n')
    process.exit(mode === 'version-fail' ? 1 : 0)
  }
  process.exit(mode === 'probe-fail' ? 1 : 0)
} else {
  throw new Error('unexpected fixture command')
}
`

function prepare(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bubblewrap-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const bin = join(directory, 'bin')
  const runner = join(directory, 'runner temp')
  const log = join(directory, 'commands.jsonl')
  const githubPath = join(directory, 'github path')
  mkdirSync(bin)
  mkdirSync(runner)
  writeFileSync(log, '')
  writeFileSync(githubPath, '')
  for (const command of ['uname', 'curl', 'sha256sum', 'dpkg-deb', 'sudo']) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n${adapter}`, { mode: 0o755 })
  }
  const filename = join(directory, 'prepare.sh')
  // Substitute only the expected digest; downloaded fixture bytes still undergo a real SHA256 comparison.
  writeFileSync(filename, script.replace(/^readonly BUBBLEWRAP_SHA256='[^']+'$/mu, `readonly BUBBLEWRAP_SHA256='${digest}'`))
  const result = spawnSync('bash', [filename], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: runner, GITHUB_PATH: githubPath,
      BWRAP_FIXTURE_MODE: mode, BWRAP_FIXTURE_LOG: log },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as CommandCall)
  return { ...result, calls, path: readFileSync(githubPath, 'utf8'), runner }
}

// The production prerequisite is a Linux/POSIX shell program; static workflow checks still run on Windows.
describe.skipIf(process.platform === 'win32')('bubblewrap download and confinement preparation', () => {
  it.each(['primary', 'fallback', 'sysctl-fail'])('verifies and probes a valid %s download', (mode) => {
    const result = prepare(mode)
    expect(result.status).toBe(0)
    const urls = result.calls.filter(call => call.command === 'curl').map(call => call.args.at(-1))
    expect(urls[0]).toContain('https://launchpad.net/ubuntu/+source/bubblewrap/0.12.0-1/')
    expect(urls).toHaveLength(mode === 'fallback' ? 2 : 1)
    if (mode === 'fallback') expect(urls[1]).toBe('https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_0.12.0-1_amd64.deb')
    expect(result.calls.filter(call => call.command === 'sha256sum')).toHaveLength(1)
    expect(result.calls.filter(call => call.command === 'bwrap').map(call => call.args)).toEqual([
      ['--version'], ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'],
    ])
    expect(result.path).toBe(`${join(result.runner, 'dsh-bubblewrap', 'usr', 'bin')}\n`)
    expect(result.stdout).toContain('bubblewrap functional probe passed')
  })

  it.each(['corrupt-primary', 'corrupt-fallback', 'both-fail'])('rejects %s before extraction or probes', (mode) => {
    const result = prepare(mode)
    expect(result.status).not.toBe(0)
    expect(result.calls.some(call => ['dpkg-deb', 'sudo', 'bwrap'].includes(call.command))).toBe(false)
    expect(result.calls.filter(call => call.command === 'curl')).toHaveLength(mode === 'corrupt-primary' ? 1 : 2)
    expect(result.calls.filter(call => call.command === 'sha256sum')).toHaveLength(mode === 'both-fail' ? 0 : 1)
    expect(result.path).toBe('')
    expect(result.stdout).not.toContain('bubblewrap functional probe passed')
  })

  it.each(['extract-fail', 'version-fail', 'probe-fail'])('does not report success after %s', (mode) => {
    const result = prepare(mode)
    expect(result.status).not.toBe(0)
    const probes = result.calls.filter(call => call.command === 'bwrap')
    expect(probes).toHaveLength(mode === 'extract-fail' ? 0 : mode === 'version-fail' ? 1 : 2)
    expect(result.stdout).not.toContain('bubblewrap functional probe passed')
  })
})
