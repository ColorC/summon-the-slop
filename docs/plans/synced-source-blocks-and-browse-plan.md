# 笔记 · 同步源块 + 浏览面板 · 调研与计划

> 状态: 调研已回, 架构已选, 待用户拍板 3 个开放项后开工。
> 上游: 本计划承接 [`notes-storage-omni-link-and-blocks-plan.md`](./notes-storage-omni-link-and-blocks-plan.md)
> —— 存储落盘(工作流一)已实现、omni 关联做成了"内联引用"(工作流二, omniLink.ts)、统一块注册表(工作流三)未做。
> 本计划把"引用/代码块"升级成**绑定到源、可原地编辑、双向同步、带历史**的内容块, 并重做搜索/浏览面板。

## 0. 这次要解决的四件事(用户原话归并)

1. **markdown 进笔记现在变成一个代码块, 不对** —— 应作为独立的原生内容块(标题/列表/段落…)加入。
2. **搜索结果全是图标、没有文字, 看不出谁是谁** —— 网格视图要显示文本内容(不是文件图标); 新增列表视图; 窗口变大; 并能浏览 Omnicompany 的**审阅材料 / 计划 / 任务**三类列表。
3. **omni 的审阅材料 / 计划 / 任务也能作为块放进笔记**。
4. **(再三强调)无论什么东西作为内容块加进去, 编辑都要同步回源, 且编辑最好能进历史记录。**

**贯穿四件事的硬核 = 一个机制**: "把外部源(markdown 文件 / omni 实体)绑定成可原地编辑、双向同步、带历史的块"。第 1、3、4 是同一个引擎的不同源类型; 第 2 是这个引擎的"挑选/插入入口"的 UI。

---

## 1. 调研结论(两路并行已回, 结论一致)

### 1.1 BlockSuite 0.19.5 原生能力(已对着 v0.19.5 源码核过)

| 能力 | API / 块 | 它到底做什么 |
|---|---|---|
| 活嵌入(可双向编辑) | `affine:embed-synced-doc` | **把另一个 doc 原地、可编辑地嵌进来**, 内部挂一个嵌套编辑器跑在同一个 Y.Doc 上 —— 天生双向(它是视图不是拷贝), 自带循环/深度防护 |
| 引用卡片(只读) | `affine:embed-linked-doc` | 静态预览卡(标题/图标), 不渲染正文 |
| 内联引用 | `affine:reference` | 文字里的 @ 提及(omniLink.ts 现在用的就是这个) |
| md ⇄ 块 | `MarkdownAdapter`(`toDoc`/`fromDoc` 等) | **能把 markdown 串解析成原生块, 也能把块序列化回 markdown**; 引擎是 unified+remark+gfm+math, **GFM 表格/任务列表/删除线/公式两向都支持** |
| 块↔快照 | `Job`(0.19.5 还叫 Job, 不是 Transformer) | `docToSnapshot`/`snapshotToDoc`/`blockToSnapshot` 全量/单块导出导入 |
| 多 doc / 子文档 | `collection.getDoc/createDoc` | 一个 collection 装多个 doc, 每个是独立 Y.Doc 子文档(poof 现在每条笔记就是一个 doc) |

**关键: md⇄块的保真度**(决定方案)
- **块→markdown(`fromDoc`)有损**: 嵌入块、画布、超出 GFM 的表格、附件、**以及每个块的稳定 ID** 都没法塞进 markdown —— 这是所有同类软件都撞的硬墙。
- **markdown→块(`toDoc`)安全**: 标准 markdown 干净映射, 不认识的语法降级成段落/代码而非损坏。

### 1.2 同类软件的共识(SiYuan / AFFiNE / Logseq / Obsidian / Notion 实测)

**做成功"原地可编辑的块级转嵌"的软件, 都不把 markdown 当磁盘真源。** 它们留一份富格式(JSON AST 或 CRDT)做真源, markdown 只当有损的导入/导出视图。

- **SiYuan(思源)** 最典型: 每个 doc 是 `.sy`(块树 JSON), SQLite 只是可重建索引, markdown 仅导入导出。作者明确从 markdown 切到 JSON, 原因正是"原地编辑的块级转嵌需要每个块有跨编辑/移动都稳定的 ID, 而标准 markdown 没地方放这个 ID"。
- **AFFiNE**(BlockSuite 自家): synced block 就是上面的 `embed-synced-doc`, 双向, 历史走 Yjs 快照(服务端 `DocHistory` + 非破坏性 `recoverDoc/rollbackDoc`)。
- **Logseq**: 赌"markdown 即真源", 代价是每次往返**改写并重排文件**(注入 `id::`、给每行加 `-`、动缩进), 破坏 grep/他者编辑, 用户抱怨"伤数据安全感"。
- **Obsidian**: 文件保持干净, 代价是**核心里嵌入只读**(没法原地编辑), 正因为没地方锚定稳定块 ID。

