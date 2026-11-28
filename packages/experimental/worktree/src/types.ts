/** Public requests and results for creating a Git worktree and entering it, and for restoring a removed one. */

/** A new checkout from a locally available Git commit, branch, or tag. */
export interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
  /** Run the configured setup command unless explicitly false. File provisioning still applies. */
  setup?: boolean
}

/** Observed outcome of the configured post-checkout command. */
export interface WorktreeProvision {
  /** Configured shell command or literal argv; excludes environment overrides. */
  command: string | string[]
  /** A direct exit, a deadline, or no observable exit because command execution failed. */
  status: 'exited' | 'timed-out' | 'unavailable'
  /** Observed direct exit code, or null when none is available. */
  exitCode: number | null
  /** Observed direct termination signal, or null when none is available. */
  signal: string | null
  /** Bounded UTF-8 output, stdout followed by stderr without an inserted delimiter. */
  output: string
  /** Whether the output exceeded its byte budget. */
  truncated: boolean
}

/** Committed Git baseline and the calling Session's resulting working directory. */
export interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
  /** Setup exit facts, present only when a configured command was attempted. */
  provision?: WorktreeProvision
  /** Number of links created; absent when no shared directories are configured. */
  sharedDirectories?: number
  /** Number of ignored regular files provisioned; absent when no globs are configured. */
  copiedIgnored?: number
}

/** Creation stages: validate and allocate, write tracked files, then attempt any configured setup. */
export type CreateWorktreePhase = 'prepare' | 'checkout' | 'provision'

/** A removed checkout to check out again at its recorded directory. */
export interface RestoreWorktreeRequest {
  /** Canonical checkout directory the worktree had. */
  path: string
  /** Branch the worktree had checked out. */
  branch: string
  /** Commit the branch started from; a branch that no longer exists is created again here. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** Outcome of one restoration. */
export interface RestoredWorktree {
  /** Checkout directory, present again. */
  path: string
  /** Whether the branch no longer existed and was created again at the base commit, without the commits it had gained. */
  branchRecreated: boolean
}
