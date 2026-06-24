# 笔记平台演进 · 调研计划

> 状态: 调研 / 需求定义。具体架构等调研回来再定(本文件末尾留"架构决定"章节待补)。
> 范围: ① 存储落地到 WindowsWorkspace 浅路径 · ② 笔记↔omnicompany 项目/计划关联(标签+跳转) · ③ 自定义块的 CLI 与添加便利。附: markdown 保真(直接关系"笔记顺不顺手")。

## 0. 现状(已查清, 不是猜)

- **数据真源 = IndexedDB, 三处, 全在 AppData 深处不可见**:
  - 文档: `IndexedDBDocSource("poof-notes")`(notesCollection.ts)
  - blob(图片/PDF 字节): collection.blobSync 默认 IndexedDB
  - 版本历史: 自建 IndexedDB(noteVersions.ts)
  - 物理落点: `C:\Users\lilithgames\AppData\Local\com.lilithgames.poof\EBWebView\Default\IndexedDB\`(WebView2 的 LevelDB, 不透明, 不能直接读/搬/备份)。→ 这就是"保存路径在哪儿、能不能搬到浅位置"的答案: 现在没有干净文件路径。
- **markdown**: BlockSuite **没有"专门的 markdown 块"**。它的段落/列表本身就是富文本模型, markdown 是三条通道: (a) 打字快捷(`# `、`- `、`1. `+空格, 默认开)(b) 导入/导出适配器 (c) 粘贴。**粘贴纯文本走 MixTextAdapter, 不做 markdown→块转换** → 这就是"复制 1. 2. 序号没反应"的根因。
- **文件块已落地(本轮)**: 文本→可编辑 `affine:code`+写回源文件; 图片→`affine:image`; PDF→`affine:attachment` 内嵌预览; 其它→附件卡; md 源码⇄渲染预览切换; 系统拖文件进笔记直接插入。

---

## 工作流一 · 存储落地到 WindowsWorkspace 浅路径

**目标**: 笔记/blob/版本从 AppData 的不透明 IndexedDB, 迁到 `E:\WindowsWorkspace\` 下一个浅、可见、可备份(可 git/可同步/可被 omni 与 CLI 直接读)的位置。

**初步调研(已知)**:
- 替换 `IndexedDBDocSource` 为自定义 **DocSource**: 把每个 doc 的 Yjs update 落成磁盘文件(`<id>.ydoc` 或一个 SQLite)。Tauri 侧已有 fileio.rs 可读写; 也可上 `tauri-plugin-sql`(SQLite)。
- **AFFiNE 桌面版**本身: 每个 workspace 一个 SQLite(`.affine`)+ blob 落本地目录 → 可直接抄它的落盘策略/schema。
- **Obsidian/Logseq**: 纯 `.md`/`.org` 文件库, 人读人改, 极致可移植 —— 但 BlockSuite↔纯 md 有损(画布坐标/AI 块/附件无法用纯 md 表达)。
- 版本系统已经在做"`encodeStateAsUpdate`→字节"了, 可复用同款思路落盘。

**待调研定的关键取舍**:
1. 真源格式: **Yjs 二进制库(SQLite/.ydoc, 保真但不可人读)** vs **人读 .md 文件库(可移植/omni 可直接读, 但有损)** vs **混合**(正文走 .md 文件 + sidecar 存画布/自定义块/坐标)。混合最像我们要的"既能被 omni 读、又不丢画布/AI 块"。
2. blob 放哪: 同目录 `blobs/<sha>` 文件 vs 库内。倾向独立文件目录(图片能直接看)。
3. 迁移: 一次性把现有 IndexedDB 导出(collection→snapshot / Yjs update)写到新位置再切 source; 保证不丢老笔记。

**验收测试列表**:
- [ ] 笔记数据出现在 `E:\WindowsWorkspace\<浅路径>\`, 资源管理器能看到、能整个复制走。
- [ ] 关 poof → 删 AppData 里的 IndexedDB → 重开, 笔记仍在(证明真源已搬出 WebView2)。
- [ ] 改一条笔记 → 对应磁盘文件内容/mtime 变化。
- [ ] 图片/PDF 的 blob 也落在该位置(独立可见文件), 不再塞 IndexedDB。
- [ ] 版本历史一并迁移或可访问。
- [ ] 迁移零丢失: 迁移前后笔记条数/标题一致。
- [ ] (混合方案若选)正文文件是人可读的 .md。

---

## 工作流二 · 笔记 ↔ omnicompany 项目/计划 关联(标签 + 跳转)

**目标**: 一条笔记(或一个块)能挂到 omni 的项目/计划上; 双向 —— 笔记里能跳到 omni 项目, omni 也能列出关联的笔记; 标签系统统一(不是笔记本地一份、omni 一份)。

**现状**: 已有 `poof-note://<id>` 链接复制 + **notebridge**(CLI⇄活笔记 collection 的文件命令队列雏形)+ 轻量本地标签(localStorage)。omni 侧有 `omni project list --json` 等。