**三选一, 必须选边**: (a) 富格式做真源、markdown 有损(SiYuan/AFFiNE/Notion/多数) · (b) markdown 做真源但污染+重排文件(Logseq) · (c) markdown 干净但嵌入只读(Obsidian)。

> 引用(主要源): BlockSuite v0.19.5 `embed-synced-doc-block.ts` / `markdown.ts` / `job.ts`; AFFiNE synced block discussion #6299; SiYuan 数据模型(deepwiki) + 作者 FAQ(markdown→JSON); Logseq issue #3626/#7362; Obsidian 嵌入原地编辑特性请求(未实现)。完整链接见 §10。

---

## 2. 架构选型

### 选项 A(推荐)· 绑定子文档 + embed-synced-doc + 同步适配层
每个外部源(一个 .md 文件、一个 omni 实体)= **一个独立 BlockSuite 子文档**(真源就是这个 Y.Doc); 通过 `affine:embed-synced-doc` 原地、可编辑地嵌进笔记; 一个**同步适配层**镜像"子文档 ⇄ 外部源"(导入解析 / 导出防抖写回, 带冲突闸)。

- **白拿**: 原生块编辑、撤销重做、Yjs 历史(子文档是真 doc); 双向原地编辑(embed-synced-doc 已实现嵌套编辑器+循环防护, 不用自己搓)。
- **统一**: .md 文件和 omni 实体都收敛成"一个子文档 + 一个源适配器", 第 1/3/4 三件事一套机制。
- 这正是 SiYuan/AFFiNE 验证过的赢法, 落在我们的栈上; 也符合"用现成组件别手搓"的纪律。

### 选项 B · 自定义块内挂嵌套编辑器
`defineBlockSchema` 定 `poof:bound-source`, 自己渲染嵌套编辑器 + 自己的源徽标/同步状态/冲突条/打开文件按钮。**更可控但要重造** embed-synced-doc 已经给的循环防护、选区、工具栏。**仅当某类源需要专属 UI**(如审阅材料要"通过/驳回"条)才上。

### 选项 C · 代码块 + 渲染开关(现状)
markdown 当原始文本塞 `affine:code`, 切渲染预览。**零往返风险(文件字节级保真)、零成本, 但没有富编辑/原生块/转嵌语义**。**保留为兜底**: 给"必须字节保真"的源(配置文件等)和"看原文"逃生口。

### 决定
**A 为主**; **B 用于需要专属操作条的 omni 实体类型**(如审阅材料的通过/驳回); **C 保留为按源可选的"原文/只读"模式**。三者共存, 按源类型与保真要求路由。

---

## 3. 统一数据模型与同步引擎(核心, 第 1/3/4 共用)

### 3.1 真源与投影
- **子文档(Y.Doc)= 编辑真源**; 外部源(.md 文件 / omni 实体)= **投影**(同步出去), 不是直接编辑面。
- 每条笔记里嵌入的一个绑定块 → 指向一个绑定子文档 → 绑定一个外部源。

### 3.2 绑定元数据(存子文档 docMeta 或一个包装块 props)
```
{
  sourceKind: "md-file" | "omni-review" | "omni-plan" | "omni-task",
  sourceRef:  <绝对路径 | mat_id | plan_id | task_id>,
  lastSyncedHash:     <上次同步时外部源原文的 hash>,
  lastSyncedSnapshot: <上次同步时子文档的全量快照(三路合并的 base)>,
  baseRevision:       <外部源的版本号/mtime, 若有>,
  mode:               "synced" | "readonly" | "raw"
}
```

### 3.3 同步两向
- **导入(外部→子文档)**: 读源 → md 走 `MarkdownAdapter.toDoc({file})`; omni 实体取内容后转块。记录 `lastSyncedHash` + 子文档快照。
- **导出(子文档→外部, 防抖)**: 监听 Yjs update → 防抖(空闲 ~800ms–2s)→ md 走 `MarkdownAdapter.fromDoc` 写文件 / omni 走 CLI 写回。**失焦/关块/退应用前强制 flush**; 原子写(临时文件+rename)。

