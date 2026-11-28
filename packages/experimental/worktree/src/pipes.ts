/** Caller-side lifecycle and bounded retention for two raw subprocess pipes. */

import { addAbortListener } from 'node:events'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

interface CapturedPipe {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

/** Drain raw subprocess output without retaining more than a shared byte budget. */
export class BoundedPipes {
  private readonly stdout: CapturedPipe = { chunks: [], bytes: 0, truncated: false }
  private readonly stderr: CapturedPipe = { chunks: [], bytes: 0, truncated: false }

  constructor(private remaining: number) {}

  /**
   * Consume one raw pipe until closed, keeping only the portion that fits the shared limit.
   * @param stream - provider-owned transport exposed for caller consumption; absent on early startup failure.
   * @param key - which output stream supplied these bytes.
   */
  async drain(stream: Readable | undefined, key: 'stdout' | 'stderr'): Promise<void> {
    if (stream === undefined) return // A provider startup failure can precede pipe allocation.
    const pipe = this[key]
    const retain = (chunk: Buffer) => {
      const bytes = Math.min(this.remaining, chunk.length)
      if (bytes !== 0) {
        pipe.chunks.push(Buffer.from(chunk.subarray(0, bytes)))
        pipe.bytes += bytes
        this.remaining -= bytes
      }
      if (bytes < chunk.length) pipe.truncated = true
    }
    const settlement = finished(stream, { cleanup: true })
    stream.on('data', retain)
    try {
      await settlement
    } finally {
      stream.off('data', retain)
    }
  }

  /**
   * Read sanitized UTF-8 suitable for a tool result.
   * @returns retained stdout and stderr text, with a truncation flag.
   */
  read(): { output: string; truncated: boolean } {
    const stdout = decodePipe(this.stdout)
    const stderr = decodePipe(this.stderr)
    return { output: stdout.text + stderr.text, truncated: stdout.truncated || stderr.truncated }
  }

  /**
   * Read bounded stderr separately for sandbox runner diagnostics.
   * @returns retained stderr and whether any bytes were omitted.
   */
  readStderr(): { text: string; truncated: boolean } {
    return decodePipe(this.stderr)
  }

  /**
   * Read a protocol message without decoding partial or invalid UTF-8 as paths.
   * @returns complete stdout or undefined if its cap was exceeded.
   * @throws if stdout is not well-formed UTF-8.
   */
  strictStdout(): string | undefined {
    const pipe = this.stdout
    if (pipe.truncated) return undefined
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(pipe.chunks, pipe.bytes))
  }
}

function decodePipe(pipe: CapturedPipe): { text: string; truncated: boolean } {
  // Do not flush an incomplete final character when the retained bytes are a prefix.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(pipe.chunks, pipe.bytes), { stream: pipe.truncated })
  if (Buffer.byteLength(text) <= pipe.bytes) return { text, truncated: pipe.truncated }
  // A replacement character for malformed input can require more bytes than its input.
  let bytes = 0
  let end = 0
  for (const point of text) {
    bytes += Buffer.byteLength(point)
    if (bytes > pipe.bytes) break
    end += point.length
  }
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Observe direct completion, finish the pipes, and wait for the provider's process range to empty.
 * @param child - process handle with caller-owned pipes.
 * @param output - retention owner for both pipes.
 * @param signal - closes both pipes when the caller's deadline or cancellation fires.
 * @returns observed direct outcome and whether a pipe or the direct process reported failure.
 * @throws when the provider cannot establish managed-range quiescence.
 */
export async function settlePipes(
  child: SubprocessHandle,
  output: BoundedPipes,
  signal: AbortSignal,
): Promise<{ outcome: SubprocessOutcome | undefined; failed: boolean }> {
  const closePipes = () => { child.stdout?.destroy(); child.stderr?.destroy() }
  const drained = [output.drain(child.stdout, 'stdout'), output.drain(child.stderr, 'stderr')]
  using _stop = addAbortListener(signal, closePipes)
  let outcome: SubprocessOutcome | undefined
  let failed = false
  try {
    await Promise.all([child.done.then((value) => { outcome = value }), ...drained])
  } catch (_error) {
    // A rejected process or pipe cannot be reported as a complete result.
    failed = true
  } finally {
    child.terminate()
    if (failed) closePipes()
    const [range] = await Promise.allSettled([child.waitForExit(), child.done, ...drained])
    if (range.status === 'rejected') throw range.reason
  }
  return { outcome, failed }
}
