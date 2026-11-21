# Appearance

A user can select the Web theme in Settings and see that preference in a fresh browser.

## Sub-features

- `change-palette` selects Dark and checks that the active appearance control and page palette change.
- `restore-palette` opens a fresh browser context and checks that the host restores the preference.

## How to get to it (user POV)

Open the sidebar **Account menu**, choose **Settings**, and select **Dark** in the **Appearance** row in **General**.

## Driving it with Playwright

Use the [skill prerequisites](../SKILL.md#launch) and run `.agents/skills/verify-deepseek-harness/scripts/verify-web.mjs appearance` from the root.

- On the first view, click the **Account menu** button, the **Settings** menu item, and the **Dark** button in the **Settings** dialog. Require the control to be pressed and `body[data-ds-dark-theme]` to be visible.
- In the fresh view, open the same dialog and require the same state with a different browser context. Compare `before`, `changed`, and `after` artifacts.

## Gotchas

- The browser's preferred theme is fixed to light so the Dark result depends on the app preference.
- For system theme, alternative close paths, or persistence across a different server port, use `pnpm run test:web:built apps/web/tests/settings-chrome.e2e.ts`.
