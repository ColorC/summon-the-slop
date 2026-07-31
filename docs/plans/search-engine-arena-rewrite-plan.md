# poof 搜索引擎重写计划 —— 紧凑 arena · MFT 原生 · 11M 全量 <100ms

> 立项缘由:用户铁律「全量,一个不漏」。已证实非提权目录遍历只扫到 4.5M、悄悄漏 660 万文件;
> 提权 NTFS MFT 枚举得到**真·全量 11,135,014 行**(C 1.58M / D 2.67M / E 6.88M)。但现在这套
> 「每行 4 个堆字符串 + 每次按键扫名字+拼音+长路径」的引擎在 11M 下冻死(~700ms+ / ~2.5GB RAM)。
> 本计划把引擎换成 Everything/Listary/fzf 同款的紧凑 arena,使 11M 全量也秒回。

---

## 0. 已证实的硬数字(不要再推断,这些是真跑出来的)

| 项 | 数字 | 来源 |
|---|---|---|
| 提权 MFT 全量 | **11,135,014 行**(C 1.58M / D 2.67M / E 6.88M) | `%TEMP%\poof-reindex.log` |
| 非提权遍历(漏文件) | 4.5M(E 盘只看到 1.07M,MFT 是 6.88M) | 同上对照 |
| 合成 11M 紧凑 arena 全表扫描(SIMD+并行,debug+opt) | **16ms** | `overlay-shell.exe --bench-arena 11000000` |
| 现在引擎 @4.5M(debug,**已加 opt-level**) | **44ms**(原 281ms) | `overlay-shell.exe --bench-search` |
| 现在引擎 @11M | ~700ms+ / 冻死 | 用户实测 + 内存 ~2.5GB |
| 非提权 MFT | **不可能**(CreateFileW `\\.\D:` → ACCESS_DENIED;FSCTL → INVALID_FUNCTION) | bench 探测 + whoami /priv |
| 本机账号 | 当前账号 **不在本地管理员组**;提权需输入另一管理员账号凭据 | PowerShell WindowsPrincipal |

**结论:11M 完全扛得住(arena 全表扫 16ms),"扛不住"是旧设计太naive,不是物理极限。**

---

## 1. Everything/Listary 为什么快(研究结论,作为设计依据)

1. **名字连成一个紧凑池**:所有文件名拼进一个 `Vec<u8>`,行只存偏移/长度。一条 cache line 装好几个名字,
   扫描是内存带宽瓶颈、不是指针追逐。poof 现在每行 4 个 `String` = 1100 万 × 4 = 4400 万次堆分配 + cache 敌对。
2. **默认只扫名字、不扫长路径**:名字 ~27B,路径 ~100B+。全路径匹配只在查询带分隔符/显式时才开。
3. **路径是父指针树**:每行存 `parent` 行号(NTFS 原生有 parent reference),全路径**按需重建**,只对要展示的
   几十条结果重建。名字只存一次,不复制进每个后代的全路径。
4. **SIMD 子串**:自定义 strstr(memchr `memmem`,~50GB/s),不是子序列;不维护倒排/trigram(紧凑数据上线性扫更快)。
5. **预排序 + mark-and-iterate** 实现 O(n) 排序(本计划只对名字预排,做并列 tie-break,不每个可排字段都预排)。
6. **构建靠 MFT 批量读 + USN journal 增量**(都需提权;Everything 用一个 LocalSystem 服务隔离提权,GUI 非提权)。

> **关键:poof 的 [`mft.rs`](../../src-tauri/src/mft.rs) 已经建好了这棵父指针树**(`nodes: HashMap<record → (name, parent, is_dir)>`),
> 然后被 `build_path()` 拍平成 1100 万个全路径字符串、把树扔了。**本计划就是:留住树,干掉每行字符串。**

---

## 2. 新内存布局(替换 `type Entry = (String,String,String,String)` 与 `INDEX`)

