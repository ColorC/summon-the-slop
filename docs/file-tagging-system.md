# poof 自定义文件标签系统 — 设计方案

> 已核对真源:`search.rs`(索引 `Entry=(kind,name,path,pinyin)` / `subseq_score` / `usage.json` 落盘 / `index.tsv` 原子持久化 / `notify` watch)、`lib.rs`(`invoke_handler` + `open_path` 里 `bump_usage`)、`lib.ts`(`SearchHit`/`invoke` 桥)、`NotesWorkspace.tsx`(`TAGS_KEY`=`noteId->string[]` 笔记标签)。接口名/落盘路径/挂点均对齐现有代码。

## 三条核心判断
1. **标签存 Rust 侧、与 usage 同策略**(`%LOCALAPPDATA%\poof\tags.json`),**不放 localStorage** —— 标签要进 Rust 热循环打分,localStorage 在 webview 里 Rust 读不到;且标签是跨窗口共享的真源。
2. **path 作键 + "软维护"(rename 跟随 + 孤儿宽限)**,不追求 NTFS FileId 强键(成本/收益不划算,FileId 留作孤儿自愈的冗余救援键)。
3. **不复用 notes 的 `TAGS_KEY`**(键空间是 docId 非 path),但**前端复用同一套 chip 视觉/交互**。

## ① 数据模型(定义与赋予解耦)
```rust
struct TagDef { name: String, color: String, group: Option<String>, pin: bool, created_ms: u64 }
type PathTags = HashMap<String, Vec<String>>;   // path -> tag id 列表
```
- 颜色:新建时从 8~12 色板按已用数取模分配,可改。
- 分组:纯展示/组织,不影响打分。
- **文件夹标签递归 = "虚继承"(弱信号,不写进 PathTags)**:给 `E:\Proj` 打 `#wip`,子项不产生条目,而在打分时查"最近祖先文件夹有无标签"。好处:不爆炸、文件夹标签改了子项立即跟随、子项可叠加自己的直接标签。直接标签权重 > 继承标签。**MVP 先不做继承**(直接标签覆盖 80% 诉求)。

## ② 存储与 path 键维护
- 落 `%LOCALAPPDATA%\poof\tags.json`(复用 `index_dir()`;**注意现有 usage.json 在 %TEMP% 会被清,标签不能学这一点**)。单 JSON `{defs, paths}`,写 tmp+原子 rename(抄 `persist()`)。`warm_start` 里 `load_tags` 进内存。
- **删除**:挂在 `apply_events` 检测 `!path.exists()` 处,顺手删标签条目。
- **改名/移动(watch 内)**:notify 给 rename from→to 配对,把 PathTags 键从 from 迁 to。
- **watch 外移动**:周期 `warm_index` 后做孤儿清理 —— 不存在的 path 不立即删,标 orphan 时间戳,超 N 天才删;标签面板出"孤儿视图"让用户重新指认。
- **FileId**:不做主键(取它要 CreateFile,375 万条不可能预取;跨卷仍变)。第二阶段作冗余救援键:打标签时顺手记一份 FileId,孤儿自愈时按 FileId 在 MFT 枚举里反查新 path。

## ③ 打标签 UX(复用现有 ctx-menu)
- **A. 搜索结果右键"🏷 标签…"(MVP 主入口)**:二级面板显示当前 chip(点×移除)+ 输入框(输入即过滤已有/回车新建),即时 `invoke("tag_add",{path,tag})`,无"保存"按钮(乐观更新)。
- **B. 标签管理面板(完整)**:左=标签列表(按 group 分组,改名/色/组/pin/删)、右=该标签下所有文件、顶=孤儿视图。可走 `open_view("tags")`。
- **C. 拖拽打标签**(锦上添花,webview 内 DOM 拖拽)。
- **D. 键盘流**:结果选中态 `Ctrl+T` 直接唤起标签输入(贴合纯键盘哲学)。

## ④ 标签进搜索
- **`#tag` 过滤**:query 里 `#` 开头 token 抽为标签过滤器(AND),其余作模糊词;裸 `#wip` = 按标签浏览。热循环里不命中要求标签直接早退(同现有 `(None,None)=>return heap`)。⚠ 解析要在 `score_path` 启发式之前抽掉 `#token`。
- **加权(对接现有打分行)**:
  ```rust
  let tag_bonus = if has_direct_tag {300} else if has_inherited_tag {120} else {0};
  let pin_bonus = if any_pinned_tag {500} else {0};
  let score = (base + kind_bonus + freq_bonus + tag_bonus + pin_bonus).max(1) as u32;
  ```
  量纲对齐:base 满分 ~1600、kind app=240、freq≤400,故 tag=300 明显上浮但不碾压精确前缀,pin=500 弱匹配也能冒头。
- **回传前端**:`SearchHit` 加 `tags: Vec<String>`(只在 top-K 约 40 条克隆阶段填,不碰热路径);`lib.ts`/`SearchBar.tsx` 同步渲染 chip。

## ⑤ 与 notes 标签的关系:独立存储,共享视觉
| | notes 标签(TAGS_KEY) | 文件标签(本方案) |
|---|---|---|
| 键 | docId | path |
| 存储 | localStorage | `%LOCALAPPDATA%\poof\tags.json` |
| 消费 | 笔记列表过滤(JS) | 搜索打分(Rust) |
不强行合并(键空间不同、消费层不同)。**共享** chip 组件 + 色板 + 输入交互,抽成 `src/lib/tagchip.tsx`,notes 与搜索都用。

## ⑥ 分阶段落地
**MVP**(新建 `src-tauri/src/tags.rs` + 3 命令 + 改 2 处):
1. `tags.rs`:`TagStore`(Mutex 内存)+ load/persist(tmp+rename)+ `tag_add/tag_remove/tags_for`,落 `%LOCALAPPDATA%`。
2. `lib.rs`:`mod tags;` + 注册 + `warm_start` 加载。
3. `search.rs`:`SearchHit` 加 `tags`;打分加 tag_bonus/pin_bonus;`#tag` 过滤;top-K 填 tags。
4. `lib.ts`:加桥 + `SearchHit.tags`。
5. `SearchBar.tsx`:结果行 chip + 右键"标签…"面板。
- 范围:只直接标签;无继承;色板自动分配;path 维护只做删除清理 + watch 内 rename 跟随。

**第二阶段**:文件夹虚继承、标签管理面板、置顶标签全链路、孤儿宽限+FileId 救援、空 query 显示置顶/最近标签文件。
**第三阶段**:拖拽、键盘热键、chip 共享组件、可选 notes↔文件标签桥。

## 落地注意(避坑)
- 标签 store 锁与 INDEX 锁**别嵌套**:`search()` 开头克隆一份 `path->tagset` 轻量快照(只含带标签的 path,通常几百条)进局部变量,热循环只读快照不碰 store 锁。
- 标签**务必** `%LOCALAPPDATA%`,别学 usage 的 `%TEMP%`。

**改动文件**:`src-tauri/src/search.rs`、`src-tauri/src/lib.rs`、`src/lib.ts`、`src/regions/SearchBar.tsx`、参考 `src/regions/NotesWorkspace.tsx`、新增 `src-tauri/src/tags.rs`。
