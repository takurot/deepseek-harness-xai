# Git 工作树

[English](worktrees.md) | 中文

实验性的 [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.zh.md) 服务提供 `ctx.worktrees`。其消费方 [`create_worktree`](../../packages/experimental/tool-worktree/README.zh.md) 创建新的 Git 分支与检出目录，再通过[工作目录服务](working-directory.zh.md)选中它。[变更请求与工作树组合包](../../packages/experimental/forge-bundle/README.zh.md#use-this-package)通过 GUI 插件管理器一起加载这两个包，随安装提供但默认关闭。其他 profile 可以选择[独立工作树组合包](../../packages/experimental/tool-worktree/README.zh.md#use-this-package)，或显式挂载这两个包。

## 创建与保留

调用方 Session 的当前目录决定源仓库。创建操作在分配检出目录前固定所选本地提交、分支或标签；默认使用 `HEAD`。名称必须对应新分支与未使用的检出路径。创建不会获取缺失对象；默认不复制源检出目录中的未提交文件。

默认目标为 `<current checkout root>/.agents/worktrees/<name>`。`repositoryRoot` 是调用方当前检出目录的顶层目录；因此，链接检出目录会在自身内部保存工作树父目录。仅当服务的分配操作创建了配置指定的父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`。已有文件与忽略规则保持不变。调用方 Session 的现有沙箱策略必须允许写入目标目录与共享 Git 管理目录。检出完成后，服务先准备配置中选取的文件，再运行配置命令，最后改变工作目录。

通过 `working_directory({ cd: path })` 离开时，会保留检出目录与分支。取消或失败也可能留下部分产物；错误会指出它们的位置。服务销毁时会中止待完成操作并等待它们结束。[包 README](../../packages/experimental/worktree/README.zh.md)拥有配置与 Git 要求。

## 请求与结果

`onPhase` 在阶段开始前通知调用方，不得抛出异常。`prepare` 校验并分配检出目录，`checkout` 写入受 Git 跟踪的内容。只有实际尝试配置命令时，创建才发出 `provision` 通知。非零退出或超时写入 `WorktreeProvision`，而不是作为检出错误。文件准备失败抛出 `WorktreeFileProvisionError`，并指出是否保留了检出目录。恢复只发出 `prepare` 和 `checkout`，不进行准备工作。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
