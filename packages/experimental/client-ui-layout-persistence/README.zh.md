---
description: "实验性 Web 插件：在浏览器本地存储中恢复并保存界面框架的侧边栏与右侧面板宽度偏好。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-layout-persistence

[English](README.md) | 中文

## 概述

让 Web 界面框架的形状在页面重新加载后保持不变。它把整个框架的侧边栏偏好（关闭，或某个展开宽度）和右侧面板宽度偏好（从未打开，或某个宽度）保存在浏览器本地存储中，并在启动时应用一次。不注册工具、提示词段落、Session 事件或服务。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在提供 `layout` 和 `configForms` 的客户端组合中挂载。Host 行 id 为 `layout`，因此设置命名空间也是 `layout`。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `framePersistence` | `local` | `local` 在启动时恢复并保存变化；`off` 两者都不做，已在内存中的几何尺寸保持不变。 |
| `minPaneWidth` | `264` | 非零已保存宽度的像素下限，在布局自身的限制之前应用。 |

已保存的侧边栏为 `0` 时保持关闭，右侧面板宽度为 `null` 时保持未设置。

把模式切换为 `off` 也会取消待执行的保存。之后切回 `local` 只会恢复保存，不会覆盖当前布局。

### 最小配置

```yaml
- id: layout
  name: '@deepseek-ai/dsh-experimental-client-ui-layout-persistence'
```

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

记录保存在本地存储键 `dsh.frame-layout.v1` 下，内容为 `{ "version": 1, "sidebar": number, "rightbar": number | null }`。收到就绪的 `layout` 设置快照后（没有就绪快照时插件不执行任何操作），启动时读取一次，校验版本以及每个宽度是否为有限的非负数（`rightbar` 也可为 `null`），把非零宽度抬高到 `minPaneWidth`，再调用 `restoreFrameGeometry`。之后 `frameGeometry` 的变化按 200 毫秒防抖，一次拖动只写一次，几何尺寸未变时不重复写入。

记录缺失、损坏、版本不符或类型错误时，会删除该记录，保持默认布局，并记录一条警告。存储不可用、读取失败或写入失败同样只记录一次，不会打断界面；写入失败后，之后的变化仍会再次尝试写入。

不持久化的内容：右侧面板的停靠、标签页和全屏状态由 `@deepseek-ai/dsh-client-ui-sidebar-right` 负责，它已按 Session 保存这些状态。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | Host `Config` 与设置注册 |
| `src/settings.ts` | 命名空间、默认值和设置类型 |
| `src/client/index.ts` | 设置订阅与存储访问 |
| `src/client/persistence.ts` | 一次恢复、防抖保存、模式切换 |
| `src/client/storage.ts` | 键、版本、校验和序列化 |

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [`@deepseek-ai/dsh-client-ui-layout`](../../client/ui-layout/README.zh.md) — 持有本包保存和恢复的框架几何尺寸。
- [`@deepseek-ai/dsh-client-ui-sidebar-right`](../../client/ui-sidebar-right/README.zh.md) — 持有右侧面板按 Session 的状态。

-----

<a id="model-experience"></a>
## 模型体验

无，插件只在浏览器中保存两个窗口宽度；不注册工具、提示词段落或模型输入。

#### KV 缓存影响

无影响。本包从不构造模型请求，也从不修改提示词。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **实验性。** 本包不承诺产品支持，默认 Web 包也不挂载它。
- **按浏览器配置。** 本地存储按源隔离，布局不会跟随用户跨浏览器或设备。
- **关闭标签页前 200 毫秒内的改动可能丢失。** 卸载时会丢弃待执行的写入。
- **没有录制会话快照。** 本插件只在浏览器端运行，不写入任何 Session 事件；jsdom 单元测试覆盖恢复、钳制、损坏值、`off` 与存储故障。
- **尚无专用设置页。** 这两个字段目前通过通用的 Host 插件配置界面呈现，没有独立的本地化页面，因此议题验收项 7（由词典支持的设置标签）延后；当前路径是把本包作为可选 bundle 行启用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本插件只恢复框架自身持有的两个宽度偏好；右侧面板的展开、停靠与全屏状态按 Session 由 `ui-sidebar-right` 持有，因此两个持久化存储不会写入同一字段。

</details>