**初步调研(已知)**:
- 数据源: `omni project/plan list/show --json` 做正向选择源; notebridge 做反向(omni→笔记)注入。
- 双链/反链: Obsidian/Logseq 的 `[[wikilink]]`+backlinks; BlockSuite 自带 linked-doc(`@`)可改造成 `@项目` / `@计划`(本轮 `@` 已接到文件搜索, 可再加一类"omni 实体")。
- 你自己的 **decision-record / decisions 域**(决策树 links + anchor 甜蜜点)可能就是"关联"的天然真源。

**待调研定**:
1. 关联/标签的**真源放哪**: omni(decisions 域 / 项目元数据) vs 笔记本地 vs 双写? 倾向 omni 为真源, 笔记侧只存引用。
2. 跳转目标形态: 跳到 **真实 vscode 窗口** / omni 看板(8210) / web? (和 poof 总控派发、agent 注册表的跳窗能力是同一套)。

**验收测试列表**:
- [ ] 笔记里能选"关联到 omni 项目/计划 X"(从 `omni project list` 实时选)。
- [ ] 关联后笔记顶部显示该项目/计划 chip, 点 → 跳到 omni 对应位置(窗口/看板/页面)。
- [ ] 反向: `omni notes ls --project X`(或 omni 项目页)能列出关联笔记。
- [ ] 标签可跨笔记筛选, 且与 omni 项目/计划**同一份真源**。
- [ ] AI(claude/codex via CLI)能读到"这条笔记关联了哪个项目", 反之 omni 能读到项目下有哪些笔记。

---

## 工作流三 · 自定义块的 CLI 与添加便利

**目标**: 自定义块(AI 块 / 文件块 / 未来的 omni 卡片块…)能被 CLI 加进笔记 + 在笔记里有统一、便利的添加入口(不再各 hack 各的)。

**现状(且是痛点)**: AI 块靠"注入底部工具栏的钮"、文件块靠"搜索/拖拽" —— **各写各的**。notebridge 有 CLI⇄笔记命令队列雏形。

**初步调研(已知)**:
- 统一 **块注册表 + 插入总线**: 一个 `insertBlock(kind, args)`, 工具栏/slash 菜单/CLI 都走它(现在 AI、文件各写各的, 应收编)。
- **slash 菜单**扩展(`/AI`、`/文件`、`/omni`)比注入工具栏更原生(BlockSuite slash 支持加自定义项, 本轮已会改它的 config)。
- CLI: 扩展 notebridge 命令队列, 让 `omni notes add-block --kind ai --note X` 往活笔记塞块。
- 类似产品: Notion(`/` 加块 + API insert)、AFFiNE(`/`+`@`)、Roam(`/` 命令)、VSCode 命令面板。

