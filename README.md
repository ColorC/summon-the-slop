# Summon the Slop

### A transparent desktop overlay shell for AI-assisted work

A summonable **transparent overlay that floats above all windows**. Press **Ctrl + double-tap Alt**
anywhere and a click-through-when-idle, always-on-top shell appears over whatever you're doing —
your one keystroke away from search, notes, terminals, and capture.

`Esc` hides it. `Ctrl+K` opens the command palette. All windows hide on close (tray icon to quit);
it's meant to live in the background forever.

## What's inside

| Surface | What it does |
|---|---|
| **File search** | Everything-grade local search: NTFS MFT enumeration when elevated, throttled full-disk walk otherwise; fzf-style subsequence match × frecency ranking, pinyin support, live USN-journal updates, real file icons |
| **AI terminal** | Persistent ConPTY tabs running Claude / Codex / PowerShell; per-note "AI blocks" on the canvas resume their own conversation (`claude --continue`) |
| **Notes** | Infinite-canvas notes on BlockSuite (edgeless editor): shapes, markdown, file embeds with write-back, version history, on-disk storage (plain files you can back up) |
| **Screenshot + OCR** | GDI screen capture, region snips, Windows.Media.Ocr, annotate → send to AI |
| **UI inspector** | "What's this element?" — UIA tree inspection of any window under the cursor |
| **Clipboard manager** | Persistent text/image/HTML history with preview + restore |
| **Omnicompany embed** | Iframes the [omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently) dashboard cockpit and wires notes ↔ projects/plans cross-links |
| **Session recording** | Machine-level scan/index of your Claude & Codex sessions (`agent-scanner/`), plus rrweb-based replay |

## Tech stack

**Tauri v2 (Rust) + React 19 + Vite 7 + TypeScript**, running in the system WebView2.
BlockSuite for the canvas, xterm.js for terminals, `windows-rs` for everything native.

## ⚠️ Platform: Windows only

This is not a portability limitation, it's the product. Deep Win32 API dependencies throughout:
low-level keyboard hooks (`WH_KEYBOARD_LL`), UI Automation, GDI capture, NTFS MFT/USN journal
access, ConPTY. There are no macOS/Linux plans.

## ⚠️ Disclaimer

> This is a personal daily-driver tool. It's deeply integrated with my workflow and
> [omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently). It probably won't work
> well on your machine out of the box. But the file search engine, notes canvas, and terminal are
> genuinely cool. I welcome bug fixes, feature PRs, or issues telling me what to improve.

## Build

Requires: Rust toolchain (the `x86_64-pc-windows-gnu` target works without MSVC/admin),
Node.js, and the WebView2 runtime (preinstalled on Windows 10/11).

```bash
npm install
npx tauri build --no-bundle     # release exe at src-tauri/target/release/overlay-shell.exe
npm run tauri dev               # dev with hot reload (vite on :1420)
```

⚠ Release builds **must** go through the Tauri CLI — a bare `cargo build --release` won't embed
the frontend assets, and the main window will just show a "cannot connect" page once the vite dev
server is gone.

Checks: `npm run check` (tsc + cargo test for `src-tauri` and `agent-scanner`).

## Configuration

Everything machine-specific is opt-in; defaults are safe on a fresh box.

**Rust side — environment variables:**

| Variable | Purpose | Default |
|---|---|---|
| `OVERLAY_NOTE_STORE_ROOT` | Where notes/blobs are stored on disk | `%LOCALAPPDATA%\overlay-shell\note-store` |
| `OVERLAY_SEARCH_ROOTS` | Extra live-watch dirs for the search index (`;`-separated) | none (Desktop/Documents/Downloads + `%TEMP%\overlay-shell-roots.txt` for index-only additions) |

**Frontend — localStorage keys** (set in DevTools, no restart needed):

| Key | Purpose | Default |
|---|---|---|
| `overlay-terminal-cwd` | Default cwd for new terminal tabs | `""` (home) |
| `overlay-ai-blocks-home` | Root dir for per-note AI block terminals | `%USERPROFILE%\overlay-shell\ai-blocks` |
| `overlay-controller-home` | Home dir of the "controller" CLI pane | `""` (home) |
| `overlay-captures-dir` | Captures/region-snips directory | `""` (captures tab disabled) |
| `overlay-omni-reviewstage` | omnicompany review-stage materials dir | `""` (omni review sources disabled) |
| `overlay-board-url` | omnidashboard cockpit URL | `http://localhost:8210/` |

## Structure

- `src-tauri/src/lib.rs` — keyboard hook, window summon/hide, command bridge
- `src-tauri/src/search.rs` / `mft.rs` — the search engine (walk + MFT + ranking)
- `src/App.tsx`, `src/surfaces.tsx` — overlay shell + surface registry
- `src/regions/` — search, notes (BlockSuite), terminals, omni links
- `agent-scanner/` — standalone machine-level AI session scanner crate

## License

[MIT](./LICENSE)

---

# 中文简介

**Summon the Slop** —— 一个为 AI 辅助工作而生的**透明桌面覆盖层外壳**。

按住 `Ctrl` 双击 `Alt`，随地召出一个**透明、置顶、悬浮在所有窗口之上**的外壳：检索、笔记、
终端、截图、点选洞察、剪贴板各面同处一框，召出即入口。`Esc` 隐藏，`Ctrl+K` 命令面板，
关窗只隐藏不销毁（托盘退出），生来就该常驻后台。

- **文件检索**：NTFS MFT 级全盘索引（提权时走 MFT，否则限速遍历），fzf 式子序列匹配 ×
  frecency 排序，拼音可搜，USN 日志实时更新
- **AI 终端**：ConPTY 持久标签页跑 Claude / Codex / PowerShell；笔记画布上的 AI 块各自
  `--continue` 续自己的对话
- **无限画布笔记**：BlockSuite edgeless 编辑器，图形/markdown/活文件嵌入（可写回）/版本历史，
  落盘为普通文件可备份
- **截图 + OCR**、**UI 元素洞察**（UIA）、**剪贴板管理器**、**omnicompany 驾驶舱嵌入**、
  **agent 会话扫描/录制回放**

技术栈：**Tauri v2 (Rust) + React 19 + Vite 7 + TypeScript**（系统 WebView2）。

⚠️ **仅 Windows**：深度依赖 Win32 API（键盘钩子 / UIA / GDI / NTFS MFT / ConPTY），无跨平台计划。

⚠️ **免责声明**：这是我的个人日常自用工具，与我的工作流和
[omnicompany](https://github.com/ColorC/make-ai-slop-more-efficiently) 深度耦合，在你的机器上
大概率开箱不能即用。但文件搜索引擎、笔记画布和终端确实有点东西。欢迎修 bug、提 feature PR，
或开 issue 告诉我哪里该改。

构建：`npm install && npx tauri build --no-bundle`（需要 Rust 工具链 + WebView2 运行时）。
配置项（环境变量 / localStorage 键）见上方英文 Configuration 节。

许可证：[MIT](./LICENSE)
