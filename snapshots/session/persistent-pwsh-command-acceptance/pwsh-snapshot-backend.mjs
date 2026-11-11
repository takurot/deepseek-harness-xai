/** Scripted echo and execution frames exercise the persistent PowerShell tool through its shipped profile. */

const responses = [
  { token: 'PWSH_OK', code: 0 },
  { token: 'PWSH_FAIL', code: 7 },
]

class SnapshotSession {
  motd = 'dsh> '
  statusValue = { kind: 'running' }
  scrollback = 'dsh> '
  next = 0
  pending
  delayedTail = ''

  startSend(request) {
    let viewport
    let waitReason
    if (request.submit) {
      const response = responses[this.next++]
      if (this.pending || !response || !request.text.includes(`[Console]::Out.Write('  ${response.token}  ')`)) {
        throw new Error('unexpected command-acceptance snapshot command')
      }
      const start = /__DSH_PERSISTENT_PWSH_START_[a-f0-9-]+__/.exec(request.text)?.[0]
      const end = /__DSH_PERSISTENT_PWSH_END_[a-f0-9-]+:/.exec(request.text)?.[0]
      const done = /__DSH_PERSISTENT_PWSH_DONE_[a-f0-9-]+__/.exec(request.text)?.[0]
      const frame = request.stdinWaitAfterOutput
      if (!start || !end || !done || typeof frame !== 'object' || frame.startLine !== start || frame.completionLine !== done) {
        throw new Error('command acceptance requires the actual START and completion output lines')
      }
      this.pending = { ...response, start, end, done, started: false }
      viewport = this.delayedTail + `${request.text}\r\n`
      this.delayedTail = ''
      waitReason = 'inferred_idle'
    } else {
      const pending = this.pending
      const frame = request.stdinWaitAfterOutput
      if (!pending || request.text !== '' || typeof frame !== 'object'
        || frame.startLine !== pending.start || frame.completionLine !== pending.done) {
        throw new Error('command acceptance must continue reading without resubmitting input')
      }
      if (!pending.started) {
        viewport = `\r\n${pending.start}\r\n  ${pending.token}  `
        pending.started = true
      } else {
        viewport = `${pending.end}${pending.code}  \r\n`
        this.delayedTail = `${pending.done}\r\n${this.motd}`
        this.pending = undefined
      }
      waitReason = 'inferred_idle'
    }
    this.scrollback += viewport
    const result = { viewport, waitReason, sessionStatus: this.statusValue, truncated: false }
    let consumed = false
    return {
      done: Promise.resolve(result),
      readOutput: () => {
        if (consumed) return { delta: '', truncated: false }
        consumed = true
        return { delta: viewport, truncated: false }
      },
      cancel: () => false,
    }
  }

  read(request) {
    const lines = this.scrollback.split('\n')
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    const end = lines.length - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join('\n')
    return { text, totalLines: lines.length, lineBegin: offset, lineEnd: offset + text.split('\n').length, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    return Promise.resolve()
  }
}

/** Scenario-local fixture identity. */
export const name = 'pwsh-command-acceptance-snapshot'
/** Terminal service owns the backend registration and sessions. */
export const inject = ['terminals']

/** Register echo-before-execution frames under the terminal service. @param ctx - Effect-scoped plugin context. */
export function apply(ctx) {
  ctx.terminals.registerBackend({
    type: 'shell',
    spawn: () => Promise.resolve(new SnapshotSession()),
  })
}
