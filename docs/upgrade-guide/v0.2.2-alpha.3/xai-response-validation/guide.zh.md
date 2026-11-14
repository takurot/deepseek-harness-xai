---
kind: upgrade-guide
description: xAI 搜索要求终结状态和有效的输出字段，XaiResponse 现在要求 status 和 output。
---

# xAI 搜索响应验证

[English](guide.md) | 中文

## 变更

实验性 `@deepseek-ai/dsh-web-search-xai` 提供方只有在 Responses API 报告 `status: completed` 时才接受成功的搜索输出。不完整的回答（包括含有引用的回答）以 `WEB_PROVIDER_ERROR` 失败。使用的字段格式无效也会失败。导出的 `XaiResponse` 类型现在要求 `status` 和 `output`，条目类型标记必须是字符串。直接调用 `mapXaiResponse` 的代码和 HTTP 测试数据需要更新。

## 迁移

1. 更新传给 `mapXaiResponse` 的 `XaiResponse` 值，加入 `status: 'completed'` 和 `output` 数组。使用 `status: 'incomplete'` 表示不完整的响应，并处理 `WEB_PROVIDER_ERROR`。
2. 更新 Responses API 测试数据，包含字符串类型标记、消息的 `content` 数组，以及包含字符串 `text` 和 `annotations` 数组的 `output_text` 块。每个 `url_citation` 必须有非空字符串 `url`。未使用的引用位置和标题仍为可选。
3. 验证已完成且有引用的响应成功，不完整的响应产生结构化错误且不暴露部分回答。`truncated` 仍只表示网页服务限制了来源数量。
