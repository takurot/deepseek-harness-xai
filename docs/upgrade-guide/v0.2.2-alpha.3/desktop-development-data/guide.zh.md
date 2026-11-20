---
kind: upgrade-guide
description: "Desktop 开发版的默认数据目录移出构建目录，清理命令拒绝删除旧数据。"
---

# 升级时保留 Desktop 开发数据

[English](guide.md) | 中文

## 变更

未打包的 Desktop 启动器此前默认使用 `apps/desktop/.desktop-build/development/{home,electron-user-data}`，现改用 `apps/desktop/.desktop-dev/{home,electron-user-data}`，使仓库清理命令保留 Session（会话）、设置和 Electron 浏览器数据。已安装的 Desktop 不受影响，通过 `DSH_HOME` 或 `DSH_DESKTOP_USER_DATA_DIR` 显式指定的路径也不变。

## 迁移

1. 退出使用任一旧默认目录的所有进程，包括使用路径覆盖启动的 Desktop 开发实例。迁移或清理期间不要重新启动这些进程，也不要更改路径别名。确认自定义路径和路径别名不指向构建目录；清理命令只保护该目录内两处已知的旧路径。
2. 运行 `pnpm run dev:desktop`（已有构建产物时也可运行 `pnpm run start:desktop`）。只要新默认路径不存在，启动器就迁移对应且未被显式覆盖的旧目录。如果启动器无法检查路径别名，请改用直接路径覆盖默认值后重试。如果数据目录的锁阻止迁移，请先确认没有进程仍在使用该目录，再处理锁或手动迁移数据。在 Windows 上，即使已退出 Desktop，残留的 `lockfile` 也可能需要手动迁移。
3. 如果因目标目录已存在或路径被覆盖而留下旧目录，请将旧目录保存到 `.desktop-build` 之外，不要覆盖已有数据。若显式路径指向迁移前的位置，请更新该路径。只要任一旧默认目录仍存在，`pnpm run clean` 就拒绝删除任何文件，即使尚未启动升级后的版本。
4. 检查启动器输出的 `DSH_HOME` 和 `userData` 路径。运行 `pnpm run clean` 前，确认选定位置中有你需要的会话和设置。
