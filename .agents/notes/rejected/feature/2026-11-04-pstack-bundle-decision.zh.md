# Agent Note: 将 pstack 作为 dsh 技能分发打包？

Status: rejected — pstack 保持为用户提供的 `customSkillDirs` 技能包；打包意味着发布一个 harness 无法维持兼容的第三方工作流

[English](2026-11-04-pstack-bundle-decision.md) | 中文

## Problem

[pstack](https://github.com/cursor/plugins/tree/c742dd6170/pstack) v0.15.36（commit `c742dd6170`）是一个第三方 `SKILL.md` 技能包（MIT、58 个技能、`agents/` 下 2 个 agent 文件），许多用户已在 Claude Code 中使用它。dsh 能加载兼容的 `SKILL.md` 目录，因此问题在于 dsh 是否应把 pstack 作为 bundle 发布：将其作为 official 或 experimental 包安装，使某个 profile 一次性获得整个技能包，还是把这件事留给用户自己的技能根目录。

打包并不只是打包选择。该包编码了一套工作流——`poteto-mode`、`/setup-pstack`、模型路由规则，以及通过 pstack 的 `Task` 工具进行的 subagent 委派——harness 一旦打包就要接管它：上游跟踪、许可证声明、它与已交付 `dsh-*` 技能及 `AGENTS.md` 的指令冲突，以及它与 dsh 自身 [`subagent`](../../../../packages/subagent/subagent/README.zh.md) seam 的兼容性。当前交付的 harness 并不承诺其中任何一项。

## Proposal

发布 `packages/experimental/pstack-bundle`，用 `dsh.bundle.patch` 以 pstack `skills/` 目录的 vendored 副本挂载 `skill-filesystem`，并附 README、experimental 包分类、许可证声明与快照覆盖。按该提案，安装 bundle 的用户无需配置根目录即可获得全部 pstack 技能，而 harness 将承担在 pstack 与 dsh 双方持续变化时保持该技能包可用的责任。

## Verification

该技能包通过一个 overlay 挂载，将 `skill-filesystem` 的 `customSkillDirs` 指向 pstack 的 `skills` 目录，然后用真实模型经已交付的 headless profile 驱动。

| 问题 | 结果 |
|---|---|
| Frontmatter 兼容性 | 全部 58 个技能都带有 `name`/`description`，且 name 与目录名一致；没有违规。未声明的键（`icon`、`color`、`paths`）加载不报错。 |
| 根组合 | `--dump-config` 显示 `customSkillDirs` 传入 `skill-filesystem`；加载与组合均无错误。 |
| 斜杠调用 | `/poteto-help` 加载正文，并沿其相对引用 `../poteto-mode/SKILL.md` 继续读取。 |
| 经 `skill` 工具的模型调用 | 按设计不可用：58 个技能中有 57 个声明 `disable-model-invocation: true`，这会把它们从模型目录与 `skill` 工具中移除；`/name` 手势是它们唯一的入口。 |
| Subagent 委派 | 未验证。58 个技能中有 8 个引用 Cursor 的 `Task`，pstack 的 Claude Code 适配器把该调用映射到那个 harness 的 `Agent` 工具；dsh 通过独立的 [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.zh.md) seam 以自有参数委派。 |
| Agent 文件 | 未加载：`agents/poteto-agent.md` 与 `comment-sicko.md` 是 harness 的 agent 定义，dsh 不读取。 |
| 模型路由映射 | 不支持：`/setup-pstack` 经其 Claude Code 适配器写入 `~/.claude/rules/pstack-models.md`，原生写入 `~/.cursor/rules/pstack-models.mdc`；dsh 都不读取。 |
| 工作流执行 | 未验证：`/poteto-mode` 从未在真实任务上运行，`/why`（MCP）从未被实际调用。 |

`skill-filesystem` 按[rank 顺序](../../../../packages/skill/skill-filesystem/README.zh.md)扫描项目根、`customSkillDirs`、`$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`），外加 rank 600 的可选打包根；`~/.claude/skills` 不是默认根（把 `customSkillDirs` 指向它是用户的选择）。因此 2026-11-04 观测到的 `setup-pstack` 条目来自 overlay 自身的 `customSkillDirs` 挂载。把 pstack 放到 `~/.agents/skills` 的用户则确实会通过默认 `user-agents` 根获得它。

## Alternatives considered

### 作为 experimental 包打包

**放弃：** 对一个快速变化的第三方工作流的跟踪（该技能包有 58 个技能与 2 个 agent 定义，按别人的发布节奏更新）、对复制进仓库的 MIT 源代码维护 `THIRD_PARTY_NOTICES`，以及为 dsh 未实现的构造（Cursor 的 `Task` 参数、pstack 的 `~/.claude`/`~/.cursor` 模型路由文件、其 `agents/` 定义）承担兼容义务。**获得：** 零配置的可用性。与之相对，构成 pstack 工作流的那些部分——subagent 委派与模型路由设置——恰恰是本 harness 无法兑现的部分，因此该 bundle 会发布一个其委派与模型路由步骤仍假定其他 harness 的工作流。该提案本须满足的 [experimental](../../../../packages/experimental/README.zh.md) 与 [official on-demand bundle](../../../../.agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.zh.md) 决策定义了其分类。

### 改为打包兼容层（转换 `Task`、读取 `~/.claude/rules`）

**放弃：** 同样的上游跟踪负担，外加两个委派词汇表之间的转换层，且必须同时跟踪两侧。**获得：** 可用的 pstack 工作流。这是比 pstack 更大的产品决策：它会让 Claude Code 的 agent 约定成为 dsh 的受支持输入格式，与 [`subagent`](../../../../packages/subagent/subagent/README.zh.md) seam 的单一委派约定以及把第三方格式排除在产品表面之外的目标相冲突。

### 不发布任何内容，让用户设置 `customSkillDirs`（已选择）

**放弃：** 没有零配置安装，不保证技能正文随 dsh 工具变化而持续可用，也没有 harness 侧对该技能包的升级路径。**获得：** harness 不发布任何无法维持兼容的第三方工作流，pstack 的发布节奏仍归 pstack，MIT 声明随用户自己的副本保留，而确实可用的斜杠调用与相对引用行为无需 harness 代码即可继续工作。重名技能按根 [rank](../../../../packages/skill/skill-filesystem/README.zh.md) 裁决（数值更低者胜出）：项目根的 100 与 200 高于 `customSkillDirs` 的 300，因此项目本地技能会覆盖该技能包；`$DSH_HOME/skills`（400）与 `$DSH_AGENTS_HOME/skills`（500）则低于它。

## Consequences

- pstack 只被运营，不被交付：把该技能包的 `skills` 目录加入 `skill-filesystem` 的 `customSkillDirs`（最窄的选择），或把其中每个技能目录直接安置（或软链接）到默认根（例如 `$DSH_AGENTS_HOME/skills`），因为发现深度为一层。当技能包应保持可替换且不进入用户共享 agent 根时，`customSkillDirs` 是更窄的选择。
- 该技能包自身只支持斜杠调用路径的，是 57 个声明 `disable-model-invocation: true` 的工作流技能；剩下的技能（`setup-pstack`）仍可被模型调用。希望模型调用的部署必须修改该技能包，并接受其正文仍假定其他 harness 的工具。
- Subagent 委派、模型路由映射与该技能包的 agent 文件仍未被转换。`Task` 调用在 dsh 中没有对应工具，会作为未知工具失败；模型路由映射从不生效，agent 定义文件从不加载，因此二者都不会产生诊断。
- 当工作流本身变得可移植时重新考虑打包：dsh 的 [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.zh.md) 接受 `Task` 形状的调用，或 pstack 发布 dsh 兼容的委派模式，并且有明确的上游跟踪负责人。复制源代码的许可证审查与快照场景届时会属于同一改动。
