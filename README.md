# overlay-shell

召出式覆盖层外壳。按住 `Ctrl` 双击 `Alt` 随地召出一个透明置顶浮层，承载检索、聊天、项目、审阅台、速记、截图、点选洞察、终端和录制等输入/操作面。

旧名 `poof` 只作为 legacy junction、历史文档、协议兼容 key 或旧数据目录存在；当前项目正名和物理路径是 `overlay-shell`。

> 权威设计 = `omnicompany/docs/plans/omnidashboard-os/[2026-06-20]OVERLAY-FRAMEWORK-FOUNDATION/plan.md`
> 真机验证与架构说明 = [`DEMO.md`](./DEMO.md)

## 技术栈

- Tauri v2(Rust core + 系统 WebView2)
- React 19 + Vite + TypeScript
- BlockSuite EdgelessEditor 笔记画布
- Windows keyboard hook / UIA / OCR / 截图 / 本机文件搜索 / PTY

## 跑起来

```bash
npm install
npm run tauri dev                 # 开发(热更新; 页面来自 vite dev :1420)
npx tauri build --no-bundle       # 日常常驻用的 release(托盘+单实例+嵌入前端资产)
```

⚠ **release 必须经 tauri CLI 构建**。裸 `cargo build --release` 不会嵌入 `dist/` 前端资产，
产物仍从 vite dev(:1420) 加载页面 —— dev 服务器一停主窗就只剩 WebView2 的"无法连接"错误页
(2026-07-06 实锤踩坑, 当天所有召出失灵的根因)。验证嵌入是否成功:
`grep -c "main-" src-tauri/target/release/overlay-shell.exe` 能搜到 dist 入口资产名即对。

日常常驻 = Startup 文件夹 `poof-overlay-shell.lnk` → `target/release/overlay-shell.exe`
(GUI 子系统无控制台)。所有常驻窗口关闭(Alt+F4)一律只隐藏不销毁, 退出走托盘右键菜单。

窗口默认隐藏。按住 `Ctrl` 双击 `Alt` 召出 / 收起；`Esc` 隐藏；`Ctrl K` 打开命令面板。

## 结构

- `src-tauri/src/lib.rs` - 键盘钩子、窗口召出/隐藏、命令桥
- `src/App.tsx` - 覆盖层外壳
- `src/surfaces.tsx` - 各面注册表
- `src/regions/` - 检索、笔记、终端等区域
- `agent-scanner/` - 机器级 agent 会话扫描器

## 数据边界

- 笔记真源: `E:\WindowsWorkspace\overlay-note-store`
- 兼容旧入口: `E:\WindowsWorkspace\poof` junction 到本仓
- 历史 `%LOCALAPPDATA%\poof`、`%USERPROFILE%\.poof` 和 `poof-note://` 暂保留兼容，后续单独迁协议/用户数据。