### 3.4 冲突闸(三路合并, 不盲覆盖)
写回前**重读源**: 现 hash ≠ `lastSyncedHash` 说明外部被改过 → base=上次同步快照、theirs=当前磁盘、mine=子文档导出, **三路合并**; 合不了就弹冲突 UI(留两份/择一), **绝不静默覆盖**。文件加 fs watcher / omni 订阅变更事件, 尽量把外部改动实时拉进来, 缩小冲突窗。

### 3.5 历史(满足"编辑进历史记录")
- **以子文档的 Yjs 快照为权威历史**(同 AFFiNE 的 `DocHistory`)。复用现成 `noteVersions.ts`(已是"全量 Yjs 快照→字节"), 扩展成也给绑定子文档存版本。
- 外部源自身历史(plan 的 git、omni 修订)当**二级日志**; 外部回滚 → 作为一次**新的**子文档编辑导入(进 Yjs 历史), 不去倒带 Yjs 对齐。每次同步事件打上外部版本号便于对照。

### 3.6 markdown 保真闸(防止写坏用户的 .md)
- md 文件绑定时, **把可编辑块约束在 markdown 可表达范围**(标题/段落/列表/代码/引用/分割线/GFM 表格); 用户插入不可表达的块(图片/画布/AI 块)时**提示"这块存不进 markdown"**。
- 写回前跑**往返 diff 自检**: `fromDoc` 出 md 后再 `toDoc` 回来比对, 探到有损就拦下、警示, 不写。

---

## 4. 需求展开

### 需求 A · markdown 文件 → 原生块(不再是代码块)+ 写回 + 历史
**现状**(fileInsert.ts): 所有文本类(含 .md)走 `kindOf→"text"→affine:code`(因为 .md 在 `CODE_LANG` 字典里), 当源代码处理。写回只对代码块(localStorage 绑定 + yText 观察 + 防抖 `flushBlock`)。
**目标行为**:
- 拖入 / 搜索插入一个 .md → 解析成**原生块**(标题/列表/段落/代码…), 渲染好看, 不是一坨代码。
- 在笔记里改这些块 → **写回源 .md 文件**(防抖、原子、冲突闸)。
- 改动**进版本历史**(子文档 Yjs 快照)。
- 提供"看原文 / 只读"模式(选项 C)做逃生口与字节保真需求。
**做法**: 在 fileInsert 的文本分支前加 `isMdPath` 判定走"绑定子文档"路径(§3); 非 md 文本/配置仍可走代码块+写回(现状, 字节保真)。
**注**: markdown **粘贴**已能转块(markdownPaste.ts, PoofMarkdownAdapter prio 91)—— 能力已在, 本需求是把**文件插入**也接上同一套解析, 并加"绑定子文档"使其可写回。

### 需求 B · 搜索 / 浏览面板重做(文本 + 列表视图 + 大窗 + omni 列表)
**现状**(editorConfig.ts): `FileSearchConfig` 的 `@` 菜单与 `installFileTemplateSearch` 改的模板面板, 结果**只有图标(`fileIconSvg`, SVG+扩展名)+文件名**, 无任何文本/预览; 模板面板是网格; 无列表视图; 窗口尺寸用 BlockSuite 默认。
**目标行为**:
- **网格视图显示文本内容**: 文件结果带内容预览片段(读前 N 字符); 不再只给文件图标。
- **新增列表视图** + 网格/列表切换。
- **面板/窗口变大**(给文本和列表留地方)。
- **能浏览 omni 三类列表**: 审阅材料(`omni review list`)、计划(`omni plan list --json`)、任务/进度(`omni progress list --json`, 按 plan/project 分组, 即 8210"任务窗口")—— 在面板里分类浏览、搜过滤, 选中即可作为块插入(接需求 C)。
**做法**: 扩展搜索结果数据结构加 `textPreview` / `kind` / `source`; 模板/菜单渲染加文本; 加视图切换与尺寸; 加 omni 数据源(复用 omniLink.ts 的 `omniProjects/omniPlans` 模式, 新增 review/task 拉取)。参考主 UI 已有的 `SearchBar.tsx` HitRow(已显示路径文本)。

