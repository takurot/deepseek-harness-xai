# Agent Note: Top-level render failures show a recovery screen, not a blank page

Status: implemented

[English](2026-11-22-root-render-failure-fallback.md) | 中文

## Problem

2026-11-19，Web 客户端显示为空白黑页，而本地服务器仍在同一进程中运行；浏览器重新加载后界面恢复。抛出的异常与触发操作都没有被记录，因此该故障未能复现。

渲染器的根路径上存在两个缺口。第一，渲染期间崩溃的 `root` 注册由 `SlotErrorBoundary` 包含：它通过 `onEntryError` 报告崩溃并让该 entry abdicate；随后 `RootOutlet` 看不到存活的根 entry，但发现注册仍在账本上，于是返回空的 `<div data-slot-error="root" />`。用户既得不到说明，也没有恢复操作。第二，在 entry 边界之上抛出的渲染器管线错误完全没有边界，React 会卸载整个应用。两条路径都没有留下重新加载后仍可取得的证据。

## Decision

**dry-root 分支拥有用户可见的失败界面。** `RootOutlet` 在报告 abdication 之前，把根 entry 的 `onEntryError` 最近一次已脱敏记录保存在 ref 中；dry-root 分支用该记录加上已存储的环形记录渲染 `RootFailure`。失败界面不依赖任何 slot、store、应用框架或 Session 数据：它是固定在视口上的面板，用语义化主题令牌着色，因此损坏的布局树无法把它遮住。界面显示本地化标题与说明、默认调用 `location.reload` 的重新加载控件，以及带复制控件的 `<details>` 诊断视图。剪贴板拒绝会被捕获，详情文本保持可选中，因此仍可手动复制诊断信息。

**独立的 `RootFailureBoundary` 只捕获渲染器管线错误。** 它包裹 `RootOutlet`（连同 scope provider），用于在 entry 边界之外抛出的错误。`SlotAssemblyError` 会从 `getDerivedStateFromError` 重新抛出，因此装配错误的启动仍直接失败；被包含的子 slot 崩溃保持现有的逐 entry 隔离，永远不会到达失败界面。界面文案说明这是浏览器的渲染失败，而不是服务器断开：本地服务器仍在运行，重新加载既不会重启服务器，也不会删除 Session 数据。

**诊断有界、已脱敏且仅限本地。** 渲染器把每次顶层失败记录在浏览器 `localStorage` 的 `dsh.render-failure.v1` 键下，并从诊断模块导出 `readRenderFailures()`。记录为 `{ at, name, message, stack, slot }`：ISO-8601 时间、错误名称、错误消息、堆栈，以及渲染失败的 slot（应用根为 `root`）。环形缓冲最多保留三条记录，每条约 4 KB（`message` 最多 512 字符，`stack` 最多 3072 字符）。写入前会脱敏类令牌片段：`sk-…` 密钥、bearer/basic 凭据、`token=`/`password=`/`authorization` 值，以及较长的类密钥串。记录器只接收抛出的值和 slot 标签；它绝不读取提示词、会话正文、凭据或组件属性。存储是尽力而为的：`localStorage` 缺失或抛出异常时，内存记录仍会驱动失败界面，且不会持久化。启动时没有任何代码读取这些记录。

**失败界面文案接入类型化 locale 系统。** 新增的 `renderer` 命名空间携带全部八种内置语言字典。`apply` 通过 `ctx.inject(['locale'])` 创建的子 fiber 注册它们，而不是硬写 `inject: ['locale']`：locale 插件 inject 了 `slots`，而 `slots` 正是本包在自身 `apply` 中提供的服务，所以直接依赖 locale 服务会让两个 fiber 永久等待。失败时先查询已安装的 locale face；没有 face、查询未命中，或绑定/查询抛出异常时，由英语字典阶梯回答，未知键按原键名渲染。

## Alternatives considered

**在应用外层加一个新边界，并保持 `RootOutlet` 不变。** 否决：根崩溃已经由 entry 边界包含并 abdicate，外层边界根本不会运行；上报路径中留下的仍是空的 `<div data-slot-error="root" />`。

**不重新加载，而是在原地重新挂载根节点重试。** 否决：崩溃可能在边界背后留下损坏的内存状态，重试循环会掩盖持续故障；重新加载是显式、由用户控制的恢复方式，同时还能证明服务器仍在提供服务。

**把诊断上传到服务器或遥测接收端。** 否决：渲染失败可以从浏览器配置文件中诊断，文案已经区分浏览器故障与服务器故障，上传还会引入 Issue 明确限制的隐私面。

**持久化完整错误对象、序列化 props 或 Session 上下文。** 否决：它们会携带提示词、会话正文与组件属性。记录只保留错误自身的名称、消息和堆栈，并且有界、已脱敏。

**保留无界日志，或让每个字段保持完整长度。** 否决：`localStorage` 很小且与其他功能共用；无界环形记录会挤掉无关数据，而过长的堆栈在最初几帧之后没有诊断价值。

**把包的 `inject` 直接改成 `['locale']`。** 否决：硬依赖会造成激活死锁，因为 locale 插件等待本包提供的 `slots`。用 `ctx.inject` 创建的子 fiber 等待该服务，同时不让渲染器依赖它。

**在存储中存在失败记录时自动恢复。** 否决：记录无法区分瞬时崩溃与持续故障，自动重新加载循环比一次显式的重新加载更糟。

## Consequences

- 顶层渲染崩溃现在会留下本地化说明、重新加载控件与诊断详情，而不是空白页面；健康的根与被子 slot 包含的崩溃保持原有行为。
- 重新加载后最多保留三条有界记录；即使存储被拒绝，失败界面仍显示最新的内存记录。脱敏与截断只能减少、无法消除抛出的错误可能携带的敏感文本。
- 失败界面覆盖已挂载 React 树内部的渲染失败。名册挂载前的失败（例如 bundle 从未加载）由启动页负责，此树之外的失败仍需手动重新加载或外部诊断。
- 原始黑屏原因仍未得到证实。本次变更改变失败表现并保留证据，并未声称修复了未复现的故障。
- 不改变 Session 数据、服务器进程或 wire 格式；由于 harness 没有故障注入机制，不新增录制会话快照。

## Related

[Locale-owned client UI copy](../architecture/2026-08-23-locale-owned-client-ui-copy.zh.md) 拥有失败界面遵循的命名空间/`t` 纪律。[slot 系统标准](../architecture/2026-07-22-slot-type-chain-implementation.zh.md) 拥有 entry 边界与根 slot。

## Testing

- `packages/client/ui-renderer/tests/root-failure.client.spec.tsx` 覆盖：抛出的根注册触发失败界面、记录在重新加载后可读、已安装 locale 的文案与英语阶梯、健康根与被子 slot 包含的崩溃、存储被拒绝、重新加载与复制控件（含剪贴板拒绝）、管线边界、重新抛出的装配错误、环形保留、脱敏、4 KB 上限、损坏存储，以及字典注册。
- `packages/client/ui-renderer/tests/factory-slots.client.spec.tsx` 把过时的 `data-slot-error="root"` 断言改为失败界面。
- 现有 `scoped-slots.client.spec.tsx` 套件继续覆盖部分 slot 隔离与启动顺序装配错误。
