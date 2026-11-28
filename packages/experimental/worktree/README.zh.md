---
description: "按照调用 Session 的文件策略创建并进入保留的 Git 工作树。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

[English](README.md) | 中文

## 概述

从本地提交创建隔离的检出目录，并在其中继续同一个 Session。每次操作创建新的具名分支，源检出目录保持不变。所有写入均受现有沙箱约束。离开检出目录会保留文件与分支。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将服务与 `workingDirectory`、`fs`、`subprocess`、`sandbox` 和 `sandboxPolicy` 提供方一起挂载。模型需要此操作时，再添加工具包。

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from?, setup? }, signal?, onPhase?)` 创建新分支和检出目录，然后将其设为当前目录。`from` 默认为 `HEAD`，并在分配目录前解析为本地提交。`baseCommit` 报告提交对象名；仓库本地的替换引用仍可影响检出内容。检出禁用已配置的 Git clean、smudge 和 process 过滤器。分支或路径已存在时会报错。默认不带入源检出目录中的未提交文件，也不运行配置命令。

`ctx.worktrees.restore(agent, { path, branch, baseCommit, repositoryRoot }, signal?, onPhase?)` 在记录的目录重新检出被删除的 worktree。它在修改前校验记录中的仓库根目录、完整提交对象名、分支和配置池内的规范目标路径。它只通过 `git worktree remove` 移除缺失目标的未锁定登记；其他 worktree 与锁定登记保持不变。随后在分支仍存在时检出该分支，否则在 `baseCommit` 重新创建同名分支，并通过 `branchRecreated` 报告是哪种情况。目录已存在时会报错。调用方 Session 的工作目录不变，从未提交的修改无法恢复。检出与创建时一样禁用过滤器。`onPhase` 在检查目录、清理登记与创建分支之前收到 `prepare`，在写入文件之前收到 `checkout`；它不能抛出异常。 恢复不重建共享内容或副本，也不运行配置命令。

默认检出目录是 `<current checkout root>/.agents/worktrees/<name>`。返回的 `repositoryRoot` 是调用方当前检出目录的顶层目录；如果它是链接检出目录，工作树父目录就嵌套在其中。省略名称时，名称由前缀 `dsh-`、Session id 中 UUID 的前 8 位十六进制数、一个连字符和 4 位随机十六进制数组成，例如 `dsh-6b1f02c4-9a3e`；Session id 不含 UUID 时，前缀后接 8 位随机十六进制数。`generatedWorktreeName` 导出同一规则，供在创建前确定名称的调用方使用。仅当服务的分配操作创建了父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`；已有文件与忽略规则保持不变。相对路径 `directory`、生成名称使用的 `namePrefix`、可执行程序与进程限制可在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-worktree)中查阅。

### 检出后的准备

在工作树服务的挂载配置中，将 `setupCommand` 设为参数数组可按字面值执行，设为字符串则使用本地非交互式 shell（POSIX 上为 `sh`，Windows 上为 Windows PowerShell）。命令在新检出目录中仅运行一次，默认时限为 `setupTimeoutMs: 120000`。`setupEnv` 仅传给此命令，不传给沙箱运行器。`setup: false` 跳过命令，但不影响下述文件准备。仅配置可信的命令与脚本；命令文本和输出会进入工具历史，不要在其中放入或打印机密。

`shareDirectories` 接受实际位于源检出目录和 Session 工作区之外的绝对目录，且不能是二者的祖先目录。它按目录的末级名称创建链接。`copyIgnored` 仅选取符合根目录相对 Git glob 且被 Git 忽略的未跟踪普通文件，不选取 `.git` 或工作树父目录。`copyMode` 默认为 `copy`；`symlink` 则链接到源文件。文件准备在配置命令前完成。它不会覆盖现有文件或沿符号链接父目录写入。链接不授予目标权限；不要在准备期间替换相关目录，也仅在确有需要时选取秘密文件。

`maxOutputBytes` 限制配置命令两路输出保留的总字节数，也限制忽略文件的完整列举。结果的 `provision` 报告命令、退出事实、受限的 UTF-8 输出和截断标记。确认运行器失败时，结果为 `unavailable`，不提供目标进程的退出码或信号。服务不将输出转存到文件。列举超限时不会应用部分列表。已配置的文件准备操作只在结果中报告数量。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

Git、目录分配、文件准备和配置命令均在调用方现有的子进程沙箱内执行。创建操作不会扩大对目标目录、共享 Git 元数据或链接目标的写权限。服务销毁时会取消待完成操作，并等待它们停稳。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 解析源提交、创建检出目录并发布新的工作目录 |
| [`src/process.ts`](src/process.ts) | 约束字面参数、限制输出并等待进程终止 |
| [`src/directory.ts`](src/directory.ts) | 申请目标目录并初始化新建工作树父目录的忽略文件 |

本包不发布运行时不变量伴随入口：Git 拥有工作树注册信息，工作目录服务拥有 Session 目录；本包不保留二者的独立投影。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [工作树子系统](../../../docs/subsystems/worktrees.zh.md)——请求、结果与服务参考。
- [工作目录](../../session/working-directory/README.zh.md) — 记录的 Session 目录与目录切换。
- [工作树工具](../tool-worktree/README.zh.md) — 面向模型的创建操作。
- [子进程](../../subprocess/subprocess/README.zh.md) — 进程所有权与执行环境。
- [创建决策](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.zh.md) — 保留检出目录与既有写权限。

-----

<a id="model-experience"></a>
## 模型体验

通过工作树工具的创建结果与工作目录服务记录的 Session 上下文间接影响模型。

#### KV Cache 影响

本包不贡献提示文本。其消费方负责追加工具结果与记录的目录上下文。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **保留产物**——离开会保留分支和文件。配置命令失败时仍会进入检出目录并报告失败。文件准备失败或操作被取消时，服务保持 Session 当前目录不变，并可能留下分支和部分文件。检查保留的检出目录后再继续；服务不会自动清理或重试。
- **仅限本地提交**——检出不会获取提交或部分克隆中缺失的对象，也不会初始化子模块。Git 满足执行要求时，本地对象缺失会导致创建失败。
- **过滤器处理前的内容**——检出时跳过已配置的过滤器，以避免执行仓库配置的程序或隐式下载。Git LFS 指针与加密 blob 保持存储时的形式；拉取实体内容或解密由用户另行执行。
- **执行要求**——子进程提供方必须在与文件系统提供方相同的执行环境中提供 Git 与 Node。Git 必须识别 `GIT_NO_LAZY_FETCH`：Git 2.45 及 2.39.4、2.40.2、2.41.1、2.42.2、2.43.4、2.44.1 维护版本均支持；更早的版本会忽略该变量并继续执行而不报错，因此创建操作可能从 promisor 远程获取缺失的部分克隆对象。`git --no-lazy-fetch` 选项会拒绝这些版本，但它仅在 Git 2.45 及以后存在，也会拒绝上述已修补的维护版本。现有沙箱必须允许写入检出目录与共享 Git 元数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

沙箱内的 Node 子进程提供[文件系统服务](../../fs/fs/src/index.ts)未公开的独占目录创建能力，并确定父目录是否由本服务创建。文件系统契约允许 [fs-local](../../fs/fs-local/src/index.ts) 等普通提供方在写入时忽略 `sandboxPolicy`；`createIfAbsent` 保护文件，但既不执行权限约束，也不确定目录由谁创建。将目录分配和忽略文件创建放在与 Git 相同的进程沙箱内，可保留对已有检出路径的拒绝行为，并落实创建 `.gitignore` 的条件。

</details>