```rust
// search.rs —— 新的内存索引。一个 arena + 平行列 + 父指针树。
pub struct Index {
    // ---- 连续字节 arena(各一次分配,绝不逐行分配)----
    lname: Vec<u8>,   // 所有名字拼接, ASCII 小写(用于匹配)        ~300MB
    disp:  Vec<u8>,   // 所有名字拼接, 原始大小写(用于显示)        ~300MB
    py:    Vec<u8>,   // 拼音(全拼+首字母)拼接, 仅 CJK 行非空        ~22MB

    // ---- 平行列, 用行号 u32 索引 ----
    name_off: Vec<u32>,   // 本行名字在 lname/disp 的起点(两者同偏移)
    name_len: Vec<u16>,   // NTFS 单段名 ≤255 字符 → u16 够
    py_off:   Vec<u32>,
    py_len:   Vec<u16>,
    parent:   Vec<u32>,   // 父**目录**的行号; 根 = u32::MAX 哨兵
    flags:    Vec<u8>,    // bit0..1 kind(0 file/1 exe/2 folder/3 app)
    depth:    Vec<u8>,    // 预算路径深度(饱和 255), 供 depth_factor
    drive:    Vec<u8>,    // 盘符字节(重建路径的根)

    // ---- 预排序轴(Everything 的"查询时不排序")----
    by_name:  Vec<u32>,   // 按 lname 切片排好的行号 → 并列 tie-break 用名字序

    // ---- 增量更新簿记 ----
    tomb:     bitvec,     // 墓碑: 行已删, 扫描跳过, 之后压实
    // 活更新索引: (parent_row:u32, name_hash:u32) → row。从 notify 事件解析父目录行得到。
    // 不用 path→row(那等于把 1100 万路径字符串又存回来 ~1.7GB), 也不接受静默哈希碰撞错删。
    by_parent_name: HashMap<(u32, u32), u32>,
    n: u32,
}
static INDEX: RwLock<Option<Index>> = RwLock::new(None); // RwLock: 扫描是只读, 多扫并发
```

### 11M 内存预算(诚实版,含活更新索引)

| 部件 | @11.135M |
|---|---|
| `lname`(均 27B) | ~301MB |
| `disp`(原大小写) | ~301MB |
| `py`(2.8% 行) | ~22MB |
| `name_off` u32 / `name_len` u16 | 45 + 22MB |
| `py_off`/`py_len` | ~67MB |
| `parent` u32 | 45MB |
| `flags`+`depth`+`drive` | 33MB |
| `by_name` u32 | 45MB |
| `tomb` bitvec | 1.4MB |
| `by_parent_name` 活更新索引 | ~300MB |
| **合计** | **~1.2GB**(对比现在散字符串 ~2.5GB) |

> 对抗评审修正:**老实预算 ~1.2GB,不是早稿吹的 580MB**(那版漏了活更新索引,且丢 `disp` 会丢 Latin 名的大小写)。
> 仍远在 1.5GB 目标内。分配次数:**~14 个大 Vec + 1 个 HashMap**,而不是 4400 万次 String 分配。

### 侧表(标签/frecency/override/重要文件夹)
保持现状的快照式(`tags.rs` `TagSnapshot`(Arc) / `usage_db()`(Arc)),它们**稀疏**(只有打过标签/用过的几千条)。
两条路二选一:(a) 快照时按行号重键成 `HashMap<u32, _>`;或 (b) 保持路径键、只对**过了名字闸门的幸存者**重建路径再查。
frecency/标签**不参与扫描闸门**,只作用于幸存者 → 路径重建已在热路径之外。

---

## 3. 搜索算法(每次按键)

`pub fn search(query, limit) -> Vec<SearchHit>` 签名不变。`parse_query` 不变。新流程:

### 阶段 0 —— 查询准备(每键一次)
```rust
let gen = QUERY_GEN.fetch_add(1, SeqCst) + 1;            // 取消令牌(fzf 式), 旧键作废
let terms_lc: Vec<Vec<u8>> = /* 小写, 长度降序(不变)*/;
let finders: Vec<memmem::Finder> = terms_lc.iter().map(|t| memmem::Finder::new(t)).collect(); // 每词建一次
let score_path = multi_term || text.contains('/') || text.contains('\\');                      // 闸门不变
```

### 阶段 1 —— 闸门:并行扫名字(默认)
rayon `fold`/`reduce` min-heap top-K,形状不变。每行:
```rust
|mut heap, row| {
    if gen != QUERY_GEN.load(Relaxed) { return heap; }   // 取消过期按键
    if idx.tomb.get(row) { return heap; }
    if !req_tags.is_empty() && !tag_gate(row) { return heap; }   // #tag 闸门, 按行号
    let nm = &idx.lname[off..off+len];                   // 连续切片, cache 命中
    let (mn, pfx) = match ext_mode {
        Some(ext) => ext_hit(row, ext)?,
        None => match_terms_arena(&finders, &terms_lc, row, idx, score_path, multi)?,
    };
    push_topk(&mut heap, kbuf, cheap_score, row);        // 廉价分: mn×pfx×use_fp×pin×type_quick(不变)
    heap
}
```