**验收测试列表**:
- [ ] slash 菜单里有 `/AI 块`、`/文件`、(未来)`/omni 卡片`, 一个入口加全部自定义块。
- [ ] CLI `omni notes add-block --note X --kind ai` 能往指定笔记加 AI 块, 重开可见。
- [ ] 新增一种自定义块时, 只在"块注册表"登记一次, 工具栏/slash/CLI 三处自动可用。
- [ ] 添加体验: 从"想加"到"加上" ≤2 步。

---

## 附 · markdown 保真(直接关系"笔记顺不顺手")

- **现状**: 打字快捷(`# `/`- `/`1. `+空格)应可用; **粘贴 md 不转**(走 MixTextAdapter)。
- **初步调研**: 注册更高优先级的 `text/plain` 粘贴适配器, 用 BlockSuite 的 MarkdownAdapter 把粘贴文本转成块。风险 = 误转(想要字面量的也被 markdown 化)→ 需"粘贴为纯文本"退路或智能判定。类似产品: Obsidian/Typora(md 原生)、Notion(粘贴 md 自动转)。
- **验收**:
  - [ ] 粘贴 `# 标题 / 1. a / 2. b / - x` → 变成真标题/有序/无序列表。
  - [ ] 打字 `1. `+空格 → 有序列表(确认默认行为)。
  - [ ] 有"粘贴为纯文本"退路, 不误伤。

---

## 调研产出与下一步

调研回来后在此追加 **「架构决定」** 章节: 各工作流选定方案 + 落地步骤, 再开工。优先级建议: 工作流一(存储落地, 数据安全是地基) → markdown 保真(低成本高频体验) → 工作流二/三。

---

# 调研结论与架构建议(2026-06-24, 四路并行调研已回)

## ⚠ 两个纠错(调研挖出, 计划原文有误)
- **blob 当前没持久化**: 全仓没传 `blobSources`, 默认 `MemoryBlobSource`(内存 Map, `@blocksuite/store` collection.ts:140)。**图片/PDF 关 poof 即丢**。存储落地必须顺带补 blob 落盘。
- **markdown 粘贴有能力, 不是缺**: `MixTextAdapter.toSliceSnapshot` 内部委托 `MarkdownAdapter`(`_common/adapters/mix-text.js:205`)。"`1. 2.` 没反应"真因 = `text/html`(prio 90)抢在 `text/plain`(prio 70)前(从渲染源复制时), 或全角 `1。`/缺空行。打字快捷默认开(`affine-components/.../markdown-input.js`)。→ 改优先级+预处理+退路, 别造轮子。

## 工作流一 · 存储落地 —— 建议
- **接口已实测**: 自定义 `DocSource` 只需实现 `name/pull/push/subscribe` 4 个成员(`@blocksuite/sync/dist/doc/source.d.ts`); 自定义 `BlobSource` 6 个成员(`.../blob/source.d.ts`)。注入点: `notesCollection.ts:54` 的 `docSources` + 构造时补 `blobSources`。
- **迁移零成本复用**: 版本系统已在 `Y.encodeStateAsUpdate(doc.spaceDoc)`→字节、`Y.applyUpdate` 还原(`NotesWorkspace.tsx`); 自定义 DocSource 的 push/pull 就是同款 Yjs 字节; `fileio.rs` 已有原子写。
- **三方案**(待用户拍板, 见末尾决策):
  - ① 保真二进制真源: 每笔记 `<id>.ydoc` 快照 + `blobs/<sha>` 文件, 自写 Rust fs; 另加 `yrs` 导出器把 .ydoc 导成 .md 供 omni 读。**保真/低成本/低迁移风险; omni 读需隔一层解码(导出 md 文本)**。← 调研推荐
  - ② 混合: md 正文文件 + sidecar JSON 存画布/AI块/坐标。**正文人读可直接改 + 画布近保真, 成本最高**。
  - ③ 纯 md 库(Obsidian 式): 最可移植, **但画布/AI块/历史会丢(BlockSuite md 是有损 Adapter 非无损 Transformer)**。
