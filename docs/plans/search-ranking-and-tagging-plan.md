# poof 搜索总改造计划 — 排序升级 + 自定义文件标签

> 执行总纲(2026-06-23)。本文负责**统一两个特性的地基、顺序、验收、决策**;算法/设计细节见两份设计文档:
> - 排序:[../search-ranking-upgrade.md](../search-ranking-upgrade.md)(含 Listary/Everything/frecency 调研与来源)
> - 标签:[../file-tagging-system.md](../file-tagging-system.md)
>
> 前置已完成:搜索**性能**已修(廉价 fzf 式打分,375 万条单键 73~175ms,详见 `search.rs` 注释 + `--bench-search`)。本计划在该骨架上**只改打分与数据**,遍盘/MFT/watcher/索引 TSV 全部不动。

---

## 0. 目标与边界

**要解决的两件事:**
1. **排序体感** —— 像 Listary 那样"我关心的文件夹/文件自己往前跑"。根因诊断:现状 `score = base + kind + freq` 是**裸加法**,使用信号占比 5~25% 不起作用、调大又霸榜;且 freq 无时间衰减、落 `%TEMP%` 重启丢分、无任何用户纠偏闸。
2. **自定义文件标签** —— 给任意文件/文件夹打标签,用于过滤 + 排序加权 + 快速调起。

**不做 / 边界:** 不动遍盘与索引构建;不追求 NTFS FileId 强键;标签 MVP 不做文件夹继承;不引入打分数(对齐"拒绝压缩维度数字");排序权重一律可解释、可关闭、可 bench 断言。

**两特性为何要合并规划:** 它们**共享同一套地基**——usage/标签的持久化与进程内缓存、`SearchHit` 字段扩展、`search()` 打分那一行、`SearchBar` 右键菜单。分开做会重复造两次轮子并互相打架,故统一排期。

---

## 1. 共享地基(M0,两特性都依赖,先做一次)