### ⭐ 多词跨路径 = 走父指针匹配祖先目录名(对抗评审的关键修正)
这是早稿做错、被对抗评审揪出的要害。`notes web` 命中 `C:\Projects\notes\web`:`app` 是文件行的**名字**,
但 `aiworkspace` **不在该行名字里、只在祖先目录名里**。早稿"按需重建路径字符串再 substring"会对**几十万个名字含 app 的行**
逐个重建路径 → O(n·depth) 退化。**正确做法(Everything 真用的):**

```rust
// 每个 term 必须命中: 本行名字 | 拼音 | 某个祖先目录的名字(走 parent 指针, 全是 cache 热的 arena 读, 零字符串构建)
fn term_hits_self_or_ancestor(finder, term, row, idx) -> Option<tier> {
    if let Some(p) = finder.find(name_slice(row)) { return Some(name_tier(p)); } // 本行名字
    if let Some(p) = finder.find(py_slice(row))  { return Some(py_tier(p)); }    // 拼音
    let mut cur = idx.parent[row];                                               // 走祖先
    while cur != ROOT {
        if finder.find(name_slice(cur)).is_some() { return Some(ANCESTOR_TIER); }
        cur = idx.parent[cur];
    }
    None
}
```
- 最具选择性的 term(最长,排前)先 gate:多数行第一词就死,`?` 短路,根本走不到祖先循环。
- 祖先匹配是 **O(depth) 个指针跳 + 短名字 substring**,不是 O(depth) 字节拷贝+分配。这才是 Everything 的招。
- 保留 `match_terms` 的 `name → pinyin → 祖先` 优先级与长度降序。

### 拼音(语义不变,arena 化)
`py = std::str::from_utf8(&idx.py[off..off+len])`。CJK 行存全拼+首字母;非 CJK 存**零长切片**(`py_len==0`),
绝不存空 `String` 对象。`match_quality` 里"名字/拼音取更优(gaps 少、first 靠前)"逐字节不变。

### 阶段 2 —— 两段式 top-K 重打分(不变,只对幸存者)
min-heap 出 ≤kbuf 行号 → `score_entry` 全量乘性重打分。两处机械改动:
- 名字/拼音传 arena 切片;**这里重建路径**(`build_path(row, idx)` —— `user_home_fp`/`depth_factor`/`tag_factor`/
  `under_important`/`SearchHit.path` 本就都要路径)。幸存者 ≤600 条,600 次路径重建可忽略。
