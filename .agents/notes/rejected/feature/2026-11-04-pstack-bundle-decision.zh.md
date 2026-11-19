# Agent Note: 将 pstack 作为 dsh 技能分发打包？

Status: rejected — pstack 保持为用户提供的 `customSkillDirs` 技能包；打包意味着发布一个 harness 无法维持兼容的第三方工作流

[English](2026-11-04-pstack-bundle-decision.md) | 中文

## Problem

[pstack](https://github.com/cursor/plugins/tree/main/pstack) 是一个第三方技能包（MIT、58 个技能、2 个 Claude Code agent 文件），许多用户已在 Claude Code 中使用它。dsh 能加载兼容的 `SKILL.md` 目录，因此问题在于 dsh 是否应把 pstack 作为 bundle 发布：将其作为 official 或 experimental 包安装，使某个 profile 一次性获得整个技能包，还是把这件事留给用户自己的技能根目录。

打包并不只是打包选择。该包编码了一套工作流——`poteto-mode`、`/setup-pstack`、模型路由规则，以及通过 Claude Code `Task` 工具进行的 subagent 委派——harness 一旦打包就要接管它：上游跟踪、许可证声明、它与已交付 `dsh-*` 技能及 `AGENTS.md` 的指令冲突，以及它与 dsh 自身 [`subagent`](../../../../packages/subagent/subagent/README.zh.md) seam 的兼容性。当前交付的 harness 并不承诺其中任何一项。

## Proposal

发布 `packages/experimental/pstack-bundle`，用 `dsh.bundle.patch` 以 pstack `skills/` 目录的 vendored 副本挂载 `skill-filesystem`，并附 README、experimental 包分类、许可证声明与快照覆盖。按该提案，安装 bundle 的用户无需配置根目录即可获得全部 pstack 技能，而 harness 将承担在 pstack 与 dsh 双方持续变化时保持该技能包可用的责任。

## Verification (what was established, 2026-11-04)

该技能包通过一个 overlay 挂载，将 `skill-filesystem` 的 `customSkillDirs` 指向 pstack 的 `skills` 目录，然后用真实模型经已交付的 headless profile 驱动。

| Question | Result |
|---|---|
| Frontmatter 兼容性 | 全部 58 个技能都带有 `name`/`description`，且 name 与目录名一致；没有违规。未声明的键（`icon`、`color`、`paths`）加载不报错。 |
| 根组合 | `--dump-config` 显示 `customSkillDirs` 传入 `skill-filesystem`；加载与组合均无错误。 |
| 斜杠调用 | `/poteto-help` 加载正文，并沿其相对引用 `../poteto-mode/SKILL.md` 继续读取。 |
| 经 `skill` 工具的模型调用 | 按设计不可用：58 个技能中有 57 个声明 `disable-model-invocation: true`，因此模型目录把它们暴露为仅斜杠调用的条目。 |
| Subagent 委派 | 未验证。技能正文 26 次引用 Claude Code 的 `Task`；dsh 通过独立的 [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.zh.md) seam 以自有参数委派。 |
| Agent 文件 | 未加载：`agents/poteto-agent.md` 与 `comment-sicko.md` 是 Claude Code agent 定义，dsh 不读取。 |
| 模型路由映射 | 不支持：`/setup-pstack` 写入 `~/.claude/rules/pstack-models.md`，dsh 不读取。 |

值得记录的更正：最初调查把可见的 `setup-pstack` 条目归因于 dsh 扫描 `~/.claude/skills`。事实并非如此。`skill-filesystem` 按[排名顺序](../../../../packages/skill/skill-filesystem/README.zh.md)扫描项目根、`customSkillDirs`、`$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`）；`~/.claude/skills` 不是默认根，该条目来自 overlay 自身的 `customSkillDirs` 挂载。把 pstack 转换到 `~/.agents/skills` 的用户则确实会通过默认 `user-agents` 根获得它。

## Alternatives considered

### 作为 experimental 包打包

**放弃：** 对一个快速变化的第三方工作流的跟踪（该技能包有 58 个技能与 2 个 agent 定义，按别人的发布节奏更新）、对复制进仓库的 MIT 源代码维护 `THIRD_PARTY_NOTICES`，以及为 dsh 未实现的构造（Claude Code `Task` 参数、`~/.claude/rules` 模型映射、agent 定义文件）承担兼容义务。**获得：** 零配置的可用性。与之相对，构成 pstack 工作流的那些部分——subagent 委派与模型路由设置——恰恰是本 harness 无法兑现的部分，因此该 bundle 会发布一个有两处残缺的工作流并称其为受支持。

### 改为打包兼容层（转换 `Task`、读取 `~/.claude/rules`）

**放弃：** 同样的上游跟踪负担，外加两个委派词汇表之间的转换层，且必须同时跟踪两侧。**获得：** 可用的 pstack 工作流。这是比 pstack 更大的产品决策：它会让 Claude Code 的 agent 约定成为 dsh 的受支持输入格式，与 [`subagent`](../../../../packages/subagent/subagent/README.zh.md) seam 的单一委派约定以及把第三方格式排除在产品表面之外的目标相冲突。

### 不发布任何内容，让用户设置 `customSkillDirs`（已选择）

**放弃：** 没有零配置安装，不保证技能正文随 dsh 工具变化而持续可用，也没有 harness 侧对该技能包的升级路径。**获得：** harness 不发布任何无法维持兼容的第三方工作流，pstack 的发布节奏仍归 pstack，MIT 声明随用户自己的副本保留，而确实可用的斜杠调用与相对引用行为无需 harness 代码即可继续工作。重名技能按根排名确定解析（排名更低者胜出），因此用户可以从项目根或 DSH 根覆盖任意 pstack 技能。

## Consequences

- pstack 只被运营，不被交付：把该技能包的 `skills` 目录加入 `skill-filesystem` 的 `customSkillDirs`，或把它转换到默认根目录（例如 `$DSH_AGENTS_HOME/skills`）。当技能包应保持可替换且不进入用户共享 agent 根时，`customSkillDirs` 是更窄的选择。
- 该技能包自身只声明支持斜杠调用路径；对 57 个选择退出的技能，模型目录发现保持禁用。希望模型调用的部署必须修改该技能包，并接受其正文仍假定 Claude Code 工具。
- Subagent 委派、模型路由映射与 Claude Code agent 文件仍未被转换。需要它们的任务会在工具调用处失败，而不会静默降级。
- 当工作流本身变得可移植时重新考虑打包：dsh 的 [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.zh.md) 接受 `Task` 形状的调用，或 pstack 发布 dsh 兼容的委派模式，并且有明确的上游跟踪负责人。复制源代码的许可证审查与快照场景届时会属于同一改动。
