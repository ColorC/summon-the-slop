# poof 笔记 BlockSuite 接入全面审查（2026-07-03）

背景：用户报告 ① 画布上拖出范围建文字/笔记卡片，松手不出卡、经常根本建不出；② 打开笔记后无法自由移动卡片；③ BlockSuite 相关操作 bug 率极高，怀疑接入方式有问题或源码拉取不完整。

审查方式：Playwright 驱动纯网页入口（8210 桥）真实复现 + 六个维度静态审查（创建路径 / 移动路径 / 生命周期与 DOM hack / 持久化竞态 / 上游与版本 / CSS 命中）+ 高危发现对抗验证。BlockSuite 结论全部以本机 node_modules 0.19.5 实际源码为准。

## 一、直接回答两个猜想

**"源码拉取不完整" —— 否。** BlockSuite 不是源码 vendor，是 npm 安装的 0.19.5：全家桶同版本 deduped、lit 3.3.3 单例、yjs 13.6.31 单例、icons 有意钉 2.1.75（配 0.19.5 源码里的 typo 图标名）。包文件齐全，`AffineEditorContainer` 导出正常。

**"接入方式有问题" —— 部分成立，且首要问题恰好是 poof 自己加的一个钩子（见 R1）。** 另一半背景是：0.19.5 是**事实上的终结版本线**——上游 2024-12 把 BlockSuite 并进 AFFiNE monorepo，`@blocksuite/presets` 在 npm 上自 0.19.5 后再无发布（0.20.0 直接 404），仓库主干只剩单向同步的自动提交。0.19.5 的存量 bug 永远不会有官方修复，这是"bug 率高"观感的客观底色。

## 二、确认的根因（按用户症状）

### S1 「拖出范围松手不出卡 / 根本建不出」

