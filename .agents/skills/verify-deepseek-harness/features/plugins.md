# Open the Plugins panel

A user can reach the Web plugin manager and find the action for adding a plugin.

## Sub-features

- `open-manager` opens the Plugins panel from the sidebar.
- `find-add-action` checks that the panel exposes **Add plugin**.

## How to get to it (user POV)

In the sidebar's **Global panels** navigation, click **Plugins**.

## Driving it with Playwright

Use the [skill prerequisites](../SKILL.md#launch) and run `.agents/skills/verify-deepseek-harness/scripts/verify-web.mjs plugins` from the root.

- Click the **Plugins** button in **Global panels**. In `[data-plugin-panel]`, require the **Plugins** heading and **Add plugin** button to be visible. Compare `before` and `after` artifacts.

## Gotchas

- This path reads the panel and does not install a package. Installation and activation need a compatible bundle and separate evidence. For the fixture-backed journeys, use `pnpm run test:web:built apps/web/tests/plugin-manager.e2e.ts apps/web/tests/plugin-install-registry.e2e.ts`.