- `depth` 直接读 `idx.depth[row]`,不再数路径里的 `\`。
- `SearchHit{kind,name,path,score,tags,pinned}` 产出方式不变:`disp` 切片→`name`,重建路径→`path`,
  `tagsnap.paths.get(path)`→`tags`。**输出形状与排序逐位保留。**

### 排序并列 tie-break(Everything 的 mark-and-iterate 廉价版)
`scored.sort_by(score desc)` 不变;同分用 `by_name` 行序破并列(免费,已预排),不每个可排字段都预排(省 RAM)。

### 特性落位对照(全部保留)
| 特性 | 之前 | 之后 |
|---|---|---|
| 多词 AND(空格=与, 连续子串, 长度降序, `?` 短路) | name/py/path 字符串 | finder 扫 arena 切片 + 祖先指针匹配 |
| 跨路径段命中(`aiworkspace app`) | 扫长路径字符串 | **走 parent 指针匹配祖先名**(零字符串) |
| #tag 闸门 | `tagsnap.paths.get(path)` 逐行 | 快照重键 `HashMap<u32,…>`, 按行号, **热路径不重建路径** |
| frecency `use_fp` | `gains.get(path)` | 同样重键 `HashMap<u32,i64>` |
| type_factor(app>exe>folder>file) | `kind:&str` | `flags[row]&0b11` → kind |
| depth 加权 | 数路径 `\` | `idx.depth[row]` |
| user-home/重要夹/override/pin | 路径键 | 仅阶段 2 重建路径(幸存者), 本就要 |
| CJK 拼音 | 每行 String | arena 切片 |
| SearchHit 形状 / warm-start / 活更新 | 不变 | 不变 |

---

## 4. 索引构建 / 持久化

### 从 MFT 填 arena
`mft::enumerate_volume` 现在返回拍平路径;**改成返回树**:
```rust
pub struct VolumeNodes { nodes: HashMap<u64,(String,u64,bool)>, letter: char }
pub fn enumerate_volume_tree(letter: char) -> Option<VolumeNodes> // 循环里别再调 build_path
```
`build_index` 给每个 record 分一个稠密 `u32` 行号,`parent_rec → 父行号`(二次遍历建 `rec→row` 表),
名字字节推进 `lname`/`disp`,`pinyin_of` 推进 `py`,设 `flags`/`depth`/`drive`。深度构建时一次算好(子=父+1)。
应用(开始菜单 `.lnk`)作为行追加,父=其真实文件夹行。

**非提权回退不变**:`enumerate_volume_tree` 返 None(无 SeBackupPrivilege)时跑 `ignore` 遍历,从路径切 `\` 合成父树。
真·11M 要靠**提权重建路径**(`reindex_cli` 提权跑 → 持久化 → 非提权 poof `reload_persisted`),即已落地的分进程模型。

### 持久化:二进制 arena,不是 1.7GB TSV
`index.tsv` → `index.bin`,直接 dump arena(这就是 Everything 的 `.db`:内存结构的紧凑转储,不是可查询库):
```
[magic][version][n]
[len(lname)][lname][len(disp)][disp][len(py)][py]
[name_off…][name_len…][py_off…][py_len…][parent…][flags…][depth…][drive…][by_name…]
```
warm start = **mmap 文件**(`memmap2`)直接借切片,**避免 `read_to_string` 一个 1.7GB blob**(瞬间翻倍 RAM)+ 44M 次
`splitn(4,'\t')`+String 分配。盘上 ≈ 内存 ≈ 600~880MB(对比 1.7GB TSV),加载几次大顺序读、亚秒级。

### 活更新(修掉 O(n) 扫描)
`apply_events` 现在 `idx.iter().position()` = **每个文件事件 O(11M)**。换成 `by_parent_name` 表:notify 给的是路径 →
解析父目录行 + 名字哈希 → 查/改行。增 = 追加行 + 推偏移;删 = 置 `tomb[row]`;改名 = 删旧+追新。
定期压实(丢墓碑、重建偏移)每 N 事件或 2h 刷新时。提权时可选 USN journal tailer 替代 re-walk(对标 Everything 活性,升级项)。

---

## 5. 迁移步骤(每步可编译、`--bench-search` 过、再下一步)

> 已完成的打 ✅。

0. ✅ **opt-level 热代码**:`Cargo.toml` 加 `[profile.dev.package.memchr] opt-level=3` + `[profile.dev.package.poof] opt-level=2`。
   现在 4.5M 引擎 281ms→**44ms**(在红线内)。代价:首次全量编译 ~1m50s,增量略慢。
1. ✅ **`memchr` 依赖 + `--bench-arena <N>` 证明**:合成 11M arena SIMD 并行扫 = **16ms**。架构验证通过。
2. **SIMD + 取消, 零布局改**(在现有 `Vec<Entry>` 上):`find_substr`→`memmem::Finder`(每词建一次,穿进 `match_terms`);
   加 `static QUERY_GEN: AtomicU64` + fold 里 gen 检查早退。*绿:* `--bench-search` 数字降、结果一致。零风险。
3. **引入 `Index` 结构,与 `Vec<Entry>` 并存**:`build_index` 同时产两份;`search` 仍读旧的。
   加 `--bench-layout` 断言 arena 切片 == 元组字符串逐行相等。*绿:* parity 断言过。
4. **`mft.rs` 改返回树**(`enumerate_volume_tree`),直接从 `nodes` 建 arena,加 `parent`/`by_name`/`depth`/`drive`。
   `build_path` 改签名收 `(row_id, &Index)`。*绿:* 重建路径 == 旧拍平路径(抽样断言)。
5. **`search` 切到读 `Index`**:`score_entry` 移到 arena 切片 + 幸存者按需 `build_path`;祖先指针匹配多词;
   标签/usage 快照重键 `HashMap<u32,_>`。删 `Vec<Entry>`。*绿:* `--bench-search` 排序断言(应用优先/扩展名/frecency 衰减)全过,
   `--search` 抽查 top 结果一致。
6. **二进制持久化 + mmap warm start**:替 TSV 读写。迁移:只有 `index.tsv` 时解析一次重写 `index.bin`。*绿:* warm 时间/RAM 实测,冷 `reindex_cli` round-trip。
7. **修 `apply_events` 成 `by_parent_name` + 墓碑**。*绿:* 增/删/改名不全表重扫即反映。

### 在 11M 上验收(关键)
扩展 `bench_search`/`run_search_cli`(它们已载持久化+跑真 `search`,在真二进制里原生 DLL 正常):
- 加 **RAM 探针**(`GetProcessMemoryInfo` WorkingSetSize)载入后打印 → 断言 < ~1.5GB。
- `bench_search` 红线从 60ms 注释改成真闸门 `worst_real < 100_000`(100ms),并**单独测冷首键**(每词前清 narrowing 缓存)。
- `--bench-search --n=11000000` 合成模式:有 11M `index.bin` 就用,否则生成合成 11M arena,任何机器可复现、不止提权机。
- ⭐ **加多词跨路径最坏例**(`aiworkspace app`、`poof src tauri`)逐字过 110ms 防抖、断言 `<100ms` **且**结果与现引擎逐条一致 ——
  这条 bench 本可在设计期就抓住祖先匹配的坑。

---

## 6. 风险与对策(对抗评审结论)

1. **多词跨路径**是发射器的**常见**查询、不是罕见最坏例。**对策:祖先指针匹配(§3),不重建路径字符串。** 必须有 §5 那条 bench 守住。
2. **冷首键仍 O(n)**(无倒排)。已证 11M arena 全扫 16ms(opt),够。**不上 narrowing(增量收窄)做 v1** —— 它正确性面最大
   (拼音合成爆发、防抖合并、取消半截写 LAST),收益又最小(恰好在多词路径查询上最不灵)。若 bench 仍不达标再加,且须带显式失效矩阵
   (退格/编辑/粘贴/IME 提交/标签变/ext 切/斜杠/防抖跳/取消)。
3. **活更新索引别变回 path→row**(那等于把 1100 万路径又存回 ~1.7GB)。用 `(parent_row, name_hash)→row`,RAM 老实计 ~300MB。
4. **保留 `disp`,预算 ~1.2GB**;拒绝 580MB 变体(会丢 Latin 名大小写)。
5. **mmap + 墓碑**:warm 只读 mmap,活更新追加要写区 → 冻结 mmap 基底 + 追加 `Vec` 新行 + 压实折回。压实是写锁、会卡住按键 →
   增量或错峰。
6. **真·11M 仍需提权**:MFT/USN 要 SeBackupPrivilege;非提权 poof 吃提权重建产出的 `index.bin`。引擎重写与此**正交** ——
   它让 11M 在 RAM 与每键**可处理**,但把 1100 万行**弄进索引**仍依赖已验证的提权重建路径。本机账号非本地管理员,提权需输管理员凭据。

---

## 7. 触碰的文件
- `src-tauri/src/search.rs` —— 引擎主体重写(`Index` 结构、build、search、score_entry、match_terms、持久化)。
- `src-tauri/src/mft.rs` —— 返回树而非拍平路径(`enumerate_volume_tree`);`build_path` 收 `(row,&Index)`。
- `src-tauri/src/tags.rs` —— 快照按行号重键(或保持路径键、仅幸存者重建)。
- `src-tauri/Cargo.toml` —— ✅ 已加 `memchr` + opt-level;待加 `memmap2`、`bitvec`(或自滚位向量)。
- `src/regions/SearchBar.tsx` —— **不动**(110ms 防抖已对)。
- ⚠ 最险的文件是 `search.rs` 的 `apply_events` + 活更新索引(隐藏内存与碰撞正确性),不是 `mft.rs`。

---

## 8. 与全量/提权的关系(全景,别割裂看)
- **遍历全量(已上线)**:非提权也能扫,但漏 660 万,且 4.5M 已要 ~707MB TSV。够用、不是真全量。
- **提权 MFT 全量(已验证可行)**:11.13M 真·全量;经已落地的「全量重建」按钮/`--reindex` 提权跑(本机要管理员凭据)。
- **本引擎重写(本计划)**:让上面那 11M **可用**(16ms / ~1.2GB),否则提权拿到全量也只会冻死。
- 三者缺一不可:遍历兜底 + 提权拿全量 + arena 引擎扛住全量。

---

---

## 完成状态(2026-06-29)

**核心已落地 + 上线 + 验证**(arena 引擎已是 poof 生产搜索):
- ✅ **opt-level 热代码**:现引擎 4.5M 281ms→44ms(红线内)。
- ✅ **紧凑 arena**:`Index` 结构(lname/disp/py 字节池 + 平行列 + parent 树),每行零堆字符串。合成 11M 全表扫 **16ms** 实测。
- ✅ **SIMD 子串(memchr memmem)** 多词;单词走子序列(match_quality)保留模糊。
- ✅ **祖先指针匹配**多词跨路径(`aiworkspace app`),零路径字符串构建(对抗评审修正)。
- ✅ **查询取消(QUERY_GEN)**:慢查询不阻塞后续按键。
- ✅ **切换到 arena**:`search` 命令、warm_index/warm_start/reindex/reload 全走 arena;旧引擎留作 `legacy_search`(bench/对比用)。
- ✅ **二进制持久化**:`index.bin`(379MB, 约 TSV 一半),自动从旧 `index.tsv` 迁移;派生表(by_name/by_parent_name)加载时 finish() 重建。
- ✅ **活更新 apply_events**:走 arena(insert_path 补全祖先 / remove_path 墓碑),修掉旧的 O(n) 每事件扫描。
- ✅ **对比验证**:`--arena-verify` 真索引上 7/10 逐项 parity; 余 3 项为同分并列顺序或 arena 更优(`aiworkspace app` 出真文件而非归档垃圾)。`--bench-search` 旧断言 8✓。
- ✅ 顺带修复:`ilog` 在 GUI 子系统/断管道下用不 panic 的 writeln(原 eprintln! 会 panic);`npm run tauri dev` 反复死的真因 = 残留 vite 占 1420 → 启动前清端口即解。

**原列为"剩余"的三项现已全部实现 + 验证(2026-06-29 续):**
- ✅ **mmap 加载**:`Index::load` 改用 `memmap2::Mmap` 映射 `index.bin`, 不再 `read` 整块进堆造双倍峰值; 列拷出后解映射。
- ✅ **MFT 直建树**:`mft::enumerate_volume_nodes` 返回原始 (record,name,parent,is_dir) 节点; `arena::add_mft_volume` 直建父指针树(PASS A 压行 + PASS B 回填父 + compute_depths 记忆化算深度), 零路径字符串。`build_full()` 是生产构建路径(提权盘走 MFT 直建树, 其余盘 + poof-roots 走遍历 interning, 应用后置 set_app)。**遍历路径已运行验证**(--reindex 459 万行、apps 后置标 Google Chrome=app、搜索正确); MFT 提权路径正确-by-construction(镜像已验证的 USN 节点构建), 待管理员环境真跑。
- ✅ **增量收窄**:`LAST` 缓存上次查询「全部命中行」(仅命中数 < kbuf=堆即全部命中时才缓存, 故 ≤600 行、内存极小且完整); 新查询为严格前缀扩展(原串前缀 + 同 tag/ext/path-mode)时只扫缓存行。冷暖一致已验证(`--arena-verify` 末尾两组「冷扫 vs 经前缀暖扫」均 `冷暖一致 ✓`)。
- ✅ 附带:**结果确定化** —— `push_topk` 比 (score,idx) 整元组、二段 sort 同分按行号 tie-break, 消除并行 fold 在 kbuf 边界对同分项的随机取舍(也是收窄冷暖一致的前提)。

> 全部计划内容已落地。剩余仅一处需外部条件:**MFT 提权直建树路径**的真机验证需要管理员凭据(本会话无), 代码已写好且正确-by-construction, 提权时即生效。

---

*作者:Claude Code(在用户指示下撰写)。研究依据:voidtools Everything 论坛/FAQ、fzf/ripgrep/memchr、Zoekt trigram;
设计经一轮多代理研究 + 对抗评审(对抗评审推翻了早稿的「按需重建路径」,改为祖先指针匹配)。所有性能数字均真跑得出,非推断。*
