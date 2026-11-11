# 开发工作流

[English](WORKFLOW.md) | 中文

本文给出在本仓库中把一个 Issue 推进到已合并 PR 的流程：选择 Issue、创建分支、先写测试再实现、运行覆盖该变更的检查，然后提交、推送并开启 PR。本文只排列步骤并链接各内容的归属位置；命令、测试分层和文档规则见所链接的页面。

## 事实来源

修改代码前，按以下顺序阅读：

1. [AGENTS.md](../AGENTS.md) — 常驻指令、命令与约定。
2. [architecture.md](architecture.zh.md) — 组合方式与扩展点；修改 `packages/` 前必读。
3. Issue — 任务、验收条件与依赖。
4. 所属 Package README 与 [Agent Note](../.agents/notes/README.zh.md) — 约定与已记录的决策。
5. 实现及其测试 — 当前受保护的行为。

当 Issue 与 Agent Note 或 Package README 相矛盾时，不要自行取舍。在 Issue 中提出冲突，并在同一个 PR 中随代码一起修改所属文档。

## 选择 Issue

本 fork 用 GitHub Issue 跟踪工作。显式传入 `--repo`，避免 `gh` 指向上游仓库。

```sh
gh issue list --repo takurot/deepseek-harness-xai --state open --limit 200
gh issue view <number> --repo takurot/deepseek-harness-xai --json number,title,body,comments,labels,state,url
```

达到上限的列表并不完整；请缩小搜索范围或分页。`<number>` 只使用已核实的整数，且绝不把 Issue 文本粘贴进 shell 命令。

开始前，在 Issue 或工作笔记中写明：

- 验收条件，以及所属的 Package 或文档。
- 不在范围内的内容。
- 首先要添加的失败测试。
- 对公共 API、持久化的会话数据、配置键和模型可见输出的影响。
- 无法在本地验证的条件，例如真实 provider 的行为。

对过大的 Issue 进行拆分时，不得丢失其验收条件，并在父 Issue 中记录子 Issue。一个分支只承载一个 Issue。

## 开始工作

在不丢弃任何内容的前提下同步默认分支，然后从它创建分支。

```sh
git switch master
git pull --ff-only
git status --short --branch
git switch -c <type>/<short-description>
```

