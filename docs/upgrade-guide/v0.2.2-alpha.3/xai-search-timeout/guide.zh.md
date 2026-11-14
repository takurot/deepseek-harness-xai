---
kind: upgrade-guide
description: "xAI 搜索拒绝超过 Node 定时器上限的超时值，并将响应体读取期限到期报告为超时。"
---

# xAI 搜索超时范围与分类

[English](guide.md) | 中文

## 变更

实验性的 `web-search-xai` 插件接受 `1` 至 `2147483647` 范围内的整数 `timeoutMs`。此前更大的值可通过加载，但 Node 可能将其缩短为一毫秒；现在配置验证会拒绝这些值。响应体读取期间期限到期现在报告 `WEB_TIMEOUT`，而不是 `WEB_ABORTED` 或 HTTP 错误。调用方取消仍为 `WEB_ABORTED`。

## 迁移

1. 检查 `cordis.yml`、补丁及已保存插件设置中的 `web-search-xai.config.timeoutMs`。将大于 `2147483647` 的值替换为受支持的整数。默认值仍为 `60000`。
2. 如果应用处理搜索错误，应对 HTTP 请求及响应体读取期间的期限到期均处理 `WEB_TIMEOUT`。
3. 启动现有 `dsh` 配置并确认插件可加载。响应体读取超过期限的搜索应以 `WEB_TIMEOUT` 失败。
