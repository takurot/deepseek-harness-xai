/** Select ignored paths with Git and provision them inside the checkout's sandbox. */

import { basename, isAbsolute, normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { readGitListing, runCommand } from './process.ts'
import type { ProcessConfig } from './process.ts'
import { PROVISION_DIRECTORY } from './provision-directory.ts'
import type { CreatedWorktree } from './types.ts'

/** Complete file provisioning configuration. */
export interface FileProvisioningConfig extends ProcessConfig {
  /** Git executable. */
  gitCommand: string
  /** Node executable for sandboxed filesystem operations. */
  nodeCommand: string
  /** Repository-relative worktree pool. */
  directory: string
  /** Absolute external directory paths. */
  shareDirectories: string[]
  /** Root-relative Git glob pathspecs. */
  copyIgnored: string[]
  /** Copy a regular file or link to the source. */
  copyMode: 'copy' | 'symlink'
}

/** A file provisioning failure, including its stage and any checkout left in place. */
export class WorktreeFileProvisionError extends Error {
  override name = 'WorktreeFileProvisionError'

  /**
   * @param stage - which provisioning stage failed.
   * @param path - retained checkout path, or null before checkout allocation.
   * @param cause - underlying path, Git, or subprocess error.
   */
  constructor(readonly stage: 'share-validation' | 'ignored-list' | 'file-provisioning', readonly path: string | null, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(path === null ? detail : `Checkout at ${path} retained; provisioning may be incomplete. Inspect it before continuing. ${detail}`, { cause })
  }
}

function relativeSegments(value: string): string[] | undefined {
  if (/[\\:\0]/.test(value)) return undefined
  const parts = value.split('/')
  return parts.some(part => !part || part === '.' || part === '..') ? undefined : parts
}

function reserved(part: string): boolean {
  return /^(?:\.git|git~[1-9]\d*)$/i.test(part.replace(/[ .]+$/, '').replace(/\p{Default_Ignorable_Code_Point}/gu, ''))
}

/**
 * Validate syntax before any filesystem or Git work.
 * @param config - parsed worktree configuration.
 * @throws if a shared path or ignored glob could select an invalid location.
 */
export function validateFileProvisioning(config: FileProvisioningConfig): void {
  const names = new Set<string>()
  for (const value of config.shareDirectories) {
    const name = basename(value)
    // Reject dot segments rather than allowing lexical normalization to hide a reference through a link.
    if (!isAbsolute(value) || !name || value.includes('\0') || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(value) || reserved(name)) {
      throw new Error('worktree: shareDirectories requires absolute directory paths with usable, non-Git basenames')
    }
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error('worktree: shareDirectories basenames must be unique')
    names.add(key)
  }
  for (const glob of config.copyIgnored) {
    if (relativeSegments(glob)?.every(part => !reserved(part)) !== true) {
      throw new Error('worktree: copyIgnored requires root-relative Git globs without dot segments or Git metadata')
    }
  }
}

/** One create operation's resolved paths and execution authority. */
export interface FileProvisioningRun {
  /** Mounted execution providers. */
  ctx: Context
  /** Resolved configuration. */
  config: FileProvisioningConfig
  /** Calling Session policy. */
  policy: SandboxExecutionPolicy
  /** Source checkout root. */
  source: string
  /** Destination inside the worktree pool. */
  checkout: string
  /** Create cancellation. */
  signal: AbortSignal
}

function runWorker(run: FileProvisioningRun, action: 'check' | 'apply', input?: string) {
  const { ctx, config, policy, source, checkout, signal } = run
  return runCommand(ctx, config, policy, source, [
    config.nodeCommand, '--input-type=module', '-e', PROVISION_DIRECTORY, action,
    source, policy.workspaceRoot, checkout, config.copyMode, JSON.stringify(config.shareDirectories.map(normalize)),
  ], signal, undefined, undefined, input)
}

/**
 * Reject unsafe shared-directory references before allocating the Git checkout or branch.
 * @param run - one create operation.
 */
export async function checkShares(run: FileProvisioningRun): Promise<void> {
  try {
    await runWorker(run, 'check')
  } catch (error) {
    run.signal.throwIfAborted()
    throw new WorktreeFileProvisionError('share-validation', null, error)
  }
}

function verifyListing(listing: string, pool: string): void {
  for (let start = 0; start < listing.length;) {
    const end = listing.indexOf('\0', start)
    if (end < 0) throw new Error('Git returned an incomplete ignored path record')
    const target = listing.slice(start, end)
    const parts = relativeSegments(target)
    if (parts === undefined || parts.some(reserved) || target.toLowerCase() === pool || target.toLowerCase().startsWith(`${pool}/`)) {
      throw new Error('Git returned an unsafe ignored path')
    }
    start = end + 1
  }
}

/**
 * Provision external directory links and selected ignored files in a completed checkout.
 * @param run - one create operation and its completed checkout.
 * @returns counts for configured operations, including zero matches; no file names.
 * @throws on unsafe listing or incomplete writes; never removes the completed checkout.
 */
export async function provisionFiles(run: FileProvisioningRun): Promise<Pick<CreatedWorktree, 'sharedDirectories' | 'copiedIgnored'>> {
  const { ctx, config, policy, source, checkout, signal } = run
  const copies = config.copyIgnored.length > 0
  let listing = ''
  if (copies) {
    try {
      listing = await readGitListing(ctx, config, policy, source, [
        config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
        ...config.copyIgnored.map(glob => `:(top,glob)${glob}`),
        `:(top,exclude,literal)${config.directory}`, ':(top,glob,exclude,icase)**/.git', ':(top,glob,exclude,icase)**/.git/**',
      ], signal)
      verifyListing(listing, config.directory.toLowerCase())
    } catch (error) {
      signal.throwIfAborted()
      throw new WorktreeFileProvisionError('ignored-list', checkout, error)
    }
  }
  try {
    const result = await runWorker(run, 'apply', listing)
    return {
      ...config.shareDirectories.length === 0 ? {} : { sharedDirectories: config.shareDirectories.length },
      ...copies ? { copiedIgnored: Number(result.stdout.trim()) } : {},
    }
  } catch (error) {
    signal.throwIfAborted()
    throw new WorktreeFileProvisionError('file-provisioning', checkout, error)
  }
}
