---
kind: upgrade-guide
description: "macOS Keychain 写入使用带版本的原生条目，旧凭据提供方无法读取这些条目。"
---

# 使用原生 macOS 凭据条目

[English](guide.md) | 中文

## 变更

可选的 credentials-keychain 提供方通过 `osascript` 将 macOS 值写入 `v2:<account>`。原生读取优先使用这些后继；后继不存在时才回退到旧 `security` 条目。权限失败不会回退。这在支持长凭据的同时避免改变旧条目权限。Linux 存储不变。

旧物理条目保留到删除时。旧二进制无法读取后继，可能返回陈旧的旧值。原生条目可通过同一 OS 用户的 `osascript` 身份访问；提供方不对同用户 shell 隐藏凭据。使用 `security` 的外部脚本不会自动获得原生后继的访问权限。

## 迁移

1. 升级前停止使用同一 Keychain 服务的旧进程。使用原生后继期间不要启动它们。
2. 继续使用凭据服务。它自动读取旧值并写入后继。保存后通过 `readRecord` 和 `listRecords` 核对预期记录。
3. 使用更新后的提供方的 `unset` 或 `deleteRecord` 删除两代条目。删除失败可能保留当前值；检查后重试。删除先处理旧条目，避免中断时暴露陈旧值。
4. 降级前，通过兼容的提供方导出或重新保存所需凭据，不要记录其值。不要假定保留的旧副本包含最新凭据。
