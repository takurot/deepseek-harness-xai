# Git Worktrees

English | [中文](worktrees.zh.md)

The experimental [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.md) service provides `ctx.worktrees`. Its [`create_worktree`](../../packages/experimental/tool-worktree/README.md) consumer creates a new Git branch and checkout, then selects it through the [working-directory service](working-directory.md). The [Change requests & worktrees bundle](../../packages/experimental/forge-bundle/README.md#use-this-package) loads both packages through the GUI plugin manager and ships switched off. Other profiles can select the [standalone worktree bundle](../../packages/experimental/tool-worktree/README.md#use-this-package) or mount the two packages explicitly.

## Creation and retention

The calling Session's current directory selects the source repository. Creation pins the requested local commit, branch, or tag before allocating the checkout; omission selects `HEAD`. Each name must identify a new branch and an unused checkout path. Creation does not fetch missing objects or, by default, copy uncommitted source files.

The default destination is `<current checkout root>/.agents/worktrees/<name>`. `repositoryRoot` is the top-level directory of the caller’s current checkout; a linked checkout therefore contains its own pool. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the configured pool directory. Existing files and ignore rules are preserved. The calling Session’s existing sandbox policy must permit writes to the destination and shared Git administration directory. After checkout, the service applies configured file provisioning, attempts the configured setup command, and then changes the working directory.

Leaving through `working_directory({ cd: path })` retains the checkout and branch. Cancellation or failure can also retain partial artifacts; the error identifies their location. The service aborts and drains pending operations on disposal. The [package README](../../packages/experimental/worktree/README.md) owns configuration and Git requirements.

## Request and result

`onPhase` notifies the caller before each stage and must not throw. `prepare` validates and allocates the checkout; `checkout` writes tracked content. Creation emits `provision` only when it attempts the configured command. A nonzero exit or deadline appears in `WorktreeProvision`, not as a checkout error. Failed file provisioning raises `WorktreeFileProvisionError`, which identifies whether a checkout was retained. Restoration emits only `prepare` and `checkout` and does not provision files or run setup.

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag. */
interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
  /** Run the configured setup command unless explicitly false. File provisioning still applies. */
  setup?: boolean
}
```

```ts type-equiv
/** Committed Git baseline and the calling Session's resulting working directory. */
interface CreatedWorktree {
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
```

```ts type-equiv
/** Creation stages: validate and allocate, write tracked files, then attempt any configured setup. */
type CreateWorktreePhase = 'prepare' | 'checkout' | 'provision'
```

```ts type-equiv
/** A removed checkout to check out again at its recorded directory. */
interface RestoreWorktreeRequest {
  /** Canonical checkout directory the worktree had. */
  path: string
  /** Branch the worktree had checked out. */
  branch: string
  /** Commit the branch started from; a branch that no longer exists is created again here. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

```ts type-equiv
/** Outcome of one restoration. */
interface RestoredWorktree {
  /** Checkout directory, present again. */
  path: string
  /** Whether the branch no longer existed and was created again at the base commit, without the commits it had gained. */
  branchRecreated: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates retained Git worktrees under the mounted filesystem and sandbox providers.

```ts cordis-catalog
/**
 * Create a fresh branch and checkout at a pinned local revision, then enter it.
 * Existing branches or checkout paths fail. Only configured ignored files are provisioned.
 * Checkout disables configured clean, smudge, and process filters without changing Git config.
 * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
 * Publishes the new directory after checkout and configured provisioning. A command failure is
 * returned with the retained checkout. Cancellation or file provisioning failure rejects without
 * publishing the directory and may leave a branch and partial checkout.
 * @param agent - caller whose current directory selects the source repository and file policy.
 * @param request - optional name, revision, and setup opt-out; defaults are generated name, HEAD, and enabled setup.
 * @param signal - cancellation of lookup, creation, and working-directory publication.
 * @param onPhase - receives each stage before it begins; it must not throw.
 * @returns checkout identity, any file counts, and any setup outcome.
 */
async create( agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal, onPhase?: (phase: CreateWorktreePhase) => void, ): Promise<CreatedWorktree>

/**
 * Check out a removed worktree again at its recorded directory: its branch
 * when the branch still exists, otherwise a new branch of the same name at
 * `baseCommit`. Only the missing target's unlocked registration is removed, and an
 * existing directory fails. Changes that were never committed are not
 * recovered. Checkout disables configured clean, smudge, and process filters,
 * as creation does. Restoration does not provision files, run setup, or change the Session directory.
 * Failures may retain newly allocated Git/filesystem artifacts.
 * @param agent - caller whose sandbox policy confines the commands.
 * @param request - recorded directory, branch, base commit, and source repository root.
 * @param signal - cancellation of the restoration.
 * @param onPhase - receives each stage before it begins; it must not throw.
 * @returns the directory and whether the branch was created again.
 */
async restore( agent: Agent, request: RestoreWorktreeRequest, signal?: AbortSignal, onPhase?: (phase: Exclude<CreateWorktreePhase, 'provision'>) => void, ): Promise<RestoredWorktree>
```

Types: [Agent](core.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
