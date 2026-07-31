# poof 搜索排序升级方案 + Listary/Everything 排序算法调研

> 来源:多 agent web 深搜(2026-06-23)。**诚实标注**:Listary/Everything 官方均未公布打分公式;中文 CSDN 流传的 `DynamicScore=BaseScore×(1+log(UsageCount+1))×e^(-λ·Days)` **查无官方出处、高度疑似 AI 杜撰**,本文只把它当"frecency 思路示意",不作为任何工具的真实实现依据。

---

## 一、Listary / Everything 到底怎么排序

### Listary(你感觉"我关心的更靠前"的来源)
体感来自**三层叠加**,不是某个精密公式:
1. **自学习的频率/习惯排序(frecency 类)** —— 官方原话 "learns to rank the results more intelligently with usage" / "automatically prioritizes the files, folders, and apps you access most often"。**这是默认且最大的因素。**
2. **显式四级优先级 High / Normal / Low / Ignored** —— Normal/Low 由 Listary 按使用频率自动分派,用户基本只手动配 Ignored;冲突时"路径越具体越优先"。
3. **V6 把"应用"和"文件/文件夹"合并到同一列表,按 frequency + accuracy(匹配精度)统一排序**(V5 是应用永远在前)。
- 匹配用"针对文件名优化的 Boyer–Moore";索引只解决存储不管排序。
- ⚠ 短板:有用户反馈**频率分重启疑似被重置**,开发者避谈是否真按 open-count 计分 —— 说明它的学习信号持久化也不透明、不一定很重。

来源:help.listary.com(search-file / options-priorities / launch-apps / faq)、discussion.listary.com(topic/2197、sort-by-file-opened-count-frequency/4861、smarter-sorting…6.3.0 beta/8846)、listary.com/favorite-and-recent-folders。

### Everything(快但"笨")
- **没有相关性排序。** 开发者明确:纯列排序(name/path/size/date/run-count…),**默认 Name 升序**,与匹配位置/质量无关。
- 唯一类 frecency 的东西:每文件一个 **run count**,但它只决定"按 Enter 默认选中哪一行",**不改变列表排序**;要高频靠前得手动切排序列。
- 1.5 把 run-count/date-run 做成瞬时排序、frequency 按全索引算,但**仍未合成"频次×新近度"分数**。

来源:voidtools.com forum/viewtopic t=13217、support/everything/sdk/everything_setsort、command_line_interface、github.com/voidtools/es。

### 主流模糊查找器的可借鉴公式(frecency / fzf / VS Code / Firefox)
- **匹配质量分**:都是带仿射间隙惩罚的 Smith-Waterman/DP。可直接抄 fzf v2 bonus 表:`scoreMatch=16, gapStart=-3, gapExt=-1, bonusBoundary=8, bonusBoundaryWhite=10, bonusDelimiter=9, bonusCamel=7, bonusConsecutive=4, 首字符 bonus×2`;或 fzy 浮点表(本身近 [0,1])。
- **必须归一化**:`match_norm = dp_raw / ideal(query)`,否则长路径天然吃亏。basename 与 full-path 各算一次,`final_match = max(basename, 0.5×path)`(命中文件名远比命中目录值钱 —— VS Code 给 label 比 path 高一个 2^16 数量级)。
- **frecency 用连续指数衰减**(Firefox 新版 / `fre`,数学等价老式分桶但可增量更新、不用存访问数组):`score ← score×0.5^(Δt/halflife) + 1`,**半衰期 30 天起步**。
- **融合用乘性、不裸加**:`final = match_norm × prefix_boost × (1+α·use_norm) × type_factor × depth_factor`,匹配是闸门,使用是增益。

来源:firefox-source-docs…/urlbar/ranking.html、github fzf/algo.go、fzy/ALGORITHM.md、microsoft/vscode fuzzyScorer.ts、forrestthewoods 逆向 Sublime、github camdencheek/fre、Raycast manual。

---

## 二、poof 现状的病:不是权重没调好,是"裸加法"

现在 `score = base(1000~1600) + kind_bonus(80~240) + freq_bonus(≤400)`:
1. **裸加导致量级失衡** —— 使用信号占比 5~25%,几乎不起作用;一旦调大又变成"频率霸榜"压过精确匹配。**根因是加法。**
2. **freq 无衰减、无持久** —— `load_usage()` 只有累计 count、无 last-opened,一年前狂开的永远压今天的;且落 `%TEMP%`(会被清)= Listary 同款"重启丢分"。
3. **无纠偏闸** —— 没有 Pin / 收藏 / Hide / 重要文件夹。

