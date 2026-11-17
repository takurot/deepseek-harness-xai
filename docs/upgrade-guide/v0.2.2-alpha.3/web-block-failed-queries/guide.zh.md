---
kind: upgrade-guide
description: WebBlockLabels 现在要求 failedQueries 标签，Web 搜索卡片会显示搜索失败的查询。
---

# Web 搜索卡片列出失败的查询

[English](guide.md) | 中文

## 变更

多查询的 `web_search` 不再因为其中一个查询失败而丢弃成功结果。已完成的 Web 搜索卡片现在会显示失败的查询，因此 `@deepseek-ai/dsh-client-ui-primitives` 中的 `WebBlockLabels` 要求新增的 `failedQueries` 标签字符串。自行构造 `WebBlockLabels` 值的代码——例如用自己的标签渲染 `WebBlock` 的应用——在提供该标签之前将无法编译。已经使用对话插件标签的调用方不受影响。

`WebSearchBlockProps` 接受可选的 `failedQueries` 列表，元素为 `{ query, code }`；`@deepseek-ai/dsh-tools` 中的 `WebSearchResultView` 携带同一个可选字段。两者都是增量变更：省略该字段时卡片渲染与之前完全一致。聊天工具行传入的标签由 `@deepseek-ai/dsh-client-ui-tool` 的 `webBlockLabels` 构造，其字符串来自 `conversation` 语言字典。

## 迁移

1. 在每一处构造的 `WebBlockLabels` 值中新增该标签，例如 `failedQueries: 'Failed queries'`。把它放在现有的 `noResults` 与 `sourcesTruncated` 标签旁边，并按语言翻译。
2. 构造卡片时从已完成结果转发该字段：把 `resultView.failedQueries`（或工具结果元数据中的 `failedQueries`）作为 `WebSearchBlockProps.failedQueries` 传入；数组为空时省略。
3. 验证部分查询失败的 `web_search` 调用会在标签下为每个失败查询渲染一行，而全部成功的调用不渲染任何行。`pnpm run verify-client-ui-i18n` 确认该标签字符串位于语言字典中，而不是写在组件代码里。
