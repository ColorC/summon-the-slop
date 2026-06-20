# poof — 真机演示与 spike 验证（2026-06-20）

在本机(公司 Win10 + EDR + 无管理员)从零搭起,完成 OVERLAY-FRAMEWORK-FOUNDATION 计划的基本演示。

## spike 四票:全绿 ✓✓✓✓

计划规定"四票全绿这条栈才算落地;任一红当场暴露降级"。实测结果:

| 票 | 命题 | 结果 | 证据 |
|---|---|---|---|
| ① | WebView2 在位 | ✅ | 注册表 `pv = 149.0.4022.69`,无需装 bootstrapper |
| ② | 双击 Ctrl 原生钩子召出(EDR 不拦) | ✅ | `WH_KEYBOARD_LL` 安装成功(日志 `hook installed ok`);注入双击左 Ctrl → 日志 `toggle show` + 窗口可见。**EDR 没拦自装全局键盘钩子** |
| ③ | 透明置顶浮层可挂可交互 web UI | ✅ | 截图:透明玻璃浮层「poof ✨」居中盖在桌面上,侧栏+内容可交互 |
| ④ | web 画布核心在 WebView2 能跑 | ✅ | 截图:tldraw 完整无限画布编辑器(工具条/形状/颜色/Page)在浮层内渲染并可操作 |

> 额外打通的工具链命门(计划未列但更底层):**Rust 在本机用 `x86_64-pc-windows-gnu` 工具链即可编译整套 Tauri 栈(wry/webview2-com/tao),不需 MSVC、不需管理员** —— 这是 Tauri 路线在这台锁定机器上可行的真正前提(对比 AFFiNE 源码构建被符号链接权限墙挡死)。

## 基本演示:一次召出 → 4 面 + 画布同处一框

**双击 `Ctrl`** 召出透明浮层(`Esc` 隐藏、`Ctrl K` 命令面板、📌 钉屏)。左侧栏切换五个面:

| 面 | 形态 | 接入(真实) |
|---|---|---|
| **检索 Find**(Listary 类) | 搜索框 + 结果列表 = 主入口 | `omni project list --json`(已渲染全部真实项目;预留接 `waiela find` 本地/对话/飞书) |
| **聊天 Talk** | 输入 + 答案 + 复制出口 | `claude -p` via stdin(已验证返回);`codex exec` 同理 |
| **项目 Project** | omni 项目卡片 | `omni project list --json`(真实数据) |
| **审阅台 Review** | 最近/待审 + 链接 | `omni project show omnidashboard-os --json` |
| **速记 Note** | tldraw 无限画布(本地持久化=召出保留 buffer) | spike 画布 |

命令面板(`cmdk`):切换面 / `▶ 运行 <命令>`(走 `run_shell`)/ 切到聊天问 AI。
出口(Dispatch):复制(`copy_text` → 剪贴板)、钉屏(置顶开关)。

## 与计划的偏差(诚实记录)

1. **画布用 tldraw 而非 BlockSuite。** 票④要证明的是"web 画布核心能在 WebView2 跑",tldraw 干净的 `<Tldraw/>` 可一行渲染、可截图验证,故 spike 用它。**BlockSuite EdgelessEditor 仍是生产画布**(理由=rich-text-on-canvas,工作流已 CONFIRMED 其可嵌 WebView2);其 0.22(`@blocksuite/affine`)嵌入需有界面的交互调试,留作下一个聚焦任务,不在这次无人值守 pass 里硬啃。架构(在浮层里嵌一个 web 画布)与最终一致,只换组件。

2. **单窗多面板,而非"每个重面独立窗"。** 计划第 3 节的"壳+面混合多窗"是优化形态;MVP 用单窗 + 面板切换实现"4 面同处一框"(正是用户点名的演示)。多窗拆分(抢焦点面独立窗、全屏穿透宿主挂 toast/选区)记作下一步;Rust 侧 `run_shell`/钩子/窗口控制已就位,扩到多窗是增量。

3. **召出热键** 当前认左/右 Ctrl(`0xA2/0xA3`);真机用物理 Ctrl 即可,验证时用 `keybd_event` 注入左 Ctrl。

## 下一步

- BlockSuite EdgelessEditor 替换 tldraw(速记面 → 真·rich-text 画布)。
- 多窗拆分 + 全屏点击穿透宿主(toast/选区 HUD)。
- 检索面接 `waiela find`(本地 Everything/ripgrep + 对话 + 飞书 lark-cli)。
- 聊天面会话路由(新→CCUI;已开→高亮跳窗),复用 waiela `sessions.py`。
- LILITH HTTP 作第二条 AI 桥(reqwest)。
