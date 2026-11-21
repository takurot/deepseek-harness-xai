# Add a workspace

A user can adopt an existing directory as a Web workspace and find it again in Sessions.

## Sub-features

- `adopt-directory` selects a staged directory through the in-page directory picker.
- `restore-workspace` opens a fresh browser context and checks the Sessions tree.

## How to get to it (user POV)

Click **Add workspace** in the sidebar. In **Select Workspace Directory**, select the folder from the listing and click **Open**.

## Driving it with Playwright

Use the [skill prerequisites](../SKILL.md#launch) and run `.agents/skills/verify-deepseek-harness/scripts/verify-web.mjs workspace` from the root.

- Select the staged `verification-workspace` directory from the initial home listing. Require its folder button to become current before clicking **Open**. Require the picker to close and the workspace row to appear in **Sessions**.
- In the fresh view, require the workspace row to remain visible. Compare `before`, `selected-directory`, `added`, and `after` artifacts.

## Gotchas

- The in-page picker is selected by the existing overlay. Native chooser behavior requires a separate run.
- An empty credential store permits workspace registration without proving model availability. For the path editor, folder creation, renaming, or session grouping, use `pnpm run test:web:built apps/web/tests/workspace-management.e2e.ts`.
