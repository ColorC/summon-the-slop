# poof — 真机演示与 spike 验证（2026-06-20）

在本机(公司 Win10 + EDR + 无管理员)从零搭起,完成 OVERLAY-FRAMEWORK-FOUNDATION 计划的基本演示。

## spike 四票:全绿 ✓✓✓✓

计划规定"四票全绿这条栈才算落地;任一红当场暴露降级"。实测结果:

| 票 | 命题 | 结果 | 证据 |
|---|---|---|---|
| ① | WebView2 在位 | ✅ | 注册表 `pv = 149.0.4022.69`,无需装 bootstrapper |
| ② | 原生钩子召出（**按住 Ctrl + 双击 Alt**，EDR 不拦） | ✅ | `WH_KEYBOARD_LL` 安装成功(日志 `hook installed ok`);注入"按住Ctrl+双击Alt" → `toggle show` + 窗口可见;**反向测试**:纯双击 Alt(不按 Ctrl)**不触发**(`GetAsyncKeyState` 实时查 Ctrl)。**EDR 没拦自装全局键盘钩子** |
| ③ | 透明置顶浮层可挂可交互 web UI | ✅ | 截图:透明玻璃浮层「poof ✨」居中盖在桌面上,侧栏+内容可交互 |
| ④ | web 画布核心在 WebView2 能跑 | ✅ | 截图:tldraw 完整无限画布编辑器(工具条/形状/颜色/Page)在浮层内渲染并可操作 |

> 额外打通的工具链命门(计划未列但更底层):**Rust 在本机用 `x86_64-pc-windows-gnu` 工具链即可编译整套 Tauri 栈(wry/webview2-com/tao),不需 MSVC、不需管理员** —— 这是 Tauri 路线在这台锁定机器上可行的真正前提(对比 AFFiNE 源码构建被符号链接权限墙挡死)。

## 基本演示:一次召出 → 4 面 + 画布同处一框

**按住 `Ctrl` 双击 `Alt`** 召出透明浮层(`Esc` 隐藏、`Ctrl K` 命令面板、📌 钉屏)。左侧栏切换五个面:

| 面 | 形态 | 接入(真实) |
|---|---|---|
| **检索 Find**(Listary 类) | 搜索框 + 结果列表 = 主入口 | `omni project list --json`(已渲染全部真实项目;预留接 `waiela find` 本地/对话/飞书) |
| **聊天 Talk** | 输入 + 答案 + 复制出口 | `claude -p` via stdin(已验证返回);`codex exec` 同理 |
| **项目 Project** | omni 项目卡片 | `omni project list --json`(真实数据) |
| **审阅台 Review** | 最近/待审 + 链接 | `omni project show omnidashboard-os --json` |
| **速记 Note** | BlockSuite EdgelessEditor 无限画布(本地持久化=召出保留 buffer) | 生产画布,tldraw 已替换(见下方偏差记录) |

命令面板(`cmdk`):切换面 / `▶ 运行 <命令>`(走 `run_shell`)/ 切到聊天问 AI。
出口(Dispatch):复制(`copy_text` → 剪贴板)、钉屏(置顶开关)。

## 与计划的偏差(诚实记录)

1. **本次 spike 画布用 tldraw 而非 BlockSuite。** 票④要证明的是"web 画布核心能在 WebView2 跑",tldraw 干净的 `<Tldraw/>` 可一行渲染、可截图验证,故 spike 用它。**BlockSuite EdgelessEditor 已按计划替换为生产画布**(理由=rich-text-on-canvas,已嵌入 WebView2 并投入使用);tldraw 只剩零引用的 `src/windows/CanvasWindow.tsx` 残留待清理。架构(在浮层里嵌一个 web 画布)与最终一致,只换组件。

2. **单窗多面板,而非"每个重面独立窗"。** 计划第 3 节的"壳+面混合多窗"是优化形态;MVP 用单窗 + 面板切换实现"4 面同处一框"(正是用户点名的演示)。多窗拆分(抢焦点面独立窗、全屏穿透宿主挂 toast/选区)记作下一步;Rust 侧 `run_shell`/钩子/窗口控制已就位,扩到多窗是增量。

3. **召出热键 = 按住 Ctrl + 双击 Alt**(比裸双击 Ctrl 更罕见、不与复制粘贴连按撞)。Ctrl 按住态用 `GetAsyncKeyState` 实时查(不靠跟踪 key 事件,免疫漏 key-up 卡死);Alt 认左/右/通用(`0xA4/0xA5/0x12`)。验证用 `keybd_event` 注入,反向测试确认纯双 Alt 不触发。

## 下一步

- ~~BlockSuite EdgelessEditor 替换 tldraw(速记面 → 真·rich-text 画布)~~ 已完成,tldraw 残留清理见仓内已知孤儿记录。
- 多窗拆分 + 全屏点击穿透宿主(toast/选区 HUD)。
- 检索面接 `waiela find`(本地 Everything/ripgrep + 对话 + 飞书 lark-cli)。
- 聊天面会话路由(新→CCUI;已开→高亮跳窗),复用 waiela `sessions.py`。
- LILITH HTTP 作第二条 AI 桥(reqwest)。