- **参考库**: AFFiNE `nbstore`(SQLite schema: updates+snapshots+blobs, private 未发包**只能照抄**)、`yrs`(Rust Yjs, 与 JS 二进制兼容, 活跃)、JSON Canvas 规范(Obsidian `.canvas`, 画布另存范本)、Tauri `tauri-plugin-sql`(绝对路径需 fork)或自写 fs 命令(推荐, 已有 fileio.rs)。排除: y-leveldb(已归档)、OPFS(沙箱内外部不可见)。

## 工作流二 · omni 关联 —— 建议
- **正向已现成**: `omni project list --json` / `omni plan list --json`(`omnicompany/.../cli/commands/project.py:113`、`plan.py:152`)。
- **反向用 decisions 域, 不新建库**: decisions 的 `anchor.kind` 枚举**本就含 `note`**(`packages/domains/decisions/formats.py`)。一条关联 = 一条 `omni decisions record --project X --anchor "note:poof-note://<id>"`; 反查 `omni decisions list --project X`。
- **笔记侧**: 复用 `editorConfig.ts` 的 `@` 范本加 `@项目/@计划`(reference `pageId="__omni:"+id` 前缀, `docLinkClicked` 拦截跳转)。
- **跳转**: `focus_window`(跳 vscode, `lib.rs:217`, 现成) + `window.open(8210)`(跳看板); `poof-note://` 回跳需注册 deep-link scheme(后做)。
- **反向注入**: notebridge 加一个 `link` op(Rust 零改, 前端 `noteOps.ts` 加 case)。
- **标签**: 分层 —— 私人临时标签留 localStorage; "关联到项目/计划"走 omni(不靠 tag 文本对齐)。
- **耦合点**: 若先做工作流一(笔记落盘到浅路径), omni 可脱离 poof 直接读笔记文件; 否则只能走 notebridge(需 poof 在跑)。

## 工作流三 · 自定义块统一 —— 建议
- **薄聚合层(BlockSuite 不自带, 我们加)**: `BLOCK_REGISTRY: BlockKind[]` + `insertBlock(doc, kind, args)` 总线。`BlockKind = {kind,title,icon,slash?,toolbar?,target,insert}`。
- **三入口消费同一份**: ① slash —— 在 `editorConfig.ts:localizeSlashMenu` 末尾把注册表生成的 `SlashMenuActionItem` append 进 `w.config.items`(`action(ctx)` 的 `ctx.rootComponent.host.doc` 能拿到 doc; slash 0.19.5 类型见 `.../slash-menu/config.d.ts`)。性价比最高, 先做。② 工具栏 —— `mountAiToolbarButton` 泛化。③ CLI —— notebridge 加 `add-block` op, `omni notes add-block --note X --kind ai`。
- **零侵入**: 不动 node_modules、不改 notebridge Rust。
- 注意: CLI 在笔记没打开时加 AI 块只落数据, 终端等用户打开才物化。

## markdown 保真 —— 建议
- 不造轮子。先在真 UI 复现打印 `clipboardData.types` 看是不是 html 抢先。
- 落地: ① 自定义 `text/plain` 适配器 prio 71, `toSliceSnapshot` 先预处理(全角→半角、补空行)再委托 `MarkdownAdapter`, 不像 md 就 `return null` 回落。② poof 容器 capture 阶段挂 paste: `Shift+粘贴`=强制纯文本(退路, 同 Notion/Obsidian)。③ 启发式判定"值不值得转"防误伤。

## 待用户拍板(决定架构 + 参考库)
1. **存储真源格式**(工作流一, 最关键): ① 保真 .ydoc + 导出 md / ② 混合 md+sidecar / ③ 纯 md。取决于 **omni "直接读笔记" 要读到什么粒度**(只要标题正文→①够; 要画布/AI块→②)。
2. 关联真源用 decisions 域(推荐)还是更轻的独立 `omni notes link`?
3. markdown 退路语义: 默认智能转(Shift=纯文本, 同 Notion) vs 默认纯文本(Shift=转)?
