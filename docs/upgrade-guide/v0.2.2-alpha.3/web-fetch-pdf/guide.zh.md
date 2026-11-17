---
kind: upgrade-guide
description: "`web_fetch` 现在返回提取出的 PDF 文本，而不是拒绝 `application/pdf`，并为封闭的 `WebFetchBody` 联合新增 `pdf` 分支。"
---
# `web_fetch` 提取 PDF 文本

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-web-fetch-http` 过去会以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝 `application/pdf` 响应。现在它在 Worker 线程中提取逐页文本，并返回 `body` 为新增 `pdf` 分支的 `WebFetchResult`：`{ kind: 'pdf', content, pageCount, pagesExtracted }`。`content` 用 U+000C FORM FEED 连接各页文本。`maxPdfPages`（默认 `50`）限制提取的页数，`maxBodyChars` 同时限制提取出的文本，`truncated` 报告其中任一种截断。扫描版 PDF 返回空页分段，OCR 仍不在范围内。

超过 `maxResponseBytes` 的响应以 `WEB_FETCH_TOO_LARGE` 失败，而不是返回部分文档；损坏、加密或不支持的 PDF 以 `WEB_PDF_UNREADABLE` 失败。提取 Worker 内部的故障是 `WEB_PROVIDER_ERROR`，不含引擎的构建则报告 `WEB_PDF_UNAVAILABLE`：打包的 Python runtime wheel 为满足 PyPI 单文件大小上限省略了它，因此其中的 PDF 需要 Node 或桌面发行版。

受影响的代码：面向已发布 `WebFetchBody` 类型、以 `assertNever` 结尾做穷尽 `switch` 的外部 TypeScript 消费方必须处理 `pdf` 分支；构造 `HttpFetchLimits` 的调用方必须提供 `maxPdfPages`。面向模型的工具使用者无需改动。

## 迁移

1. 在每个 `switch (result.body.kind)` 中新增处理 `content`、`pageCount` 与 `pagesExtracted` 的 `pdf` 分支，并保留 `assertNever` 默认分支。
2. 在每个 `HttpFetchLimits` 值中提供 `maxPdfPages`，或在提供方的插件配置中设置 `maxPdfPages`。
3. 需要抓取超过默认 5,000,000 字节的 PDF 的部署，应提高 `maxResponseBytes`。
4. 用 `pnpm run typecheck` 确认迁移；不再有缺少 `pdf` 分支的 `WebFetchBody` switch。
