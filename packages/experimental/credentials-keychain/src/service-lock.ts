/** OS-user/service writer coordination; descriptors retain the lease across helper-process lifetimes. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** A store lock could not be acquired without risking a conflicting writer. */
export class KeychainLockError extends Error {
  constructor(readonly code: 'KEYCHAIN_LOCK_TIMEOUT' | 'KEYCHAIN_LOCK_UNSAFE') {
    super(code === 'KEYCHAIN_LOCK_TIMEOUT'
      ? 'credentials-keychain: timed out waiting for the service lock; wait for the other credential operation to finish before retrying'
      : 'credentials-keychain: unsafe service lock directory or file; restore owner-only access before retrying')
    this.name = 'KeychainLockError'
  }
}

/**
 * Hold one stable-inode kernel lock through an operation and any inherited helper descriptors.
 * @param root - private directory owned by the current OS user.
 * @param service - validated secret-store service name.
 * @param waitMs - maximum acquisition time in milliseconds.
 * @param signal - cancellation of acquisition, including provider disposal.
 * @param operation - operation receiving the locked descriptor; subprocesses inherit this descriptor.
 * @returns the operation's result after closing the local descriptor.
 * @throws when the location is unsafe, acquisition fails or expires, or the operation fails.
 */
export async function withServiceLock<T>(
  root: string,
  service: string,
  waitMs: number,
  signal: AbortSignal,
  operation: (fd: number) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const deadline = performance.now() + waitMs
  const uid = userInfo().uid
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new KeychainLockError('KEYCHAIN_LOCK_UNSAFE')
  }
  const path = join(root, createHash('sha256').update(service).digest('hex') + '.lock')
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0) {
      throw new KeychainLockError('KEYCHAIN_LOCK_UNSAFE')
    }
    for (;;) {
      signal.throwIfAborted()
      if (performance.now() >= deadline) throw new KeychainLockError('KEYCHAIN_LOCK_TIMEOUT')
      try {
        // An abort cannot close this descriptor while the native call may still acquire it.
        await tryLockExclusive(handle.fd)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new KeychainLockError('KEYCHAIN_LOCK_TIMEOUT')
      await wait(Math.min(20, remaining), undefined, { signal })
    }
    signal.throwIfAborted()
    if (performance.now() >= deadline) throw new KeychainLockError('KEYCHAIN_LOCK_TIMEOUT')
    return await operation(handle.fd)
  } finally {
    // Never unlink the lock: all contenders must continue opening the same inode.
    await handle.close()
  }
}
