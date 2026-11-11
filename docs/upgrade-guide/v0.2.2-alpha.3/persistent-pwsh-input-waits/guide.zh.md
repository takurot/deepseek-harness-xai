---
kind: upgrade-guide
description: "持久 pwsh 不再因 shell 进程组中的输入等待而提前返回。"
---
# 持久 pwsh 输入等待

[English](guide.md) | 中文

## 变更

持久 `pwsh` 命令会区分自身的起始与完成输出，以及前一命令延迟到达的提示符。在具备原生 stdin 等待检测的后端上，`Read-Host` 和 shell 进程组中的读取此前可能在完成前返回部分输出。这些读取现在会等待到 `timeoutMs` 并重置 shell。已证明的不同前台进程组输入等待仍可返回部分输出。

## 迁移

1. 将调用 `Read-Host` 的自动化改为通过参数或环境变量接收值。在调用 `pwsh` 前提供这些值。
2. 交互工作请使用提供[terminal 工具](../../../../packages/experimental/tool-terminal/README.zh.md)及 pwsh 后端的部署。通过 `terminal_send` 发送输入，而非再次调用持久 `pwsh` 命令。
3. 确认自动化命令返回自身输出，且下一条命令保留预期目录与环境。超时会报告 shell 已重置；收到该结果后重新初始化所需状态。
