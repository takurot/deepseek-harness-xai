# 使用 xAI 搜索运行此 fork

[English](fork-xai.md) | 中文

此 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) fork 提供实验性 xAI 搜索、CJK 网页解码改进和可选的操作系统钥匙串凭据提供方。请使用此源码检出来运行这些功能。上游 `npx @deepseek-ai/dsh` 分发不包含此 fork 新增的源码。

## 准备源码检出

使用 Node.js 24.9 或更高版本和 pnpm。先满足[开发前置条件](../development.zh.md#setup-tutorial)，包括原生构建要求，再在此 fork 根目录执行以下命令。

```sh
git clone https://github.com/takurot/deepseek-harness-xai.git
cd deepseek-harness-xai
pnpm install --frozen-lockfile
pnpm run build:artifacts
pnpm run build:check
```

源码 CLI 需要生成的运行时产物。修改源码后请重新构建。以下可选覆盖层通过源码 CLI 的 ESM 加载器解析相对于各自文件的显式源码路径。请保留覆盖层的检入位置。这些是源码检出示例，不是可安装的 bundle，也不属于默认配置档案。

## 启用 xAI 搜索

在启动环境中提供 `XAI_API_KEY`，不要将其值写入 YAML 或 shell 历史。使用默认 DeepSeek 对话路由时，还需提供 `DEEPSEEK_API_KEY`。搜索和对话凭据彼此独立。然后在 fork 根目录执行以下命令。

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml "Search the web for xAI"
```

[xAI 覆盖层](../../apps/cli/config/examples/xai.yml) 选择 `web.searchProvider: xai`，并仅插入 xAI 搜索提供方。它保留已注册的 DeepSeek 提供方。当两个提供方都有密钥时，显式选择可避免歧义。每次搜索都会发起一次辅助 Grok 调用，并产生 xAI 模型和搜索费用。[提供方参考](../../packages/experimental/web-search-xai/README.zh.md) 说明配置和失败详情。

成功的搜索会向对话模型提供答案文本和引用来源 URL。最终答案写入 stdout，工具结果保存在 `$DSH_HOME/sessions` 下的 Session 中。没有 xAI 密钥时，选中的提供方会隐藏 `web_search`，不会回退到 DeepSeek。`timeoutMs: 0` 等无效 Config 值或源码插件缺失会产生启动警告，使 xAI 搜索保持未激活状态。可选插件失败遵循[启动策略](../../packages/boot/app-boot/README.zh.md#startup-and-reload-failures)。请修正密钥或配置后重启。使用 `--dump-config-schema` 检查插件解析；无法解析源码插件会使该命令以非零状态退出。

## 将对话路由到 xAI

若要同时使用 xAI 进行对话和搜索，请添加[模型覆盖层](../../apps/cli/config/examples/xai-model.yml)。它为现有 [pi-ai 适配器](../../packages/llm/llm-pi-ai/README.zh.md) 配置 `xai` 路由和 `grok-4` 模型。搜索提供方使用独立的模型配置。

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml --patch apps/cli/config/examples/xai-model.yml "Search the web for xAI"
```

此路由需要 `XAI_API_KEY`。无密钥验收测试通过确定性的模型和 HTTP fixture 验证本地配置和工具执行。它不验证真实 xAI 凭据、模型可用性、计费或答案质量。

## 选择使用操作系统钥匙串

在受支持的 macOS 或 Linux 主机上，添加[钥匙串覆盖层](../../apps/cli/config/examples/keychain.yml)。请先阅读[平台前置条件和凭据优先级](../../packages/experimental/credentials-keychain/README.zh.md#use-this-package)。Linux 需要 `secret-tool` 和正在运行的 Secret Service 会话。Windows 和不支持的架构使用默认提供方。

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml --patch apps/cli/config/examples/keychain.yml "Search the web for xAI"
```

该覆盖层禁用现有 `credentials` 条目，并插入已启用的 `credentials-keychain` 条目。补丁的 `name` 用于检查目标，而不是替换其实现。这种先禁用再插入的方式保证只有一个凭据服务激活，包括在 headless 模式下。现有明文密钥不会自动迁移。钥匙串值的优先级高于启动环境，因此导出的替代密钥看似无效时，请检查选中的存储。存储初始化失败会产生插件未激活警告。

## 无需 API 调用即可验证源码检出

构建后，运行源码配置档案验收测试和记录会话重放。

```sh
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/headless/tests/xai-source.built.e2e.ts
pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'fork-xai-search'
```

源码配置档案往返测试使用全新的临时 Harness 主目录和工作区。另一个测试在 fork 根目录执行文档中的 `pnpm dsh` 命令。它们保留已发布的 headless 配置档案、Loader、web 服务、xAI 提供方、工具执行和 Session 写入器。仅外部 HTTP 和对话生成使用 fixture。负面用例覆盖密钥缺失、无效 Config 和无法解析的插件路径。记录会话测试通过同一 headless 配置档案重放持久化的工具结果。