---

## 三、升级方案:匹配为乘性闸门,使用为有界增益

```
final = match_norm                 // [0,1],归一化(解决长路径吃亏)
      × prefix_boost               // 全等4.0 / 前缀2.5 / 连续子串1.6 / 子序列1.0 / 仅路径0.6
      × (1 + α·use_norm)           // frecency 增益,α=1.0;无 query 时退化为纯 frecency 排序
      × type_factor                // app1.20 / exe1.12 / 源码文档1.08 / folder1.05 / file1.0 / 噪音0.5
      × depth_factor               // 1/(1+0.04·max(0,depth-4)),封顶不压没深处精确匹配
      × pin_factor                 // Pin6.0 / 重要文件夹1.8 / Normal1.0 / Hide0.0(剔除)
```

**抗"频率霸榜"的四重结构性保险(不靠调权重):**
1. 乘性而非加法 —— 没匹配=0,再热也不冒头。
2. `log1p(frecency)` 压长尾 —— 天天开的也挤不掉精确匹配。
3. **数学保证**:prefix_boost 档差最大 4×,use 增益最多 2× → **精确文件名匹配的冷门文件恒 ≥ 子序列命中的最热文件**(写成 bench 断言)。
4. 30 天半衰期 —— 老高频项自然沉底。

**冷启动**:无 usage → `use_norm=0` → gain=1.0 → 退化为纯匹配质量分(=现在行为),新文件不吃亏。

### 新增数据(替换 `HashMap<String,u32>`)
```rust
struct UsageEntry { frecency: f32, last: u64 }     // 指数衰减标量 + 上次打开时间
struct UsageDb {
    items: HashMap<String, UsageEntry>,
    overrides: HashMap<String, i8>,                // Pin/Demote/Hide
    important_folders: Vec<String>,                // 手动标记;自动识别=子项frecency之和top-N
}
```
- **持久化迁到 `%LOCALAPPDATA%\poof\usage.json`**(修丢分病),首启从旧 `%TEMP%` 迁移一次。
- **进程内缓存**(`static USAGE: Mutex<Option<Arc<UsageDb>>>`),查询零 IO(现在每键读盘反序列化);open 时指数衰减更新 + 节流落盘。
- **重要文件夹自动识别** = 重建索引时 `folder_score[parent] += frecency(child)` 取 top-30,其下项 pin_factor=1.8 —— 这就是 Listary "自动把你常用文件夹顶上来"的本地复刻。
- **独立收藏面板**(空 query 时显示 Pin + frecency top-12):调研反复强调"常用文件夹随手可达的体感大半来自快捷入口而非排序",这是**最便宜的体感大头**。

### 热循环保持零浮点
所有 factor ×1000 定点整数,乘完右移;`subseq_score` 已算出 first/gaps/全等三个 flag,只需透出供 prefix_boost 用。375 万条单键预期仍几十 ms。

### 验证(沿用 `overlay-shell.exe --bench-search`)
- 性能红线:单键中位 < 60ms。
- 抗霸榜断言:frecency 拉满的子序列命中项 vs frecency=0 的精确文件名命中项 → 断言后者排前。
- frecency 衰减/重启不丢分单测。
- bench 同时打印"纯匹配序" vs "融合序"两列人工对照(可关闭的确定性视图)。

### 落地顺序(每步可独立验证)
1. usage 迁 `%LOCALAPPDATA%` + frecency 结构(修丢分病)
2. 乘性融合 + match 归一 + prefix_boost(核心,bench 验抗霸榜)
3. type/depth factor 替 kind_bonus
4. overrides(Pin/Demote/Hide)+ 右键菜单
5. 重要文件夹(自动 + 手动)
6. 空 query 的 Pinned+Recent 面板(可提前)

**改动文件**:`src-tauri/src/search.rs`(打分/usage/命令)、`lib.rs`(注册命令)、`src/lib.ts`(wrapper)、`src/regions/SearchBar.tsx`(右键菜单 + 空 query 面板)。遍盘/MFT/watcher 不动。
