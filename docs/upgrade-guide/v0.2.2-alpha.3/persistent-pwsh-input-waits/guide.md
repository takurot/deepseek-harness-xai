---
kind: upgrade-guide
description: "Persistent pwsh no longer returns early for input waits in the shell process group."
---
# Persistent pwsh input waits

English | [中文](guide.zh.md)

## Change

Persistent `pwsh` commands distinguish their own start and completion output from a previous command's delayed prompt. On backends with native stdin-wait detection, `Read-Host` and reads in the shell's process group could previously return partial output before completion. These reads now wait until `timeoutMs` and reset the shell. A proven input wait in a different foreground process group can still return partial output.

## Migration

1. Change automation that calls `Read-Host` to receive its values through arguments or environment variables. Supply these values before calling `pwsh`.
2. For interactive work, use a deployment exposing the [terminal tools](../../../../packages/experimental/tool-terminal/README.md) with a pwsh backend. Send input with `terminal_send` rather than another persistent `pwsh` command.
3. Confirm the automated command returns its own output and the next command retains the expected directory and environment. A timeout reports the shell reset; initialize required state again after that result.
