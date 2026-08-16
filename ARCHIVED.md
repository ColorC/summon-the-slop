# 本仓库已于 2026-08-16 归档

用户裁决：overlay-shell / poof 长期放弃，完全归档。

- **归档副本**：`E:\WindowsWorkspace\_archive\overlay-shell`（完整含 git 历史）
- 本目录因尚有其他 agent 会话的 shell 占用而暂存，**占用解除后可直接删除**
- 画布渲染引擎（notes-web）已迁出使用路径：dashboard/workshop 的画布页现为 workshop 原生视图（`spark.workshop/workshop/web/src/views/MaterialNotesView.vue`）
- dashboard 的 ui-update 流水线已自带守卫：本目录不存在时自动跳过引擎构建
- 任何 agent 不要在本目录启动、调试或重建 overlay-shell.exe

## 2026-08-17 终局退役

- 现役目录 `E:\WindowsWorkspace\overlay-shell` 已整体删除; 本归档副本是唯一残留。
- 删除前已 fetch 现役仓全部提交(含 2026-08-16/17 的归档与误修提交), 见分支 `archived-live-final`。
- 唯一仍存活的产物 notes-web(画布/文档/审阅三视图)真源已移植到
  `omnicompany/src/omnicompany/dashboard/notes-web/`, 由 dashboard ui-update 构建、
  8210 `/lofa/overlay/app/` 与 workshop `/canvas-app/`(L2 直读同一份 dist-web)服务。
- 桌面壳职责由 Omnicompany Desktop(`omnicompany/src/omnicompany/desktop`)承担,
  与本仓无关。任何 agent 不得复活、重建或重新引用 overlay-shell。
