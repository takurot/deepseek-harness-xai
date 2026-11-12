---
kind: upgrade-guide
description: "Keychain 命令开始执行期限和字节限制，在修改存储前拒绝无法完整读回或会截断的写入。"
---

# 设置 Keychain 命令预算

[English](guide.md) | 中文

## 变更

可选的 credentials-keychain 提供方默认将每个 OS 命令限制为 30000 毫秒，以及 stdout/stderr 合计 4194304 字节。它发送 TERM，等待 1000 毫秒后终止所属进程组，再等待描述符清理。即使处理器以退出码 0 结束，取消和期限仍作为失败。释放提供方时中断并等待所有拥有的命令。

无法完整读回的值在修改存储前被拒绝。Linux secret-tool 的 stdin 传输还将每个条目限制为 8192 个 UTF-8 字节；更大的引用、记录、索引或 journal 现在被拒绝，避免截断。增大输出预算不会提高该内在限制。底层非零命令结果不再返回原始输出：stdout 为空，stderr 在有诊断时为 `!`。

## 迁移

1. 检查 `cordis.yml` 中 credentials-keychain 条目的 `commandTimeoutMs`、`commandOutputLimitBytes` 和 `commandKillGraceMs`。定时器必须为不超过 2147483647 的正整数；输出限制必须符合 Node Buffer 和字符串上限。
2. 条目超过读回预算时，在保存前提高配置的输出限制。Linux 条目超过 8192 字节时使用其他提供方；预检拒绝会保留已有凭据。
3. 执行中的写入失败后，先检查凭据再重试。重新打开提供方恢复待处理的记录事务。`KEYCHAIN_STORAGE_LIMIT` 且 outcome 为 `unchanged` 表示预检拒绝；`KeychainCommitError` 和已启动命令的失败可能表示写入已生效。不会自动重复 mutation 回调。