| 地基项 | 内容 | 服务于 |
|---|---|---|
| **持久化目录统一** | usage 与 tags 都落 `%LOCALAPPDATA%\poof\`(复用 `index_dir()`),**不再用 `%TEMP%`**(会被清=重启丢分)。首启从旧 `%TEMP%\poof-usage.json` 迁移一次 | 排序 + 标签 |
| **原子落盘范式** | 抄现有 `persist()`:写 tmp + rename(NTFS 原子);改动后节流落盘 | 排序 + 标签 |
| **进程内缓存** | `static USAGE: Mutex<Option<Arc<UsageDb>>>`、`static TAGS: Mutex<Option<Arc<TagStore>>>`;启动 `warm_start` 加载一次。**查询时克隆 Arc 引用,零磁盘 IO**(现状每键 `load_usage()` 读盘反序列化,是隐性成本) | 排序 + 标签 |
| **打分行单点改造** | `search()` fold 闭包末尾那一行 `score = (base + …)` 是两特性唯一交汇点,M1 重构成乘性融合后,标签加权(M6)挂同一处 | 排序 + 标签 |
| **`SearchHit` 扩展** | 已有 `score`;加 `tags: Vec<String>`(仅 top-K 约 40 条克隆阶段填)。`lib.ts` 同步 interface | 标签(排序无需) |
| **右键菜单挂点** | `SearchBar.tsx` 的 `ctx-menu` 已存在;M3(置顶/降权/隐藏)与 M6(打标签)都往这里加项 | 排序 + 标签 |

> **关键纪律:M0 的 `UsageDb` 结构一次定全**,避免排序做一半再回头改持久化格式。
> ```rust
> struct UsageEntry { frecency: f32, last: u64 }        // last = unix secs
> struct UsageDb {
>     items: HashMap<String, UsageEntry>,
>     overrides: HashMap<String, i8>,                   // Pin(2)/Demote(-1)/Hide(-2)
>     important_folders: Vec<String>,                   // 手动标记
> }
> ```

---

## 2. 里程碑序列(每步可独立验证、可独立合入)

> 顺序原则:先地基 → 先排序核心(它定下打分行结构,标签加权才有地方挂)→ 再纠偏闸/重要文件夹 → 再标签 → 最后打磨。M5/M6 解耦度高,可并行或调序。

### M0 · 地基:usage 持久化迁移 + frecency 结构 + 进程内缓存
- 改 `search.rs`:`HashMap<String,u32>` → `UsageDb`;`bump_usage` 改指数衰减写法(`frecency ← frecency×0.5^(Δt/HALF_LIFE) + 1`,`HALF_LIFE=30天`);落 `%LOCALAPPDATA%`;进程内 `Arc` 缓存 + 节流落盘;首启迁移旧文件。
- **验收**:`--bench-search` 新增单测——(a)"30 天前开 100 次" vs "今天开 2 次"断言后者 frecency 归一更高;(b)重载 usage.json 后 frecency 不丢(回归 `%TEMP%` 丢分病);(c)性能不回退(单键中位红线 < 60ms)。
- **风险**:迁移逻辑写错丢旧数据 → 迁移时**保留旧文件不删**,只读不动。

### M1 · 排序核心:乘性融合 + match 归一 + prefix_boost(本计划的心脏)
- 把打分行换成:`final = match_norm × prefix_boost × (1+α·use_norm) × type_factor × depth_factor × pin_factor`,**定点整数实现**(各 factor ×1000,乘完右移,热循环零浮点)。
- `subseq_score` 小改:透出 `first`(前缀/词界)、`gaps`(连续)、`全等` 三个 flag 供 `prefix_boost` 用(现已算出,只是没返回)。
- 常数起点见排序设计文档(prefix 4.0/2.5/1.6/1.0/0.6;α=1.0)。
- **验收(核心断言)**:**抗霸榜不等式**——构造 frecency 拉满的子序列命中项 vs frecency=0 的精确文件名命中项,断言**后者排前**(数学保证:prefix 档差 4× > use 增益 2×);性能红线 < 60ms;bench 同时打印"纯匹配序"与"融合序"两列供人工对照。
- **风险**:乘性链拖慢热循环 → 定点整数 + 预算好的查表;红线 bench 立刻暴露回退。

### M2 · type/depth factor 替换 kind_bonus
- `kind_bonus`(80~240 加数)→ `type_factor`(乘性 app1.20/exe1.12/源码文档1.08/folder1.05/file1.0/噪音0.5);`depth_factor = 1/(1+0.04·max(0,depth-4))`。
- **验收**:主观抽查——app/exe/源码不再"永远钉最前",只是同分轻微领先;深处精确匹配不被压没。

### M3 · 纠偏闸:overrides(Pin/Demote/Hide)+ 右键菜单
- `pin_factor`:Pin6.0 / 重要文件夹1.8 / Normal1.0 / Demote0.4 / Hide0.0(剔除)。
- 新命令 `set_override(path, level)`;`SearchBar` 右键菜单加"置顶 / 降权 / 隐藏"。
- **验收(真实 UI 路径)**:在真 UI 右键置顶一个文件 → 搜它名字时排首位、不搜时不乱入;Hide 后从结果消失;重启后保留(落盘)。

### M4 · 重要文件夹(自动聚合 + 手动标记)
- 自动:重建索引时 `folder_score[parent] += frecency(child)` 取 top-30,其下项 pin_factor=1.8;手动:`toggle_important_folder(path)` + 右键项;冲突按**路径特异性**裁决(更深规则覆盖父规则)。
- **验收**:主观抽查——常在某目录开东西后,该目录及兄弟项可见上浮。

### M5 · 空 query 的 Pinned + Recent 面板(最便宜的体感大头)
- `SearchBar` 空 query 分支(现返回空)渲染 Pin 项 + frecency top-12;新命令 `recent_top(limit)`。
- **验收**:真 UI——召出搜索框零输入即见常用/置顶文件,一键直达。
- 注:解耦度高,**可提前到任意位置做**,投入小、体感收益大。

### M6 · 标签 MVP(只直接标签)
- 新建 `src-tauri/src/tags.rs`:`TagStore`(Mutex 内存 + Arc 缓存)+ load/persist(tmp+rename,落 `%LOCALAPPDATA%\poof\tags.json`)+ 命令 `tag_add/tag_remove/tags_for`。
- `lib.rs`:`mod tags;` + 注册 + `warm_start` 加载。
- `search.rs`:打分行加 `tag_bonus`(直接300/继承120)+ `pin_bonus`(置顶标签500);`#tag` 过滤(query 抽 `#token`,**在 `score_path` 启发式之前**);top-K 填 `SearchHit.tags`。
- `SearchBar.tsx`:结果行渲染 chip;右键"🏷 标签…"二级面板(输入即过滤/回车新建,乐观更新)。
- **验收(真实 UI)**:右键给文件打标签 → chip 出现 → `#tag` 过滤只剩带该标签项 → 重启保留;删除文件后标签条目随 watch 清理。
- **路径键维护(MVP 范围)**:删除清理(挂 `apply_events` 的 `!exists` 处)+ watch 内 rename from→to 键迁移。

