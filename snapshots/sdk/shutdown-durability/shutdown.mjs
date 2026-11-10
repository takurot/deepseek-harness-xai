/** Hold a real or replayed stream until application shutdown cancels it. */
import { writeFile } from 'node:fs/promises'

export const name = 'shutdown-stream-fixture'
export const inject = ['llm']

/** Publish readiness only after the loop consumes a text delta. */
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options, next) {
    const cancelled = Promise.withResolvers()
    const onAbort = () => cancelled.resolve()
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const chunk of next()) {
        yield chunk
        if (chunk.type !== 'text-delta') continue
        await writeFile(process.env.DSH_SHUTDOWN_READY, '')
        if (!options.signal.aborted) await cancelled.promise
        options.signal.throwIfAborted()
      }
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }
  })
}
