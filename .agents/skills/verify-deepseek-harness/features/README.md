# DeepSeek Harness Web verification map

Use the [verification skill](../SKILL.md) to build and drive the real Web profile. Start each recipe in its own empty DSH home through the helper. Treat the first-run UI, backend availability, and browser composition as prerequisites.

| Feature ID | User entry point | Observable result |
| --- | --- | --- |
| [appearance](appearance.md) | Account menu → Settings → General | Dark palette is restored in a fresh browser context |
| [workspace](workspace.md) | Sidebar → Add workspace | Adopted directory appears in Sessions in a fresh browser context |
| [plugins](plugins.md) | Global panels → Plugins | Plugins page and Add plugin action are visible |

The helper captures the selected path, browser state before and after, and a second authenticated view for the two mutations. For broader coverage, run the exact related Playwright spec named in each recipe and preserve its output. Report each entry point separately.