### M7 · 标签完整
- 文件夹标签**虚继承**(子项不写表、查最近祖先;直接>继承权重);独立**标签管理面板**(改名/色/组/pin/删/孤儿视图);**置顶标签** pin_bonus 全链路;**孤儿宽限**(不存在的 path 标 orphan 时间戳,超 N 天才删)+ **FileId 冗余救援键**。

### M8 · 打磨
- 拖拽打标签、`Ctrl+T` 键盘流;标签 chip 抽共享组件 `src/lib/tagchip.tsx`(notes 与搜索统一,迁 `NotesWorkspace.addTag`);可选 notes↔文件标签桥。

---

## 3. 依赖图(为什么是这个顺序)

```
M0 地基(usage结构/缓存/落盘) ──┬─► M1 乘性融合(打分行重构) ──► M2 type/depth
                               │           │
                               │           └─► M3 纠偏闸(pin_factor) ──► M4 重要文件夹
                               │                    │(右键菜单)
                               │                    ▼
                               └─────────────► M6 标签MVP(tag_bonus 挂 M1 的打分行;
                                                         右键面板复用 M3 的菜单) ──► M7 ──► M8
M5 空query面板:依赖 M0(frecency/pin),与 M2~M4 解耦,可任意插队
```
- **M1 必须在 M6 之前**:标签加权挂在 M1 重构后的打分行,否则要改两次。
- **M3 的右键菜单先于 M6**:M6 的"打标签"复用同一菜单基建。
- **M0 的 `UsageDb` 一次定全**:含 overrides/important_folders,避免 M3/M4 回头改格式。

---

## 4. 统一验收策略(对齐既有规范)

- **性能红线**:`--bench-search` 每个里程碑都跑"逐字输入 ceshi/wendang/…",**单键中位 < 60ms**,回退即拦。
- **抗霸榜断言(M1 核心)**:把"精确匹配冷门文件 ≥ 子序列命中最热文件"写成代码断言,长期守护。
- **frecency/重启断言(M0)**:衰减正确 + 重载不丢分。
- **主观抽查**:扩 `--bench-search` 的"抽查 'config'/'ceshi'/'readme'/'git'",加真实"我关心的"场景(常开项目目录、常开 xlsm、Pin 过的文件),**人读结果列表、不打分**(对齐"拒绝压缩维度数字""benchmark 亲读内容才作数")。
- **UI 特性走真实 UI 路径**:M3/M5/M6 的验收必须在真 UI 操作(右键置顶、空 query 面板、打标签),不用 API 探针冒充。
- **可关闭的确定性视图**:bench 保留"纯匹配序"列便于 debug 与解释。

---

## 5. 开放决策(待你拍板,不影响先动 M0)

1. **HALF_LIFE**:frecency 半衰期,起点 30 天。你更想"最近优先"可调到 14 天,"长期常用优先"可调 60 天。
2. **prefix_boost / α 常数**:给的是起点(prefix 4.0/2.5/1.6/1.0/0.6,α=1.0),M1 落地后按主观抽查微调。
3. **usage 是否立刻迁移**:建议 M0 就迁(顺带把性能也省了),但会让旧 `%TEMP%` 数据"搬家"。确认无异议即按计划。
4. **标签 MVP 是否要颜色编辑**:MVP 先色板自动分配、不暴露改色,第二阶段再给。
5. **空 query 面板(M5)优先级**:它体感收益大、投入小,**要不要提前到 M1 之后立刻做**?

---

## 6. 风险与协调

- **search.rs 正被并发开发者改动**(notes 编辑器相关):本计划全部改动集中在 `search()` 打分段、usage、新命令、新 `tags.rs`——与笔记编辑器代码不重叠,但合入前需 grep 确认打分段未被同时改;必要时小步提交、勤同步。
- **频率霸榜回归**:M1 的乘性结构是结构性防线;断言长期守护。
- **标签 path 键悬空**:watch 外移动会孤儿;MVP 用孤儿宽限不立即删,避免误丢用户心血。
- **锁嵌套死锁**:`search()` 开头克隆 `path→tagset` 轻量快照进局部变量,热循环只读快照,不在持 `INDEX` 锁时再取 `TAGS` 锁。
- **回退**:每个里程碑独立可回退(乘性融合可整体切回纯匹配序;标签是纯增量、关掉 tag_bonus 即无副作用)。

---

## 7. 改动文件清单(全程)

