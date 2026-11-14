# Run the fork with xAI search

English | [中文](fork-xai.zh.md)

This fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) adds experimental xAI search, CJK web-page decoding improvements, and an optional OS keychain credentials provider. Use this checkout to run these additions. The upstream `npx @deepseek-ai/dsh` distribution does not include the fork's additional source code.

## Prepare the checkout

Use Node.js 24.9 or later and pnpm. Follow the [development prerequisites](../development.md#setup-tutorial), including the native build requirements, then run these commands from this fork's root.

```sh
git clone https://github.com/takurot/deepseek-harness-xai.git
cd deepseek-harness-xai
pnpm install --frozen-lockfile
pnpm run build:artifacts
pnpm run build:check
```

The source CLI needs generated runtime artifacts. Repeat the build after changing source. The optional overlays below resolve explicit source paths relative to their own files, through the source CLI's ESM loader. Keep the overlays at their checked-in locations. They are checkout examples, not installable bundles or additions to default profiles.

## Enable xAI search

Provide `XAI_API_KEY` in your launch environment without putting its value in YAML or shell history. With the default DeepSeek conversation route, also provide `DEEPSEEK_API_KEY`. Search and conversation credentials are independent. Then run this command from the fork root.

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml "Search the web for xAI"
```

The [xAI overlay](../../apps/cli/config/examples/xai.yml) selects `web.searchProvider: xai` and inserts only the xAI search provider. It retains the registered DeepSeek providers. Explicit selection prevents ambiguity when both providers have keys. Each search makes an auxiliary Grok call and incurs xAI model and search charges. The [provider reference](../../packages/experimental/web-search-xai/README.md) owns configuration and failure details.

A successful search supplies answer text and cited source URLs to the conversation model. The final answer goes to stdout, and the tool result remains in the Session under `$DSH_HOME/sessions`. Without an xAI key, the selected provider withholds `web_search`; it does not fall back to DeepSeek. An invalid Config value such as `timeoutMs: 0` or a missing source plugin produces a startup warning and leaves xAI search inactive. Optional plugin failures follow the [startup policy](../../packages/boot/app-boot/README.md#startup-and-reload-failures). Correct the key or configuration and restart. Use `--dump-config-schema` to inspect plugin resolution; an unresolvable source plugin makes that command exit nonzero.

## Route the conversation through xAI

To use xAI for the conversation as well as search, add the [model overlay](../../apps/cli/config/examples/xai-model.yml). It configures the existing [pi-ai adapter](../../packages/llm/llm-pi-ai/README.md) with the `xai` route and `grok-4` model. The search provider has its own model configuration.

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml --patch apps/cli/config/examples/xai-model.yml "Search the web for xAI"
```

This route needs `XAI_API_KEY`. The keyless acceptance test verifies local configuration and tool execution with deterministic model and HTTP fixtures. It does not verify live xAI credentials, model availability, billing, or answer quality.

## Opt in to the OS keychain

On supported macOS or Linux hosts, add the [keychain overlay](../../apps/cli/config/examples/keychain.yml). Read the [platform prerequisites and credential precedence](../../packages/experimental/credentials-keychain/README.md#use-this-package) first. Linux needs `secret-tool` and a running Secret Service session. Windows and unsupported architectures use the default provider.

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/xai.yml --patch apps/cli/config/examples/keychain.yml "Search the web for xAI"
```

The overlay disables the existing `credentials` row and inserts an enabled `credentials-keychain` row. A patch’s `name` checks its target rather than replacing its implementation. This disable-and-insert pattern keeps only one credentials service active, including in headless mode. Existing plaintext keys are not migrated automatically. Keychain values take precedence over the launch environment, so check the selected store when an exported replacement key appears ineffective. Store initialization failures produce an inactive-plugin warning.

## Verify the checkout without API calls

After building, run the source-profile acceptance tests and recorded-session replay.

```sh
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/headless/tests/xai-source.built.e2e.ts
pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'fork-xai-search'
```

The source-profile round trip uses a fresh temporary Harness home and workspace. A separate test executes the documented `pnpm dsh` command from the fork root. They retain the shipped headless profile, Loader, web service, xAI provider, tool execution, and Session writer. Only external HTTP and conversation generation use fixtures. The negative cases cover a missing key, invalid Config, and an unresolvable plugin path. The recorded-session test replays the persisted tool result through the same headless profile.
