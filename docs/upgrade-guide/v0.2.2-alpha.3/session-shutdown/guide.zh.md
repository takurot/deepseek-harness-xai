---
kind: upgrade-guide
description: "Session 关停现在等待待定的持久化获取操作，并报告组合的启动和清理失败。"
---

# Session 关停等待持久化

[English](guide.md) | 中文

## 变更

正常关停会保留 Session 持久化，直到活跃 Agent 提交收尾事件并关闭写句柄。移除持久化提供方会永久停止其 Agent；替换提供方不会重新启动它们。调用方、工厂、提供方和根上下文的释放也等待待定的持久化 `create` 或 `open` 操作，并关闭取消后返回的任何句柄。此前，这些操作仍处于待定状态时，释放就可能完成。获取期间，公开启动操作的取消仍可立即拒绝；Agent 初始化开始后，拒绝仍等待回滚。

如果启动和清理都失败，启动 promise 现在会以包含两者的 `AggregateError` 拒绝。最终写入失败会使显式 `AgentHandle.dispose()` 拒绝，并出现在框架生命周期诊断中；根上下文释放可能在记录失败后正常返回。Session 格式和配置键保持不变。

## 迁移

1. 如果提供自定义 `SessionPersistence`，请确保待定的 `create` 和 `open` 操作最终结束，且返回的句柄能够完成 `close()`。永不结束的后端操作现在会使所有者或提供方关停持续等待；强制终止无法确认持久性。
2. 更新启动错误处理器，在回滚也失败时检查 `AggregateError.errors`。需要持久性结果时，应等待显式 `AgentHandle.dispose()`；应用关停时，应监控生命周期诊断。
3. 替换提供方后，显式创建或恢复所需 Agent。重新打开保存的 Session，检查最终 `step/end` 及以 disposed 为中止原因的 `turn/end`，以验证正常关停。参见 [Agent loop 生命周期](../../../../packages/core/agent-loop/README.zh.md#understand-the-implementation)。
