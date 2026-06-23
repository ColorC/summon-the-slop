# ctxmenu — poof 右键菜单管理 CLI (Windows)

管理 Windows 资源管理器右键(shell context-menu)。当前能力 = **禁用/恢复**第三方 `ContextMenuHandler`(COM 处理器),本用户级、**无需管理员、可逆**。

> 暂作独立 CLI,未接进 poof 运行(符合"拉下来装着、暂不占运行空间")。后续并入 poof 的右键管理能力。
> 真源工具 Nilesoft Shell 在 `../../vendor/nilesoft-shell`(源码),用于**添加/替换**右键项(本 CLI 只管删/禁)。

## 用法

```powershell
pwsh -File ctxmenu.ps1 find    -Name 0HVContext      # 定位 handler,打印 CLSID/DLL/是否已屏蔽
pwsh -File ctxmenu.ps1 disable -Name 0HVContext      # 一键:定位 + 备份 + 屏蔽
pwsh -File ctxmenu.ps1 enable  -Name 0HVContext      # 恢复
pwsh -File ctxmenu.ps1 list-blocked                  # 列已屏蔽 CLSID
pwsh -File ctxmenu.ps1 status  -Clsid {GUID}         # 查某 CLSID 是否被屏蔽
```

屏蔽后重启资源管理器生效:`Stop-Process -Name explorer`(会自动重启)。

## 原理

- **禁用** = 把 handler 的 CLSID 写进 `HKCU\Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked`。资源管理器据此拒绝加载该 COM 处理器。删值即恢复。**本用户级,无需管理员。**
- **不删** HKLM 注册键(删 `HKLM\SOFTWARE\Classes\*\shellex\...` 需要管理员;你的机器无管理员)。
- `disable` 前会 `reg export` 备份该 handler 的 4 个 shellex 键到 `../../vendor/ctxmenu-backups`(gitignore,不上传)。

## 备忘

- **HoneyView** 的右键项 handler 子键名 = `0HVContext`(前导 0 让它排到右键菜单最前),DLL = `HVShell64.dll`。
- 4 个键位:`HKLM`/`HKCU` × `*`(所有文件)/`Directory`(文件夹)。
- 添加自定义右键项 → 走 `vendor/nilesoft-shell`(Nilesoft Shell,`.nss` 声明式配置 + `import` 自有文件 + CLI 注册 + 热重载),后续接入。
