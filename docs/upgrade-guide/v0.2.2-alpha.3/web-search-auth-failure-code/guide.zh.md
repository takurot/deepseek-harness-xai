---
kind: upgrade-guide
description: DeepSeek アカウントのサインインが拒否された場合、Web 検索と取得は WEB_PROVIDER_ERROR ではなく WEB_PROVIDER_AUTH_FAILED で失敗します。
---

# Web 検索と取得が認証失敗を報告する

[English](guide.md) | 中文

## 变更

Web 検索または取得に使った DeepSeek アカウントのサインインが拒否されたとき、`@deepseek-ai/dsh-web-search-deepseek` と `@deepseek-ai/dsh-web-deepseek-api` は `WEB_PROVIDER_ERROR` ではなく `WEB_PROVIDER_AUTH_FAILED` コードの `WebError` を投げます。メッセージとサインイン案内は変わりません。拒否されたアカウントトークンを検出するために `WEB_PROVIDER_ERROR` で分岐していたコード — 再試行ポリシー、ツールのエラー表示、`ctx.web.search`/`ctx.web.fetch` の呼び出し側 — は一致しなくなります。エンドポイント案内の経路を通る拒否された API キーは `WEB_PROVIDER_ERROR` のままです。

## 迁移

1. これらのプロバイダの `WEB_PROVIDER_ERROR` をサインイン拒否として扱っている箇所を `WEB_PROVIDER_AUTH_FAILED` で分岐するよう変更します。通信失敗、不正な応答、エンドポイント設定の失敗には `WEB_PROVIDER_ERROR` を残します。
2. コードを利用者に表示する場合は、`WEB_PROVIDER_AUTH_FAILED` を「再サインイン」導線に割り当て、エンドポイント設定は変更しません。
3. アカウントトークンの 401 がサインイン案内付きの `WEB_PROVIDER_AUTH_FAILED` になり、通信失敗は `WEB_PROVIDER_ERROR` のままであることを確認します。`pnpm exec vitest run packages/web/web-deepseek-api/tests packages/web/web-search-deepseek/tests` が両方をカバーします。
