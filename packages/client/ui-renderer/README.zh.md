---
description: "浏览器 UI 渲染器：普通 Slot 与可复用 Component Factory 的 React 绑定、ctx.uiRenderer 与组装后的 dsh Web 应用根。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-renderer

[English](README.md) | 中文

## 概述

`dsh-client-ui-renderer` 挂载组装完成的 dsh Web 客户端 GUI：完整客户端插件名册稳定后，启动内核调用 `ctx.uiRenderer.mount(container)`，它会 hydrate 不依赖框架的启动页，并在下一次绘制前切换到完整的 React 应用。业务插件仍是接收类型化 props 的普通 React 组件，通过 props 获取会话与 Workspace 数据，永远不需要自行接线订阅——渲染器在 slot outlet 处把运行时的裸 observable source 绑定为 selector 钩子。Web 外壳与启动内核是它仅有的直接消费方，因此只要组合需要 React 渲染的 GUI，就需要它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [渲染失败与诊断](#render-failures-and-diagnostics)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包属于基础设施：Web 外壳与启动内核是它仅有的直接消费方。只要组合需要 React 渲染的 GUI，就需要它——`dsh-client-web` 加载名册，等待名册稳定且启动审计通过，然后调用 `ctx.uiRenderer.mount(container)`。

### 挂载做什么

`mount(container)` 会安装 slot 渲染器、在存在时 hydrate 现有启动 DOM、在下一次绘制前把组装后的应用渲染进容器，并返回一个卸载 React 根的 disposer。渲染器执行全程序唯一一次上下文级 `renderSlot('root')` 调用；注册的根占用方拥有产品布局与文档元数据。

### 对业务插件

业务插件注册普通 Slot entry 或可复用 Component Factory；渲染器在渲染位置把运行时的会话与 Workspace observable source 绑定为 selector 钩子。插件通过推导出的 Component props 收到标准 scope props——它绝不导入渲染器，也不触碰 React 内部机制。每个由 renderer 创建的 Component 都能渲染 Factory occurrence，Factory 也能暴露由调用方选择的局部 Component，而无需在包之间共享实现值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包实现一条边界：对象层（运行时，无 React）拥有业务状态；这里是 ctx 到 React 集成唯一发生的位置——slot 渲染器、`SessionProvider` 与 `useSyncExternalStore` 适配器。

### 激活与挂载

插件在 `slots`、`sessions` 与 `layout` 就绪后激活；它安装 `createSlotRenderer()` 并 reflect `uiRenderer` 服务。`mountApp` 会查找启动内核的 `[data-dsh-boot]` 元素：存在时经 `BootHandoff`（一个保留加载 DOM 的单帧透传）hydrate，否则创建全新的根节点并同步提交渲染。

### Slot 绑定

`createSlotRenderer` 把 slot 注册表连接到 React：普通 entry list 与 Factory definition 成为响应式 source，每个 outlet 或 occurrence 经已安装的渲染器渲染。业务插件通过带类型的 `hooks` 传递裸 observable source；渲染器经 uSES 适配器在渲染位置完成绑定。Factory Store factory 保持 lazy，直到 occurrence 首次物化时才创建 handle；其 exclusive handle 拒绝持久化，渲染期记录保持弱引用，幂等 effect 仅强引用 mounted occurrences，同时在 effect replay 期间保留 identity。Factory 错误使用普通监督通道且不会 abdicate 共享 definition：definition 及其 fallback 局部 Component 的失败归属 definition，调用方所选局部 Component 的失败归属调用方 registration，每个边界随自身 scope incarnation 重置。

### 身份

React、React DOM、Cordis、ui-slots 与 ui-primitives 通过 Web 外壳的静态模块表保持同一浏览器身份；本包则以动态客户端 bundle 的形式加载。

</details>

-----

<a id="render-failures-and-diagnostics"></a>
## 渲染失败与诊断

`root` 注册在渲染时崩溃不会再留下空白页面。当所有根注册都已 abdicate 时，`RootOutlet` 会渲染一个独立的失败界面：本地化的标题与说明、重新加载控件，以及带复制控件的可折叠诊断视图。该界面不依赖任何 slot、store、应用框架或 Session 数据，因此损坏的树无法阻止它渲染。`RootFailureBoundary` 只包裹渲染器自身的根子树，用于捕获在 entry 边界之外抛出的管线错误；`SlotAssemblyError` 仍会重新抛出，使装配错误的启动直接失败，而不是退化为该界面。被包含的子 slot 崩溃保持现有的逐 entry 隔离，永远不会到达该界面。

文案区分浏览器渲染失败与服务器断开：本地服务器仍在运行，重新加载既不会重启服务器，也不会删除 Session 数据。

### 诊断记录

渲染器在浏览器 `localStorage` 的 `dsh.render-failure.v1` 键下记录每次顶层失败；该键保存从新到旧的 JSON 数组，`src/client/render-failure-log.ts` 中的 `readRenderFailures()` 是内部读取路径（包的公开 `/client` 入口不会重新导出它，开发者通过浏览器开发者工具读取该键）。每条记录为 `{ at, name, message, stack, slot }`：ISO-8601 失败时间、错误名称、错误消息、堆栈，以及渲染失败的 slot（应用根为 `root`）。环形缓冲最多保留三条记录，每条约 4 KB（`message` 最多 512 字符，`stack` 最多 3072 字符）；更旧的记录会被替换。写入前会脱敏类令牌片段（`sk-…` 密钥、bearer/basic 凭据、`token=`/`password=`/`authorization` 值，以及不含路径分隔符或连字符的高熵字母数字串），因此堆栈帧中的插件路径与 URL 得以保留。记录器的字段仅为时间、错误名称、消息、堆栈和插槽：提示词、会话正文、凭据与组件属性绝不作为字段收集。由于错误消息或堆栈是任意文本，其中的类令牌文本只会尽力脱敏，无法保证完全不存在。

记录是尽力而为的：当 `localStorage` 不可用或抛出异常（隐私模式、配额、沙箱 iframe）时，失败界面仍会显示刚发生失败的内存记录，并把保留说明替换为“仅从内存显示”的提示；该失败不会为后续重新加载持久化。诊断信息仅存在于浏览器配置文件中，不会被上传，也不会在启动时被读取。

失败界面的文案来自 `renderer` locale 命名空间（全部八种内置语言）。失败时若 locale 服务不可用（启动顺序失败），界面使用英语字典阶梯，缺失的键按原键名渲染。

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖周边机制与组合模型。

- [ui-slots](../ui-slots/README.zh.md)——本渲染器绑定到 React 的 slot 注册表纯核心。
- [web](../web/README.zh.md)——加载名册并调用 `mount` 的外壳。
- [ui-session](../ui-session/README.zh.md)——提供本渲染器所绑定标准会话 source 与钩子的适配器。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——加载链、对象层与分层红线。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威组合模型。
- [Component Factory](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.zh.md)——可复用 definitions、局部 Component 选择与 occurrence 生命周期。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端渲染组装层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明应用首帧何时出现、按区域就绪能走多远；它们是当前包约束。

- **应用首帧会等待整个客户端名册**：启动内核只在 loader 名册稳定且启动审计通过后交出挂载点；按区域就绪仍属暂缓事项。
- **slot 渲染没有 Suspense 集成或逐 entry 惰性加载**：完整插件名册稳定后，渲染器才挂载根节点。
- **失败界面只覆盖 React 渲染失败**：客户端名册挂载完成前的失败（例如 bundle 未能加载）由启动页负责，此 React 树之外的失败仍需手动重新加载或外部诊断。
- **诊断是尽力而为且仅限本地**：拒绝存储会失去持久化，环形缓冲只保留三条有界记录，脱敏只能减少而无法消除抛出的错误可能携带的敏感文本。
- **原始黑屏原因尚未查明**：该界面改变失败表现并保留证据，并非对未复现故障本身的修复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
