# Poof, There It Is (`poof`)

omnidashboard-os 的**召出式覆盖层外壳** —— **按住 `Ctrl` 双击 `Alt`** 随地召出一个透明置顶浮层,里面装下「检索 / 聊天 / 项目 / 审阅台 / 速记」各面。目标:基于 AI 让"记录·查询·审阅"最舒适,缩短我和电脑一切的距离。顶掉 Listary 当主入口。

> 权威设计 = `omnicompany/docs/plans/omnidashboard-os/[2026-06-20]OVERLAY-FRAMEWORK-FOUNDATION/plan.md`
> 真机验证与架构说明 = [`DEMO.md`](./DEMO.md)

## 技术栈

- **壳**:Tauri v2(Rust core + 系统 WebView2)。安装 <10MB、空闲内存远低于 Electron。
- **召出**:自有 Rust `WH_KEYBOARD_LL` 底层键盘钩子(**按住 `Ctrl` 双击 `Alt`**;Ctrl 按住态用 `GetAsyncKeyState` 实时查,免疫漏 key-up)——任何壳的 global-shortcut API 都做不到这种修饰键手势。
- **UI**:React 19 + Vite + TypeScript;命令面板 `cmdk`。
- **画布**:tldraw(spike;生产替换为 BlockSuite EdgelessEditor,见 DEMO)。
- **接入**:你自己的 AI(`claude -p` / `codex exec` via stdin)+ `omni` CLI;WAIELA 作 sidecar(控制套接字 `127.0.0.1:47615`)。

## 跑起来

```bash
npm install
npm run tauri dev      # 开发(首次编译较久,之后 8s 级)
npm run tauri build    # 出包
```

启动后窗口默认隐藏。**按住 `Ctrl` 双击 `Alt`** 召出 / 收起;`Esc` 隐藏;`Ctrl K` 开命令面板。

### 环境前提(本机已满足)

- Rust(`x86_64-pc-windows-gnu` 工具链即可,**不需 MSVC / 管理员**)。
- WebView2 运行时(Win11 / 新 Win10 预装;缺则 per-user bootstrapper,无需管理员)。
- Node ≥ 18。

> ⚠️ gnu 工具链坑:`src-tauri/Cargo.toml` 的 `[lib] crate-type` 必须是 `["rlib"]`(不能带 `cdylib`),否则 mingw 链接器报 `export ordinal too large`。桌面端不需要 cdylib(那是移动端的)。

## 结构

- `src-tauri/src/lib.rs` —— 键盘钩子、窗口召出/隐藏、`run_shell` / `ask_ai` / `copy_text` 命令(均 `CREATE_NO_WINDOW` 无控制台闪窗)。
- `src/App.tsx` —— 外壳:侧栏 + cmdk 命令面板 + 钉屏。
- `src/surfaces.tsx` —— 各面(检索/聊天/项目/审阅台/速记)+ surface 注册表。
- `src/lib.ts` —— 前端调 Rust 命令的封装。