**R1（高危，已复现）fit hook 在松手约 400ms 后把拖出的卡压扁。**
- BlockSuite 便签工具拖拽建卡：`NoteTool.dragEnd` → `addNote(collapse:true, collapsedHeight=拖出高度)`（`node_modules/@blocksuite/blocks/dist/root-block/edgeless/gfx-tool/note-tool.js:88-103`、`utils/common.js:139-168`）——collapse:true 正是"固定用户拖出的尺寸"的手段。
- poof 在 [NotesWorkspace.tsx:449-486](../src/regions/NotesWorkspace.tsx#L449) 订阅 `blockUpdated`，防抖 400ms 后对**所有** `affine:note` 强制 `collapse:false`；note 渲染高随即变成 `'inherit'`（`note-edgeless-block.js:390`），`EdgelessNoteMask` 的 ResizeObserver 再把 xywh 高度改写成内容实际高。
- 复现时间线（每 100ms 采样，320×220 拖框）：t+6ms~314ms `xywh=[110,220,498,220] collapse=true`；**t+416ms `高度 220→162, collapse→false`**。空卡只有一个空段落时塌得更狠，观感就是"松手没出卡/出了又没了"。
- 追加后果：**用户任何手动拉高卡片的操作同样会在 400ms 后被撤销**（resize 设 collapse:true → 又被翻回）。这是 S3"很多操作不正常"的重要一员。

**R2（高危，一手源码证据）文字工具根本不支持拖拽建卡，且点击压到已有元素时静默不建。**
- `text-tool.js` 只实现了 `click()`，没有任何 dragStart/dragMove/dragEnd——**拖出范围再松手，上游代码路径就是空操作**。用户描述的"添加文字卡片时画一个范围"必然失败，与 poof 无关，是 0.19.5 的交互设计（文字=单击落点）。
- 单击建字走 `insertEdgelessText`（`enable_edgeless_text` 默认 true）；旧路径 `addText` 在 `getElementByPoint` 命中已有元素时直接 return 不建。种子笔记是一张 440×620 的大卡，画布中央大片区域点上去就是"没反应"。复现中也抓到一次"单击没落块"。
- 便签工具的拖拽建卡在无头环境**每次都成功**（含微拖/快拖/中途停顿/压卡重叠等边角，5 类全过、0 报错）——"根本建不出"的硬失败无法在网页端复现，主要解释就是 R2（用错工具语义）+ R1（建出即被压扁）。桌面 WebView2 指针差异是否另有贡献，证据不足不下断言。

### S2 「无法自由移动笔记卡」

**R3（中危，上游交互规则 + R1 放大）移动通路本身完好，卡在两条交互规则上。**
- 复现：单击选中后从卡中间拖，4 次位移全部像素级精确；方向键也能移动。**模型级 move 无 bug**。
- 规则一：**编辑态的卡不能拖**。`DefaultTool.dragStart` 对 `editing:true` 的 note 直接 return（`default-tool.js`），且编辑态遮罩 `pointerEvents:none`。而**新建卡片会自动进入编辑态**（`addNote` 在 RAF 里 `selection.set({editing:true})`）——"刚建完就想拖"必然拖不动，要先 Esc / 点空白退出编辑，再单击选中才能拖。
- 规则二：**从卡的边缘往下拖是 resize 不是 move**（复现：顶边拖动把宽从 440 拉到 498，位置不动）。
- R1 的放大作用：卡被压扁后可抓取的遮罩只剩内容那么高，可拖区域变小，"抓不住"的概率上升。

### S3 「bug 率极高 / 很多操作不正常」

**R4（中危，网页端专属，已复现 24 次/会话）** `tauri-web-shim.ts` 把 `registerListener/unregisterListener` 挂在 `window.__TAURI_INTERNALS__`，但 `@tauri-apps/api/event.js` 实际读的是 `window.__TAURI_EVENT_PLUGIN_INTERNALS__`（shim 从未定义）→ 每次切笔记/开笔记库时 `onDragDropEvent` 的清理抛 `Cannot read properties of undefined (reading 'unregisterListener')`。桌面端不受影响。

**R5（中危，数据安全）持久化层三处真实隐患**（代码链逐跳核实成立；对抗验证的结论是"不解释本次 S1/S2"，但作为风险成立）：
- 桌面端与 8210 网页端是**两个互不知情的写者**：`FileDocSource` 内存缓存建立后永不回读磁盘、`subscribe()` 是空实现，网页端后端（omnicompany `poof_notes.py`）自述"快照级 last-write-wins（暂不做 Yjs 合并）"。两端同时开同一笔记交叉编辑时，会互相覆盖写入（含存笔记列表的根 doc）。
- Rust `atomic_write` 临时文件名固定 `.{name}.tmp`，两进程并发写同一 doc 会踩同一个 tmp、rename 打架。
- flush 只在隐藏/关窗时可靠；进程被杀时最后 ≤400ms 编辑丢失。

**R6（低危，背景）** 0.19.5 死版本线（见上）。升级 = 迁 AFFiNE monorepo 新系（`AffineEditorContainer` 在新版已消失），重写级工作量；现实路线是留驻 0.19.5 + 局部补丁。

**已排除的嫌疑**：依赖重复/版本漂移（树干净）；React StrictMode 双挂载（未启用）；主窗鼠标穿透（`set_ignore_cursor_events` 只作用于 toast 窗）；aiblock 塞 surface children 白名单（经核实健壮，快照/复制 round-trip 成立）；CSS 米色纸改皮（只动颜色/内边距，不阻断指针；唯一小瑕疵是双层内边距使点击定位有轻微偏差）；noteExport/翻译器/轮询注入的"性能放大器"说法（对抗验证推翻：都有防抖/守卫，编辑热路径上是 O(1)）；notes-bar 吞顶部事件（它是可见工具条，正常 UX）。

## 三、修复与整理建议（按优先级）

**P0 —— 两个主诉的对症修复（小改动）**
1. **删掉 fit hook 的 blockUpdated 订阅与强制 `collapse:false`**（NotesWorkspace.tsx:449-486）。collapse 在 BlockSuite 语义里就是"用户定高"，拖框建卡、手动拉高都靠它；强制翻掉等于永久禁止用户控制卡片高度。若"选中框大于内容"的旧痛点还要治，改成工具条上的手动"贴合内容"按钮，或仅对"打开时检测到高度远大于内容且从未被用户调过"的历史笔记做一次性迁移。
2. **文字卡拖拽**：要么接受上游语义（文字=单击、便签=拖框）并在 UI 上提示；要么在 edgelessSpecs 覆盖 TextTool 补 `dragEnd`（按拖出宽度建 edgeless-text）。同时考虑给"点击压在已有元素上被静默忽略"加提示。
3. **移动教育/缓解**：R3 是上游规则，可不改代码；若要缓解"刚建完拖不动"，可在建卡后主动退出编辑态（包一层 addNote 后 `selection.set({editing:false})`），代价是少一次直接输入的便利。

**P1 —— 真实 bug，修了消除诡异现象**
4. shim 补 `window.__TAURI_EVENT_PLUGIN_INTERNALS__`（实现 unregisterListener，可与现有实现共用）。
5. `atomic_write` tmp 名加进程 id/随机后缀（Rust 端与 poof_notes.py 两处）。
6. 跨进程写收敛：最低成本是写盘前回读磁盘现值 `mergeUpdates([disk, cache, data])` 再写（两端都做），或 Rust 端文件写锁；根 doc（笔记列表）优先。
7. 进程退出丢 400ms：桌面端在 Rust 侧 CloseRequested/退出钩子里等一次前端 flush 完成再退。

**P2 —— 整理（降维护负担，非当前主诉根因）**
8. DOM hack 收敛：MutationObserver 缩小到编辑器宿主容器、去掉 characterData；`mountNoteExpandButton`/`mountAiToolbarButton` 从 700ms/1000ms 全树轮询改成事件驱动（工具条出现的一次性 observer）；能走 config/扩展层的（如 slash 菜单已做的）一律不碰 DOM。
9. App.css 去掉 `.affine-note-block-container` 的叠加 padding（原生外层已有 24px）。
10. 版本战略写死在 README：0.19.5 为带补丁的冻结版，禁"顺手升级"；未来若迁移只走 AFFiNE monorepo 整体评估。

## 四、复现资产

- 脚本与截图：`C:/Users/<user>/AppData/Local/Temp/claude/e--WindowsWorkspace/d3294e28-87dd-4ed9-aa6f-19ac86d1f97e/scratchpad/poof-repro/`（s1_timeline 采样、s2v3 移动序列等）。
- 测试笔记已全部移入回收站，live 列表复核仅剩 9 条真实笔记。
