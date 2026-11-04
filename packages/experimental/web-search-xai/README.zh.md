---
description: "ctx.web 的 xAI 搜索提供方：部署如何通过 Responses API 挂载 Grok 服务端网页与 X 搜索，并在每次搜索时解析凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-xai

[English](README.md) | 中文

## 概述

使用 `dsh-web-search-xai` 后，harness 通过 xAI 服务端的 `web_search` 和 `x_search` 工具，使用 `XAI_API_KEY` 搜索网页，也可选择搜索 X。当部署通过 xAI 或其他非 DeepSeek 提供方路由模型、又希望保留 `web_search`，并接受一次搜索就是一次完整的 Grok 模型调用外加按次计费的搜索费用时，选择它。回答文本成为 `content`，结构化的 `url_citation` 注解成为 `sources[]`；绝不从回答文本中提取 URL。没有密钥时该提供方未就绪，因此 `dsh-tool-web` 会对该请求隐藏 `web_search`；响应没有引用时以结构化错误失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载该提供方。它以 `xai` 搜索提供方注册，因此当它是唯一可用的搜索后端时 `ctx.web.search()` 会自动选中它，也可用 `searchProvider: xai` 固定选择。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-xai'
  config:
    apiKeyEnv: XAI_API_KEY
    sources: [web, x]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 xAI API 密钥；优先使用 `apiKeyEnv`，避免密钥进入配置。非空字面值优先于 `apiKeyEnv` |
| `apiKeyEnv` | `XAI_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；没有该服务时从进程环境读取。搜索找不到密钥时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败 |
| `baseURL` | `https://api.x.ai/v1` | Responses API 基址，会追加 `/responses`。无法解析的值会使该提供方不可用 |
| `model` | `grok-4.7` | 执行搜索回合的 Grok 模型 |
| `sources` | `[web]` | 启用的服务端工具：`web` 加入 `web_search`，`x` 加入 `x_search`。空列表会使该提供方不可用 |
| `timeoutMs` | `60000` | 整个请求的超时；到期以 `WEB_TIMEOUT` 失败 |

生成的[配置目录](../../../docs/config-catalog.zh.md)列出所有可接受的字段。

### 搜索返回什么

`content` 是响应中各 `output_text` 的拼接。`sources[]` 为每个不同的 `url_citation` 注解保留一条仅含 URL 的条目；xAI 注解的 `title` 是可见的引用编号，因此不用作标题。服务负责执行 `maxResults`。没有 `url_citation` 的响应以 `WEB_PROVIDER_ERROR` 失败。

### 失败与恢复

HTTP 401 与 403 以 `WEB_PROVIDER_AUTH_FAILED` 失败，429 以 `WEB_PROVIDER_RATE_LIMITED` 失败，其他状态与传输失败以 `WEB_PROVIDER_ERROR` 失败，超时为 `WEB_TIMEOUT`，取消为 `WEB_ABORTED`。重定向视为错误。

<a id="understand-the-implementation"></a>
## 理解实现

`provider.ts` 包含 HTTP 调用与响应映射；`index.ts` 包含 `Config`、凭据解析与注册。`ready()` 通过 `ctx.credentials.describe`（没有该服务时通过启动环境）检查密钥是否存在，不发起网络调用，因此错误的密钥也视为就绪，并让每次调用失败。请求经过进程级代理分发器。

<a id="further-exploration"></a>
## 进一步探索

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 搜索请求/结果词汇与错误码。
- [Web 包地图](../../web/README.zh.md) — web 包家族。
- [dsh-web](../../web/web/README.zh.md) — 该提供方注册到的 web 服务。
- [dsh-tool-web](../../web/tool-web/README.zh.md) — 面向模型的 `web_search` 工具。
- [dsh-web-search-deepseek](../../web/web-search-deepseek/README.zh.md) — 本包所对照的 DeepSeek 版本。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助 xAI 搜索请求

#### 模型看到的内容

另一个 Grok 模型接收 `Perform a web search for the query: <query>` 作为输入，以及已启用的服务端搜索工具。该请求不属于对话模型的上下文。

#### Token 影响

每次搜索都会产生独立的提供方输入与输出 token，外加 xAI 按次计费的搜索费用（网页搜索按调用计费；X 搜索按获取的帖子或用户资料计费，依 xAI 定价页）。

#### KV Cache 影响

与对话请求的缓存相互独立。

### 间接的会话工具结果

#### 模型看到的内容

通过 `dsh-tool-web`，对话模型看到回答文本与去重后的来源 URL。失败以上述消息呈现：`xAI API error (HTTP <status>)` 及 xAI 的详情、`xAI search timed out after <n> ms`、`xAI search aborted`、`xAI returned no cited sources; ...`，以及指明凭据引用的缺少密钥消息。

#### Token 影响

注册本身不产生直接的对话 token。结果 token 随回答长度与返回的来源数量增长。

#### KV Cache 影响

仅追加；新出现的内容位于可复用的请求前缀之后。

### 会话工具列表（间接）

#### 模型看到的内容

选中该提供方期间，若它未就绪，请求既不带 `web_search` 模式也不带其提示指引；该效果由 [`dsh-tool-web`](../../web/tool-web/README.zh.md#search-readiness) 负责。

#### Token 影响

隐藏会从请求中去掉 `web_search` 模式与指引。

#### KV Cache 影响

`web_search` 的恢复或移除会按 `dsh-tool-web` 所述改变声明的工具。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一次搜索就是一次完整的 Grok 模型调用** — 带来延迟、token 与按次费用；专用检索 API 会更便宜。
- **就绪检查只看存在性，不看有效性** — 错误的密钥也视为就绪，每次调用以 `WEB_PROVIDER_AUTH_FAILED` 失败。
- **来源仅含 URL** — xAI 的注解不带页面标题、日期或摘要。
- **默认模型名未对照线上 API 验证** — 它沿用 xAI 文档的示例；本仓库 CI 尚未运行真实 API 测试（`XAI_API_KEY`）。
- **`x_search` 按获取的条目计费** — 启用 `x` 的搜索成本不受一次调用的限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具权威性——已交付的行为、限制与理由见上文各节及所链接的 Agent Note。

#### 同模板的其他搜索后端

Tavily 或 Brave 等纯检索 REST API 可以沿用同一提供方形状（`ready()` 只检查凭据，`search()` 把结果映射到 `sources[]`），且比整次模型调用更便宜；尚未实现，也未验证其响应字段。

</details>
