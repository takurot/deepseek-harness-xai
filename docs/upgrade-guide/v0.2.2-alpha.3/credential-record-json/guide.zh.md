---
kind: upgrade-guide
description: "持久化凭据提供方拒绝格式错误的记录及无法经受 JSON 存储的 grant payload。"
---

# 将凭据记录保存为普通 JSON 数据

[English](guide.md) | 中文

## 变更

`credentials-local` 与可选的 `credentials-keychain` 现在共享记录校验。钥匙串中类型错误的 API 密钥或环境值、缺少 grant payload 或包含未知字段的记录都会被拒绝。两个提供方均拒绝非有限数、负零、嵌套 `undefined`、稀疏或附带额外字段的数组、循环引用、访问器、转换方法和自定义对象实例，不再在持久化时悄悄改变内容。API 密钥值为 `undefined` 的可选字段规范化为缺省。被拒绝的替代值不会改变原有凭据。

## 迁移

1. 更新凭据拥有者，向 `modifyRecord` 传入普通 JSON 数据。将日期明确表示为字符串，省略缺省的对象字段，使用有限数与稠密数组。API 密钥和环境值保持为非空字符串；有意使用环境认证时采用空 `api-key` 记录。
2. 加载因记录或事务格式错误而失败时，保留现有存储。按提供方文档中的格式仅修复受影响记录；不要丢弃整个存储，也不要在诊断中暴露值。
3. 重新打开提供方后，确认正常的 `modifyRecord` 结果与 `readRecord` 相等。grant 拥有者仍负责校验其 JSON payload 的含义。
