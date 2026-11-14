---
kind: upgrade-guide
description: "xAI search rejects timeout values above the Node timer limit and reports body-read deadlines as timeouts."
---

# xAI search timeout range and classification

English | [中文](guide.zh.md)

## Change

The experimental `web-search-xai` plugin accepts integer `timeoutMs` values from `1` to `2147483647`. Larger values previously loaded but Node could clamp them to one millisecond; they now fail configuration validation. Deadlines during response body reads now report `WEB_TIMEOUT` instead of `WEB_ABORTED` or an HTTP error. Caller cancellation remains `WEB_ABORTED`.

## Migration

1. Check `web-search-xai.config.timeoutMs` in your `cordis.yml` or patch and any saved plugin settings. Replace values above `2147483647` with a supported integer. The default remains `60000`.
2. If your application handles search errors, handle `WEB_TIMEOUT` for deadlines during both HTTP requests and body reads.
3. Launch your existing `dsh` profile and confirm the plugin loads. A search whose response body exceeds its deadline should fail with `WEB_TIMEOUT`.
