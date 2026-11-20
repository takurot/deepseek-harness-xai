---
kind: upgrade-guide
description: "Desktop development defaults move out of the build tree, and clean refuses to delete legacy state."
---

# Preserve Desktop development data when upgrading

English | [中文](guide.zh.md)

## Change

The unpackaged Desktop launcher used `apps/desktop/.desktop-build/development/{home,electron-user-data}` by default. It now uses `apps/desktop/.desktop-dev/{home,electron-user-data}` so repository clean leaves Sessions, settings, and Electron browser data in place. Installed Desktop and paths explicitly set through `DSH_HOME` or `DSH_DESKTOP_USER_DATA_DIR` are unchanged.

## Migration

1. Quit all processes that use either legacy default, including Desktop development instances launched with overrides. Do not start them again or change path aliases while migrating or cleaning. Check that custom paths and aliases do not point into the build tree; clean protects only the two known legacy paths there.
2. Run `pnpm run dev:desktop` (or `pnpm run start:desktop` if artifacts are already built). The launcher moves each unoverridden legacy directory to its new default if that destination does not exist. If the launcher cannot check a path alias, use a direct path for the override before retrying. If a profile lock blocks migration, verify no process still uses the profile before handling the lock or moving the data manually. A stale Windows `lockfile` may require manual migration even after Desktop quits.
3. If a legacy directory remains because its destination already exists or an override skipped it, save that legacy directory outside `.desktop-build` without overwriting existing data. Update any override that referred to the moved location. `pnpm run clean` refuses to delete anything while either legacy default remains, even before the first upgraded launch.
4. Check the `DSH_HOME` and `userData` paths printed by the launcher. Verify that the Sessions and settings you expect are in the selected locations before running `pnpm run clean`.