### 需求 C · omni 审阅材料 / 计划 / 任务 作为同步块
**现状**(omniLink.ts): omni 项目/计划只做成**内联引用**(一个空格+attributes, 不可编辑, 只跳转)。
**目标行为**: 从面板(需求 B)选一个 omni 实体 → 作为**可原地编辑的绑定块**插入(§3 引擎), 编辑双向同步、带历史。
- **计划**本质是磁盘上的 markdown 文件(omnicompany/docs/plans/…)→ 直接复用 md 文件同步(写回计划 .md)。
- **任务/进度**是进度时间线条目 → 取 `omni progress list --json` 的 `text` 转块; 写回 `omni progress edit <id> --text …`(简单时间戳笔记, 写回相对安全, 可先开)。
- **审阅材料**是治理产物(`omni review list` / show)→ 取内容转块; **先只读+实时刷新, 不写回**(写回涉及审阅判定, 后议)。
- **⚠ 写回 omni 记录有风险**: 计划(md 文件)与进度(progress edit)写回安全先开; 审阅先只读。全过冲突闸, 不静默覆盖。
**做法**: 在 §3 引擎加 `omni-plan`(=md-file 适配器指向计划文件)、`omni-progress`(list/edit)、`omni-review`(只读) 三个源适配器。需要专属操作条(如审阅"通过/驳回")的用选项 B 的自定义块外壳。

### 需求 D(横切)· 一切内容块同步到源 + 历史
- **统一**: 凡"绑定了外部源"的块, 都走 §3 同一套(导入/导出/冲突/历史)。源适配器是唯一可插拔点(`md-file` / `omni-*` / 未来更多)。
- **历史**: 复用 `noteVersions` 扩到绑定子文档; 每次同步打外部版本号。
- 不绑定源的普通块(随手写的笔记正文)不受影响, 照旧只进笔记自己的历史。

---

## 5. 测试列表

### 引擎层(单元 / golden)
- [ ] md→块→md **往返 golden**: 可表达内容(标题/列表/段落/代码/引用/GFM 表格)字节稳定; 不可表达内容(图片/画布)被探到并警示, 不静默写坏。
- [ ] 三路合并: base/theirs/mine 三种组合(仅本地改 / 仅外部改 / 双改可合 / 双改冲突)各自正确, 冲突弹 UI 不覆盖。
- [ ] 防抖与 flush: 连续输入只写一次; 失焦/关块/退应用前一定落盘; 崩溃不留半截文件(原子写)。
- [ ] 历史: 改绑定块 → 存版本; 能列、能恢复; 外部回滚作为新编辑进历史。
- [ ] 保真闸: 往用户 .md 插入不可表达块 → 拦下+提示, 文件不被写坏。

### 同步行为(集成)
- [ ] 改笔记里的绑定块 → 对应源 .md 文件内容/mtime 变化(且是干净 markdown, 非 Logseq 式污染)。
- [ ] 外部改 .md(另一个编辑器)→ 笔记里的块拉到更新 / 冲突走合并。
- [ ] 计划块: 改 → 写回 omnicompany 对应 plan .md; `omni plan show` 能读到改动。
- [ ] 审阅材料/任务块: 只读模式刷新到最新; (若开写回)改 → CLI 变更生效且过冲突闸。

### 真实 UI e2e(Playwright 驱动真 NotesWorkspace, 同笔记标题修复那次的离屏台)
- [ ] 拖入一个 .md → 侧栏/编辑区**渲染出原生块**(不是一坨代码块); 截图核对标题/列表确实分块。
- [ ] 在块里改一行 → 磁盘 .md 文件相应变化(读盘核对)。
- [ ] 插入一个 omni 计划 → 面板能浏览计划列表、选中、原地看到计划正文块。
- [ ] 搜索面板: 网格视图每条**显示文本预览**(不再只图标); 切到列表视图显示文本; 窗口比现在大。
- [ ] omni 三类列表(审阅/计划/任务)能在面板里分类浏览+过滤。

### 回归
- [ ] 现有"文件块/图片/PDF/AI 块/markdown 粘贴/笔记标题"不破。
- [ ] 不绑定源的普通笔记块编辑、保存、历史照旧。

---

## 6. 落地分期(依赖顺序)

1. **引擎地基(§3)**: 绑定子文档 + embed-synced-doc 接入 + 同步适配层骨架(先 md-file 一种源)+ 冲突闸 + 往返保真闸 + 历史接 noteVersions。── 先把"一个 .md 双向同步带历史"打通(需求 A 全绿)。
2. **插入入口 + 浏览面板(需求 B)**: 搜索结果文本预览 + 列表/网格切换 + 大窗; 把"插入 md 文件"接到引擎(取代代码块)。
3. **omni 源适配器(需求 C)**: 先 `omni-plan`(=md 文件同步, 复用 1); 再 review/task **只读+刷新**; 写回按 kind opt-in(待 §9)。
4. **统一收口(需求 D + 旧计划工作流三)**: 把文件块/omni 块/AI 块收进统一"块注册表 + 插入总线"(slash/工具栏/CLI 三入口一份), 顺带补 notebridge `add-block` op。