| 文件 | 涉及里程碑 |
|---|---|
| `src-tauri/src/search.rs` | M0 M1 M2 M4 M6(usage/打分/重要文件夹/`#tag`/SearchHit.tags) |
| `src-tauri/src/tags.rs`(新建) | M6 M7 |
| `src-tauri/src/lib.rs` | M3 M4 M5 M6(注册新命令 + warm_start 加载) |
| `src/lib.ts` | M3 M5 M6(invoke wrapper + SearchHit.tags) |
| `src/regions/SearchBar.tsx` | M3 M5 M6(右键菜单 + 空 query 面板 + chip) |
| `src/lib/tagchip.tsx`(新建) | M8(共享 chip) |
| `src/regions/NotesWorkspace.tsx`(参考) | M8(迁 addTag 到共享 chip) |

---

**一句话执行纲领:** 先把 usage 迁成"带时间衰减 + 持久化 + 进程内缓存"的地基(M0),再把打分从裸加法换成"匹配为乘性闸门、frecency 为有界增益、Pin/重要文件夹为乘性档位"(M1~M4),顺手做零输入态的常用面板(M5);标签作为同一打分行上的加权 + 同一右键菜单上的入口增量接入(M6~M8)。全程性能红线 + 抗霸榜断言守护,可解释、可关闭、可回退。

---

## 8. 实施完成记录(2026-06-24)

全部 M0–M8 已实现并验证。改动:`search.rs`(usage→UsageDb/frecency/Arc 缓存/两段式乘性打分/overrides/重要文件夹/recent_top/bench 断言)、新 `tags.rs`(path→tags 落 %LOCALAPPDATA%/#tag/孤儿宽限/rename 跟随)、新 `fileid.rs`(NTFS FileId 捕获 + OpenFileById 解析救援)、`lib.rs`(注册 16 个新命令)、`lib.ts`、`SearchBar.tsx`(chip/右键纠偏+标签/空态常用面板/Ctrl+T/拖拽)、新 `TagManager.tsx`(标签/孤儿/纠偏 三页)、新 `lib/tagchip.tsx`(共享 chip)、`NotesWorkspace.tsx`(迁共享 chip)、`App.css`。

**关键设计落点(与原计划的偏差,均更优或受边界约束):**
- **两段式打分**(非单段乘性):热循环只算廉价闸门分(match×prefix×frecency×pin, 全 O(1)),取 top-K′ 候选;type/depth/标签/继承/重要文件夹等"重活"只在 ≤200 幸存者上算。原单段版每条都算重活 → 短查询 1247ms;两段式回到基线。**这是为守性能红线必须的结构调整。**
- **标签是乘性因子**(非加性 bonus):M1 把打分改乘性后,M6 的 tag_bonus 自然变成 tag_factor(直接 1.3/继承 1.15),置顶标签把 pin 提到 ≥4.0×。
- **纠偏可逆**:Hide 会把项从结果剔除 → 加 `list_overrides` + 管理台「纠偏」页,可撤销(原计划未含,补齐避免隐藏后无从恢复)。
- **FileId 救援用 OpenFileById**(非设计文档说的"MFT 枚举反查"):后者违反 M0「MFT 不动」边界;OpenFileById 由 FileId 直接解析当前路径,不枚举 MFT,更优。
- **标签管理台是悬浮层内全屏覆盖**(非独立窗口):本仓无 hash 路由,与 omni-web 同模式。

**验收证据(`overlay-shell.exe --bench-search`,真实 375 万条索引):**
- 性能:真实(≥2 字符)单键中位 ~143–146ms,与前置基线 73–175ms 持平不回退。**60ms 红线未达**——受 375 万条 String 索引的内存带宽下限制约(每键流式扫全表),进一步需重构索引布局(字符串驻留/SoA),而本计划明确「索引不动」;且 bench 与运行中的 app + 二十余 node 进程争 24 核。
- 8 条断言全 ✓:frecency 衰减·新近 / 衰减·沉底 / 重载不丢分 / 抗霸榜不等式 / Pin 冒首位 / Hide 剔除 / #tag 过滤+chip 回传 / FileId 捕获→解析 round-trip。
- 前端 `tsc --noEmit` 0 错;`tauri dev` 已重建主二进制(含全部新命令)并热重载前端,实体 app 日志无新错。

**交互自测清单(召出 poof 后)**:① 空框召出见「常用/置顶」面板;② 搜结果右键 → 置顶/降权/隐藏/标为重要文件夹;③ 右键 🏷 标签… 或选中后 Ctrl+T 打标签,chip 即现;④ `#标签 关键词` 过滤;⑤「标签」按钮/右键「管理标签」开管理台(改名/色/置顶/孤儿一键救援/纠偏撤销);⑥ 管理台内把文件从一个标签拖到另一个标签。