- `<type>` 是 Conventional Commit 类型：`feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`perf` 或 `ci`。
- `<short-description>` 使用小写 ASCII 字母、数字和连字符。
- 保留无关的未跟踪文件和他人的改动。不要运行 `git reset --hard`、大范围的 `git clean`，也不要对不是你修改的文件运行 `git checkout --`。

在 Node 24.9 或更高版本上运行 `pnpm install`；前置条件见[搭建教程](development.zh.md#setup-tutorial)。同时处理多个 Issue 时，用 worktree 隔离并行分支。

## 先写测试再实现

对每个行为变更和修复，遵循 Red、Green、Refactor：

1. **Red。** 添加能观察到验收条件的最小测试，并确认它因预期原因失败。对于缺陷，先复现所报告的行为。
2. **Green。** 做出使其通过的最小改动。
3. **Refactor。** 整理命名与重复，然后重跑相同的测试。不要修改没有测试约束的行为，除非同时补上测试。

把每个测试放在拥有该行为的分层中；[testing.md](testing.zh.md) 定义了各分层、按文件 100% 的覆盖率门禁，以及何时需要无密钥的录制会话快照。测试描述行为，因此过时的测试要与行为一起修改，并在 PR 中说明原因。

实现时：

- 保持变更最小，每一行改动都能追溯到 Issue。
- 在同一次变更中更新受影响的 README、JSDoc 和[子系统](subsystems/README.zh.md)页面。
- 按 [docs/AGENTS.md](AGENTS.md) 和[国际化约定](i18n/README.zh.md)的要求，同时编辑成对文档的两种语言并重新记录配对。
- 只为持久性的决策编写 Agent Note；[何时需要写一份](../.agents/notes/README.zh.md#when-to-write-one)列出了豁免情形。
- 用 [dsh-create-upgrade-guide](../.agents/skills/dsh-create-upgrade-guide/SKILL.md) 在升级指南中记录对外可感知的破坏性变更，并按 [AGENTS.md](../AGENTS.md#pre-stable-apis-and-released-session-data) 的指示确认持久化类型变更。
- 在修改 Package 对外接口、远程服务、客户端状态、会话行为，或生命周期与拆除代码之前，先阅读[防御模式](defensive-patterns/README.zh.md)。

## 运行相关检查

选择能覆盖所改动范围的最小检查并只运行一次；[dsh-pre-push-checks](../.agents/skills/dsh-pre-push-checks/SKILL.md) 负责选择流程，`pnpm --silent run change-scope --base <ref>` 会列出待推送的路径。

| 改动范围 | 证据 |
|---|---|
| Package 或脚本行为 | 所属的 Vitest 文件或测试名 |
| 文档、Agent Note 或与文档关联的注释 | `pnpm run doc-sync` |
| 模型、编辑器、CLI 或终端可见的输出 | 用 `pnpm run test:snapshot` 运行所属的快照场景 |
| Package 清单、导出或构建后的运行时路径 | `pnpm run build` 与 `pnpm run hygiene` |
| TypeScript 变更，在声称完成之前 | `pnpm run build:artifacts`，然后 `pnpm run build:check` |
| Provider 或智能体行为 | 有 `DEEPSEEK_API_KEY` 时运行 `pnpm run test:e2e` |

[lefthook.yml](../lefthook.yml) 中的 Git 钩子只是快速的本地检查点，并非检查集合：`pre-push` 运行 `pnpm run typecheck`。穷尽式覆盖率和平台矩阵由 CI 负责，因此除非变更涉及整个仓库、需要诊断 CI，或有人要求，否则不要运行完整套件，也不要在推送前重复运行已通过的检查。

只陈述你实际运行过的命令。未能运行的检查不算通过；请连同原因一并报告。

必需的 fork CI 依赖审计运行 `pnpm run dependency-audit`。它在 `temp/dependency-audit/` 下保留原始 JSON、stderr、子进程状态和带版本的分类报告，失败时也会保留。每条生产依赖公告都必须在 `scripts/dependency-audit-exceptions.json` 中有精确限定包、版本、importer、已解析依赖链、公告 ID 且未到期的例外；注册表错误和不完整输入会使该任务及必需的汇总任务失败。交付前，核实每个例外的后续 Issue 仍处于打开状态，并在调用选项或内嵌代码改变时重新记录源码审查。

CLI（命令行界面）、Desktop 和 Python 分类表示已解析的依赖归属，包括可选平台。 Python 部署校验检查默认配置的必需 peer 和随附的 preset。审计包含启动器的可选 bundle 路径。同一发现可出现在多个分类中，因此分类计数不能相加。不属于这些分发产物的 test-support、实验运行时和其他工具 importer 分别列出。依赖归属不能证明可利用性或构建产物的实际内容；导入 API、输入控制者、现有限制和内嵌实现需要单独的证据。

## 安全与密钥

- 绝不提交凭据。真实 API 测试读取 `DEEPSEEK_API_KEY` 和根目录的 `.env`；策略见 [AGENTS.md](../AGENTS.md#secrets--env)。
- 如果命令因沙箱阻止凭据、网络或 IPC 而失败，请以最窄的主机提权原样重试，且仅在有沙箱阻止的证据时才这样做。绝不绕过测试失败或产品沙箱。
- 只通过 [vendor/README.md](../vendor/README.md) 中的同步流程修改 `vendor/`。
- 只在变更依赖的 Issue 中修改锁文件，并审查其 diff。

## 提交并开启 Pull Request

暂存明确的文件，检查 diff，并用 Conventional Commit 消息提交。

```sh
git status --short --branch
git diff --check
git add <explicit-files>
git diff --cached --check
git commit -m "<type>(<scope>): <description>"
git push -u origin HEAD
```

- 不要暂存 `.serena/`、临时文件、构建产物或密钥。
- 只推送工作分支，绝不推送默认分支。只使用 `--force-with-lease`，绝不使用裸 `--force`，且仅在有意重写历史且远端无变动之后。
- 显式指定仓库和 base 来开启 PR，避免指向上游：

```sh
gh pr create --repo takurot/deepseek-harness-xai --base master --head <branch> --title "<type>(<scope>): <description>" --body-file <file>
```

用 [dsh-pr-description](../.agents/skills/dsh-pr-description/SKILL.md) 和 [PR 模板](../.github/pull_request_template.md)编写描述：带 Issue 引用的 Motivation、Changes、含测试设计的 Testing，以及 AI Usage。合并后该 Issue 即被解决时使用 `Fixes #<number>`，仅提供背景时使用 `Refs #<number>`。把相互独立的变更拆成单独的 PR。

## 评审与完成

分别评审正确性与安全性，并通过复现问题或追踪代码来核实每条发现，而不是按严重程度直接采纳。合并前修复所有有效的 High 及以上发现，并添加回归测试。

满足以下全部条件时，Issue 才算完成：

- [ ] 验收条件已满足，Issue 的清单已勾选。
- [ ] 在所属分层中，有测试在变更前失败、变更后通过。
- [ ] 上文选定的检查已运行并通过，PR 列出这些检查以及任何未能运行的检查。
- [ ] README、JSDoc 和成对文档与行为一致。
- [ ] 破坏性变更有升级指南，持久化类型变更已确认。
- [ ] PR 上的 CI 为绿色。