> 建议优先级: 1(地基, 一条 md 全绿) → 2(看得见、用得上) → 3(omni 价值) → 4(收口防膨胀)。

---

## 7. 关键风险与缓解(摘 §1/§3)
- **markdown 往返有损 → 写坏用户文件**(头号风险): 子文档做真源、md 当投影; 约束可表达块 + 往返 diff 自检 + 警示, 不静默写。
- **外部改动与本地编辑打架**: `lastSyncedHash`+base 快照三路合并; fs watcher / omni 订阅缩小窗口; 冲突弹 UI。
- **防抖丢最后一笔/狂写文件**: 空闲防抖 + 失焦/关/退强制 flush + 原子写。
- **两套历史发散**: 以子文档 Yjs 为权威, 外部历史当二级日志, 外部回滚作为新编辑导入。
- **embed-synced-doc 的撤销作用域**(BlockSuite 细节): 嵌套编辑器用 `readonly:true` 开内 doc, 撤销栈是按 doc 不与宿主共享 —— 用户在嵌入里编辑后按宿主的 Ctrl-Z 可能不撤。落地时在真 UI 验证, 不符预期则改用选项 B 自管撤销/只读接线。
- **⚠ 写回 omni 治理记录**: 默认只读+刷新, 写回显式 opt-in + 冲突闸(见 §9)。
- **版本钉死**: 0.19.5 用 `Job`(非 `Transformer`); 适配器封一层 poof 门面, 将来升级 BlockSuite 一处改。

---

## 8. 复用与不重复造
- 嵌入/双向编辑: 直接用 `affine:embed-synced-doc`(别自搓嵌套编辑器)。
- md⇄块: 用 `MarkdownAdapter` + `Job`(别自写 markdown 解析/序列化)。
- 历史: 扩 `noteVersions.ts`(已是 Yjs 快照落盘)。
- omni 数据: 复用 omniLink.ts 的 `omniProjects/omniPlans` 拉取模式 + notebridge 桥; 新增 review/task 拉取。
- 落盘/原子写: 复用 fileNotesStore 的 FileDocSource/FileBlobSource + Rust fileio。

## 9. 决定(2026-06-25 用户已拍)
1. **"任务"= `omni progress`(进度时间线条目)**。8210 看板的"任务窗口"就是按 主线/北极星(goal/plan)分组渲染这些进度跟进。
   - 数据: `omni progress list --json` → `{id, ref_type(plan/project), ref_id, text, by, created_at}`(可按 plan/project 过滤)。
   - 写回: `omni progress edit <id> --text …`(还有 add/remove)。进度条目是简单时间戳笔记, **写回相对安全**(比审阅材料低危)。
2. **omni 写回 = 先只读+实时刷新, 写回按 kind 显式 opt-in + 冲突闸**。优先级: 计划(md 文件)、进度(progress edit)写回安全可先开; 审阅材料是治理产物, **先只读**。
3. **md 文件真源 = 子文档做真源、.md 当投影 + 约束可表达块 + 往返自检**(SiYuan/AFFiNE 赢法); 个别字节敏感文件走选项 C(代码块/只读)。

> 三项已定, 可开工。下面按此细化。

## 10. 引用(主要)
- BlockSuite v0.19.5: `embed-synced-doc-block.ts`、`_common/adapters/markdown/markdown.ts`、`transformer/job.ts`、`adapter/base.ts`(github.com/toeverything/blocksuite, tag v0.19.5)
- AFFiNE synced block "like Notion": blocksuite discussions #6299; 历史模型: AFFiNE backend doc storage / `DocHistory`
- SiYuan 数据模型(.sy=JSON, SQLite 可重建): deepwiki siyuan-note/siyuan 2.2; 作者 markdown→JSON FAQ: liuyun.io/article/1689415726175
- Logseq 文件污染/重排: github logseq/logseq #3626、#7362; Obsidian 嵌入原地编辑(未实现): forum.obsidian.md/t/…/15339
- Notion synced blocks: notion.com/help/synced-blocks
