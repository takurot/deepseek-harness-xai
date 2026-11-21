---
name: verify-deepseek-harness
description: Verify DeepSeek Harness Web through a real local dsh server and Playwright Chromium. Use for browser acceptance, first-run troubleshooting, and evidence for settings, workspaces, or the Plugins panel.
---

# Verify DeepSeek Harness Web

Use the [feature map](features/README.md) to select a user journey. Web is the primary target. For Desktop, CLI, SDK, or real-provider turns, use the owning checks in the [testing guide](../../../docs/testing.md). Web evidence does not establish their behavior.

## Launch

From the repository root, use Node 24.9 or later, pnpm, Git, and `lsof` on macOS or Linux. Install dependencies with `pnpm install --frozen-lockfile` on a fresh checkout. Build the current sources with `pnpm run build:artifacts`. Install the pinned Chromium if it is missing with `pnpm --dir apps/web exec playwright install chromium`.

Run the helper with a feature ID from the map. For example:

```sh
.agents/skills/verify-deepseek-harness/scripts/verify-web.mjs appearance
```

The helper runs the built CLI as `node "$repo/apps/cli/lib/bin.js" web --patch "$repo/apps/web/tests/pin-browse-picker.overlay.yml" --host 127.0.0.1 --port 0 --no-open`, where `repo` is the checkout root. It starts in a new temporary directory with private `HOME`, `DSH_HOME`, and `DSH_AGENTS_HOME`. The CLI initializes the Web profile from shipped defaults. The helper passes no provider credentials, disables telemetry, and uses no repository or user `.env`. The existing overlay selects the in-page directory picker.

Each invocation owns its browser, server process, data directory, and OS-assigned port. On a fresh home, the helper clicks **Continue** in **Preview Notice** and **Close** in **Get started**. Fresh browser contexts dismiss the sign-in dialog again. It makes no model calls.

## Doctor

At the start of every helper run, require the built CLI version, current checkout revision, a login URL emitted by the child, and an `lsof` match between the assigned listening port and the child PID. Require HTTP 401 for the anonymous root, HTTP 200 for a fresh authenticated browser, and a visible application frame. The helper records the result in `run.log` before driving the selected feature. An HTTP response alone is insufficient.

When startup or rendering fails, read the failed run's `run.log`, `server.log`, and `browser-errors.log` before retrying. Rebuild if the artifacts predate the checkout. Treat browser errors and inactive-plugin startup warnings as failures. Diagnose only the isolated instance started for the run.

## Drive

The executable [verify-web.mjs](scripts/verify-web.mjs) accepts `appearance`, `workspace`, or `plugins`. Use the mapped role locators in the helper for additional Playwright assertions. Keep the browser locale at `en-US` for those names. For related scenarios, consult the [existing Web Playwright lane](../../../apps/web/tests/README.md), including its scaffold and real-host smokes.

Drive ordinary browser actions and assert the resulting UI. Observe changes from a second authenticated browser context when the journey promises persistence. For other mutations, confirm the affected file, stored record, or external operation through a read-only path. If a fixture is needed, put it at the existing external provider interface and record what it stands in for. For a dry-run journey, verify the absence of the specific writes, network calls, or ref changes that dry-run promises to skip.

## Evidence

The helper prints a unique directory under `.artifacts/dsh-web-verification/`. Keep `run.log` with the build and checkout identity, Doctor result, UI actions, assertions, and cleanup outcome. Keep the before and after screenshots and accessibility snapshots together. On failure, inspect the failure capture when available alongside the browser errors and redacted server log. Record which map entry and path each run exercises. Report an unmet prerequisite as a failed or unverified path.

When extending a journey, keep login URLs, cookies, and credentials out of screenshots, traces, filenames, and logs. Avoid exporting network traces from authenticated sessions unless credentials have been removed.

## Cleanup

The helper closes its Chromium instance and terminates only the child process it started. It waits for exit, removes its scratch directory, checks that the verification port has no listener, and reads the surviving `run.log` from the evidence directory. Cleanup also runs on journey failure and on SIGHUP, SIGINT, or SIGTERM. Each command should finish with a status and leave its printed evidence directory in place.
