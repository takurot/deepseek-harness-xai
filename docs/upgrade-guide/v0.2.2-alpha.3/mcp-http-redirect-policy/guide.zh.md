---
kind: upgrade-guide
description: Streamable HTTP MCP 连接拒绝重定向到其他源。
---

# 配置最终 MCP 端点 URL

[English](guide.md) | 中文

## 变更

Streamable HTTP MCP 连接不再跟随协议、主机名或端口不同的重定向。此前这些重定向可能将自定义认证标头、MCP 会话 ID 和请求正文转发到其他源。经过这类重定向的连接现在会失败，包括同一主机名从 HTTP 到 HTTPS 的升级。POST 请求仍跟随同源 307 和 308 重定向，但拒绝会改变请求方法的 301、302 和 303 重定向。stdio 连接不变。

## 迁移

1. 在 `cordis.yml` 或配置档补丁中找到使用 `transport: streamable-http` 的 `mcp-client` 条目。
2. 如果其 `url` 重定向到其他源，或对 POST 请求使用 301、302、303 重定向，将 `url` 替换为预期 MCP 服务器的最终端点。确认该服务器可信，可以接收配置的标头和请求。
3. 重新加载该条目并调用服务器的一个工具。调用成功即可确认端点无需跨源重定向便能接受连接。
