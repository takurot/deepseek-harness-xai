# Agent Note: 工作流引擎上的运行预算

Status: implemented

[English](2026-11-19-workflow-run-budgets.md) | 中文

## Problem

工作流引擎限制了单次运行的并发、条目数与子 agent 总数，但没有任何机制限制其成本。一个循环调用 `agent()` 的脚本——需显式启用的 Ralph 循环正是这种形态——可能消耗无界的实际时间与提供方 token，而部署侧除了取消整个工具调用之外没有其他手段。

两个事实决定了该修复的形态。第一，一轮工作就是一个完整的子会话，中途切断会留下没有任何报告描述的工作区状态；因此预算必须阻止*下一个*子 agent，绝不能打断正在运行的子 agent。第二，token 成本只能通过 token meter 的按会话折叠来观测，而子 agent 的用量只在其会话仍然存在时可读。

## Decision

预算属于工作流 seam 的运行级参数，由 guest 在 `agent()` 即将发布子 agent 时强制执行。

- `WorkflowStartRequest` 携带可选的 `maxElapsedMs` 与 `maxTotalTokens`。它们没有引擎默认值：部署策略属于拥有该次运行的消费方（Ralph 的插件配置），而不是每个工作流。
- guest 在开始运行脚本时取一次单调的 `performance.now()` 作为起点，并累加每个已结算子 agent 的提供方用量。
- 检查只在 `agent()` 准入时执行——即在等待并发槽位之后——因此被拒绝的调用会释放槽位且不计入已启动数量；运行可能因已在执行的子 agent 而超出预算。达到任一预算即抛出带 `BUDGET_EXHAUSTED` 代码的致命 `WorkflowError`；由脚本决定如何结算。正在运行的子 agent 绝不会被取消。
- 子 agent 用量来自 token meter：宿主在发布子 agent 时捕获其活动中的 `Session`，结算后读取 `ctx.tokenMeter.sessionUsage(session)`。被 seed 的会话以父级历史的副本开头，其总量无法归因于该子 agent：该子 agent 视为无法统计，而带 token 预算的运行会在启动前拒绝继承父级上下文的提供方。Session 不可用、未挂载 token meter，或其日志未记录任何提供方用量的子 agent 会被排除，并计入 `WorkflowResult.childrenWithoutUsage`。
- 当 token 预算遇到无法统计的子 agent 时，下一次准入以 `BUDGET_UNENFORCEABLE` 被拒绝，而不是把部分总和呈现为完整成本。Ralph 同样捕获该代码并结算为 `budget-limited`，因为已完成的 Round 与它们的有界交接正是上文“直接失败”替代方案被否决的理由。
- `WorkflowResult` 报告汇总 `usage` 与 `childrenWithoutUsage`；Ralph 把二者回传给父模型，其固定脚本捕获两种预算代码，并以引擎给出的原因文本结算为 `budget-limited`。

## Why the engine, not the script

替代方案是向脚本暴露运行统计（`stats()` 返回经过时间与用量），让引擎不涉及预算，由部署方拥有的脚本自行比较。这样 Ralph 就不需要错误协议。

该方案被否决有三个原因。新的脚本钩子属于模型可见契约：`tool-workflow` 的描述会列出每个钩子，且有 95 个已提交快照 sidecar 捕获该描述，因此这项改动会为一个只有部署方脚本使用的设施重写工作流工具的可见契约。让模型编写的脚本访问实际时间，会诱发会话日志无法重建的非确定性分支。而准入检查与已存在于 guest 中的 `maxTotalAgents` 兜底同形；把同一类上限拆到两种机制中容易产生偏差。

## Alternatives considered

### 脚本可见的 `stats()` 钩子

**放弃：** 模型可见钩子列表保持更小，引擎也不必新增错误词汇。代价：由 79 个工具 schema sidecar 与 16 个系统提示词 sidecar 固定的模型可见描述变更、模型编写脚本中的实际时间分支，以及需要维护的第二处用量汇总。

### 预算达到时由宿主取消

**放弃：** 引擎可以监听进度事件并取消。之所以否决，是因为取消不是预算结果：它会与脚本的下一个 `agent()` 调用竞争、可能在 Round 中途生效（正是预算必须避免的结果），并报告 `cancelled` 而不是 worker 可以解释的停止原因。

### subagent seam 上的 `SubagentResult.usage`

**放弃：** 子 agent 用量将由提供方拥有，对进程外后端同样正确。本次改动否决它，是因为那会给每个提供方增加字段与义务，包括无法上报用量的提供方；而工作流引擎可以通过已经折叠该数值的 token meter 读到同一数值。若出现第二个需要按子 agent 统计用量的消费方，把该值移到 `SubagentResult` 会成为自然的扩展。

### 预算耗尽时直接失败

**放弃：** 可以让整个运行报错。之所以否决，是因为已完成的 Round 承载真实工作与有界交接；把它们转成工具错误会丢弃父级唯一能看到的摘要。

## Consequences

- Ralph 把预算暴露为配置上限加上只能收紧的调用参数，并在预算耗尽或无法统计两种情况下都返回带引擎原因的 `budget-limited`。其结果报告汇总的子 agent 用量以及无法统计的子 agent 数量。
- token 预算要求提供方的子 agent 通过已挂载的 token meter 记录用量。默认的进程内提供方满足该条件；不上报任何内容的外部后端会比预算要求更早停止运行，并以 `BUDGET_UNENFORCEABLE` 作为明确原因，而不是给出被静默少计的总量。
- `tokenUsage` 只折叠一个子会话日志，因此再启动自身后代的子 agent 只贡献自己的轮次。[工作流引擎限制](../../../../packages/workflow/workflow-ptc/README.zh.md)记录了这一点。
- 没有任何组件为 token 计价：支出上限仍需要每条路由的价格表，因此延期。
