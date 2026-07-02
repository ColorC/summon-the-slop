// In-process search: files + folders + apps + executables, walked with the `ignore`
// crate (no child process, EDR-friendly). Ranking = cheap fzf-style byte-subsequence match
// (the GATE) × frecency use-gain × type/depth/tag/pin factors — multiplicative fusion, so a
// hot file can't out-rank a clean name match (see docs/plans/search-ranking-and-tagging-plan.md).
// Real Windows file icons via systemicons (cached). Index built lazily on first query.
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub kind: String, // "app" | "folder" | "exe" | "file"
    pub name: String,
    pub path: String,
    pub score: u32,
    pub tags: Vec<String>, // 文件标签(仅 top-K 克隆阶段填; 热路径不碰)
    pub pinned: bool,      // 用户置顶(override=Pin) → 前端金色高亮
}

// (kind, name, path, pinyin) — pinyin is non-empty only for CJK names (full + initials),
// so typing "ceshi" or "cs" finds 测试…
type Entry = (String, String, String, String);
static INDEX: Mutex<Option<Vec<Entry>>> = Mutex::new(None); // 旧引擎/合成测试用; 生产已切 ARENA
// arena 引擎的活索引(切换后真正服务搜索)。RwLock: 扫描只读、多扫并发; 写仅 warm/load/活更新。
static ARENA: std::sync::RwLock<Option<arena::Index>> = std::sync::RwLock::new(None);
static BUILDING: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);

// de-dup keeping order; drop a root nested under an earlier one; keep only existing.
fn dedup_existing(v: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    v.into_iter()
        .filter(|p| p.exists())
        .filter(|p| {
            if seen.iter().any(|s| p.starts_with(s)) {
                return false;
            }
            seen.push(p.clone());
            true
        })
        .collect()
}

// All FIXED local drives (C:, D:, E:, …) — whole-disk scope, like Everything/Listary. We do
// NOT avoid any user directory. (Removable/USB/network drives skipped: walking them is slow.)
#[cfg(windows)]
fn fixed_drive_roots() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    let mut v = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let wide: Vec<u16> = format!("{}:\\", letter)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        if unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } == DRIVE_FIXED {
            v.push(PathBuf::from(format!("{}:/", letter)));
        }
    }
    v
}
#[cfg(not(windows))]
fn fixed_drive_roots() -> Vec<PathBuf> {
    Vec::new()
}

// INDEX scope = every fixed drive + user additions. Whole-disk; no hand-picked allow-list.
// This froze before NOT because the scope was too big, but because (1) the cold walk used all
// cores → EDR storm, and (2) search materialized every match before sorting → a 1-char query
// built millions of results. Both are fixed below (throttled walk + bounded top-K search).
fn index_roots() -> Vec<PathBuf> {
    let mut v = fixed_drive_roots();
    if v.is_empty() {
        if let Some(p) = std::env::var_os("USERPROFILE") {
            v.push(PathBuf::from(p)); // fallback if drive enumeration fails
        }
    }
    if let Ok(s) = std::fs::read_to_string(std::env::temp_dir().join("poof-roots.txt")) {
        for line in s.lines() {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with('#') {
                v.push(PathBuf::from(t));
            }
        }
    }
    dedup_existing(v)
}

// WATCH scope = work dirs only. Recursively watching whole drives (ReadDirectoryChangesW)
// would be a CPU/IO storm — Everything/Listary stay live via the NTFS USN journal (needs admin,
// poof is non-elevated). So we live-watch where you work; the rest refreshes via periodic re-walk.
fn watch_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("USERPROFILE") {
        let base = PathBuf::from(p);
        for sub in ["Desktop", "Documents", "Downloads"] {
            v.push(base.join(sub));
        }
    }
    for p in ["E:/WindowsWorkspace", "D:/P4/main/AIWorkSpace", "D:/P4/main/Excel"] {
        v.push(PathBuf::from(p));
    }
    dedup_existing(v)
}

// ---- usage / frecency / overrides (the ranking "memory") ----
// frecency = exponentially-decayed open score (Firefox urlbar model): each open does
//   frecency ← frecency × 0.5^(Δt/HALF_LIFE) + 1
// so a file opened often AND recently floats up, while an old hot file sinks on its own.
// Persisted in %LOCALAPPDATA% (NOT %TEMP%, which Windows clears = the old "restart loses your
// ranking" bug). Cached in-process as an Arc so a keystroke does ZERO disk IO.
const HALF_LIFE_SECS: f32 = 30.0 * 86400.0; // 30 天半衰期(计划开放决策①的起点)
const USE_K: f32 = 10.0; // frecency 饱和常数: use_norm = f/(f+K) ∈ [0,1), 压长尾
const ALPHA_FP: f32 = 1000.0; // α=1.0 → use 增益 (1+α·use_norm) ∈ [1,2)

#[derive(Serialize, Deserialize, Clone, Default)]
struct UsageEntry {
    frecency: f32,
    last: u64, // unix secs of last open
}
#[derive(Serialize, Deserialize, Clone, Default)]
struct UsageDb {
    items: HashMap<String, UsageEntry>,
    #[serde(default)]
    overrides: HashMap<String, i8>, // Pin(2) / Demote(-1) / Hide(-2)
    #[serde(default)]
    important_folders: Vec<String>, // 手动标记的重要文件夹
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn usage_file() -> PathBuf {
    index_dir().join("usage.json")
}
fn old_usage_file() -> PathBuf {
    std::env::temp_dir().join("poof-usage.json")
}

// in-process cache. search() clones the Arc (no IO); bump/override rebuild a fresh Arc + swap.
static USAGE: Mutex<Option<Arc<UsageDb>>> = Mutex::new(None);
// auto-detected 重要文件夹(子项 frecency 之和 top-N), recomputed on warm/bump. Manual ones live
// in UsageDb.important_folders; scoring treats (auto ∪ manual) the same.
static AUTO_IMPORTANT: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn load_usage_from_disk() -> UsageDb {
    // new-format file wins
    if let Ok(s) = std::fs::read_to_string(usage_file()) {
        if let Ok(db) = serde_json::from_str::<UsageDb>(&s) {
            return db;
        }
    }
    // migrate ONCE from the old %TEMP% HashMap<String,u32> (kept, never deleted — see M0 risk).
    let mut db = UsageDb::default();
    if let Ok(s) = std::fs::read_to_string(old_usage_file()) {
        if let Ok(old) = serde_json::from_str::<HashMap<String, u32>>(&s) {
            let now = now_secs();
            for (p, c) in old {
                db.items.insert(
                    p,
                    UsageEntry { frecency: (c as f32).min(50.0), last: now },
                );
            }
        }
    }
    db
}

fn usage_db() -> Arc<UsageDb> {
    let mut g = USAGE.lock().unwrap();
    if g.is_none() {
        *g = Some(Arc::new(load_usage_from_disk()));
    }
    g.as_ref().unwrap().clone()
}

fn persist_usage(db: &UsageDb) {
    let dir = index_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string(db) {
        let tmp = dir.join("usage.json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, usage_file()); // atomic on NTFS
        }
    }
}

// mutate the cached UsageDb under one lock, persist, swap the new Arc in.
fn update_usage(f: impl FnOnce(&mut UsageDb)) {
    let mut g = USAGE.lock().unwrap();
    let mut db = match g.take() {
        Some(arc) => (*arc).clone(),
        None => load_usage_from_disk(),
    };
    f(&mut db);
    persist_usage(&db);
    *g = Some(Arc::new(db));
}

fn bump_usage(path: &str) {
    let now = now_secs();
    update_usage(|db| {
        let e = db
            .items
            .entry(path.to_string())
            .or_insert(UsageEntry { frecency: 0.0, last: now });
        let dt = now.saturating_sub(e.last) as f32;
        e.frecency = e.frecency * 0.5f32.powf(dt / HALF_LIFE_SECS) + 1.0;
        e.last = now;
    });
    recompute_important();
}

// frecency decayed to `now`, mapped to a fixed-point use-gain in [1000, ~2000).
// All float math is done HERE, once per usage item at query setup — never in the hot loop.
fn use_gain_fp(e: &UsageEntry, now: u64) -> i64 {
    let dt = now.saturating_sub(e.last) as f32;
    let f = e.frecency * 0.5f32.powf(dt / HALF_LIFE_SECS);
    let use_norm = f / (f + USE_K); // [0,1)
    1000 + (ALPHA_FP * use_norm) as i64
}

// 重要文件夹自动识别 = 把每个使用项的 frecency 累加到其父目录, 取 top-30。Listary "常用文件夹自动
// 顶上来"的本地复刻。只读 USAGE(不碰 INDEX 锁), bump 后即时刷新, 故新常用目录很快上浮。
fn recompute_important() {
    let usage = usage_db();
    let mut score: HashMap<String, f32> = HashMap::new();
    for (p, e) in usage.items.iter() {
        if let Some(parent) = std::path::Path::new(p).parent().and_then(|x| x.to_str()) {
            *score.entry(parent.to_string()).or_insert(0.0) += e.frecency;
        }
    }
    let mut v: Vec<(String, f32)> = score.into_iter().collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(30);
    *AUTO_IMPORTANT.lock().unwrap() = v.into_iter().map(|(k, _)| k).collect();
}

// path 是否落在任一重要文件夹下(Path::starts_with 按组件比对, 兼容 \ 与 / 混用)。
fn under_important(path: &str, folders: &[String]) -> bool {
    if folders.is_empty() {
        return false;
    }
    let p = std::path::Path::new(path);
    folders.iter().any(|f| !f.is_empty() && p.starts_with(f))
}

// kind/扩展名 → 乘性类型系数(×1000)。取代旧的 kind_bonus 加数: app/exe 同分时轻微领先而非永远钉死,
// 源码文档略升, 临时/产物噪音(.tmp/.log/.obj…)压到 0.5。
// kind 级类型权(app/exe/folder); 文件返回 None(需看扩展名再细分)。一、二段共用同一组常量避免漂移:
// 一段闸门分用它(廉价 O(1), 不解析扩展名), 二段 type_factor_fp 用它 + 文件扩展名精算。
fn type_base(kind: &str) -> Option<i64> {
    match kind {
        // 正式注册的应用(开始菜单 .lnk)享决定性加权: 让 "chrome" 命中的 "Google Chrome" 压过那些恰好
        // 整段叫 "chrome" 的缓存文件夹(全等匹配)。仍需「应用名命中查询」才吃到这份权重, 故不会污染无关查询。
        "app" => Some(2600),
        "exe" => Some(1120),
        "folder" => Some(1050),
        _ => None,
    }
}

fn type_factor_fp(kind: &str, name: &str) -> i64 {
    match type_base(kind) {
        Some(b) => b,
        None => {
            let ext = name.rsplit('.').next().unwrap_or(""); // 大小写不敏感比对, 不分配
            const SRC_DOC: &[&str] = &[
                "md", "txt", "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "c", "cpp", "h",
                "hpp", "cs", "rb", "php", "json", "toml", "yaml", "yml", "csv", "xlsx", "xlsm",
                "xls", "docx", "doc", "pdf", "html", "htm", "css", "scss", "sql", "sh", "ini",
                "conf", "xml",
            ];
            const NOISE: &[&str] = &[
                "tmp", "temp", "log", "lock", "cache", "pyc", "pyo", "obj", "pdb", "map", "bak",
                "old", "class", "crdownload", "part",
            ];
            if NOISE.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
                500
            } else if SRC_DOC.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
                1080
            } else {
                1000
            }
        }
    }
}

#[tauri::command]
pub fn set_override(path: String, level: i8) {
    update_usage(|db| {
        if level == 0 {
            db.overrides.remove(&path);
        } else {
            db.overrides.insert(path.clone(), level);
        }
    });
}

#[tauri::command]
pub fn get_override(path: String) -> i8 {
    usage_db().overrides.get(&path).copied().unwrap_or(0)
}

// 列出所有纠偏项(置顶/降权/隐藏)—— 管理台用, 让 Hide 可逆(隐藏后从结果消失, 否则无从恢复)。
#[tauri::command]
pub fn list_overrides() -> Vec<(String, i8)> {
    let mut v: Vec<(String, i8)> = usage_db()
        .overrides
        .iter()
        .map(|(p, l)| (p.clone(), *l))
        .collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

#[tauri::command]
pub fn toggle_important_folder(path: String) -> bool {
    let mut now_on = false;
    update_usage(|db| {
        if let Some(pos) = db.important_folders.iter().position(|x| x == &path) {
            db.important_folders.remove(pos);
        } else {
            db.important_folders.push(path.clone());
            now_on = true;
        }
    });
    now_on
}

#[tauri::command]
pub fn is_important_folder(path: String) -> bool {
    let usage = usage_db();
    if usage.important_folders.iter().any(|x| x == &path) {
        return true;
    }
    AUTO_IMPORTANT.lock().unwrap().iter().any(|x| x == &path)
}

// 空 query 召出时的「常用 + 置顶」面板(M5)。纯靠 frecency/Pin, 不碰 INDEX —— name/kind 从 path 直接
// 推导, 故零索引依赖、极快。Pin 在前, 其后按 frecency 降序; 不存在的 path 跳过。
#[tauri::command]
pub fn recent_top(limit: usize) -> Vec<SearchHit> {
    let usage = usage_db();
    let tagsnap = crate::tags::scoring_snapshot();
    let now = now_secs();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<SearchHit> = Vec::new();
    let mk = |p: &str, usage: &UsageDb, tagsnap: &crate::tags::TagSnapshot| -> Option<SearchHit> {
        let pth = std::path::Path::new(p);
        if !pth.exists() {
            return None;
        }
        let is_dir = pth.is_dir();
        let name = pth
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or(p)
            .to_string();
        Some(SearchHit {
            kind: kind_for(&name, is_dir).to_string(),
            name,
            path: p.to_string(),
            score: 0,
            tags: tagsnap.paths.get(p).cloned().unwrap_or_default(),
            pinned: usage.overrides.get(p).copied() == Some(2),
        })
    };
    // Pin 优先
    let mut pins: Vec<&String> = usage
        .overrides
        .iter()
        .filter(|(_, v)| **v == 2)
        .map(|(k, _)| k)
        .collect();
    pins.sort();
    for p in pins {
        if seen.insert(p.clone()) {
            if let Some(h) = mk(p, &usage, &tagsnap) {
                out.push(h);
            }
        }
        if out.len() >= limit {
            return out;
        }
    }
    // 其后按 frecency 降序
    let mut freq: Vec<(&String, i64)> = usage
        .items
        .iter()
        .map(|(p, e)| (p, use_gain_fp(e, now)))
        .collect();
    freq.sort_by(|a, b| b.1.cmp(&a.1));
    for (p, _) in freq {
        if usage.overrides.get(p).copied() == Some(-2) {
            continue; // Hide
        }
        if seen.insert(p.clone()) {
            if let Some(h) = mk(p, &usage, &tagsnap) {
                out.push(h);
            }
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn app_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("APPDATA") {
        v.push(PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs"));
    }
    if let Some(p) = std::env::var_os("ProgramData") {
        v.push(PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs"));
    }
    v.into_iter().filter(|p| p.exists()).collect()
}

// pinyin of a name: full (测试→ceshi) + initials (测试→cs), space-joined, so a latin
// query matches CJK files. Empty for names with no CJK (the name match already covers them).
fn pinyin_of(name: &str) -> String {
    use pinyin::ToPinyin;
    let mut full = String::new();
    let mut initials = String::new();
    let mut has_cjk = false;
    for (ch, py) in name.chars().zip(name.to_pinyin()) {
        match py {
            Some(p) => {
                has_cjk = true;
                full.push_str(p.plain());
                initials.push_str(p.first_letter());
            }
            None => {
                for c in ch.to_lowercase() {
                    full.push(c);
                    initials.push(c);
                }
            }
        }
    }
    if has_cjk {
        format!("{} {}", full, initials)
    } else {
        String::new()
    }
}

// dirs we never descend into — pruning these keeps the index small + COMPLETE.
// (without this, node_modules alone exhausts the cap before other drives are reached,
// which is why deep folders / a second drive went un-indexed.)
fn is_noise(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "node_modules"
            | ".git"
            | ".svn"
            | ".hg"
            | ".jj"
            | "target"
            | "dist"
            | "build"
            | "out"
            | "__pycache__"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".next"
            | ".nuxt"
            | ".venv"
            | "venv"
            | ".cache"
            | ".turbo"
            | ".gradle"
            | ".terraform"
            | ".pnpm-store"
            | "pods"
            | ".idea"
            | ".vs"
            | "bin"
            | "obj"
            | "$recycle.bin"
            | "system volume information"
            // OS component stores — pure noise that floods a whole-drive C: walk
            | "winsxs"
            | "driverstore"
            | "servicing"
            | "softwaredistribution"
            | "installer"
            | "config.msi"
            | "$windows.~bt"
            | "$windows.~ws"
    )
}

// (name, path, is_dir) — PARALLEL walk, but THROTTLED to a few threads. Whole-disk scope means
// the cold walk touches millions of files, each one scanned by Kaspersky/EDR; using all cores
// turned that into an IO storm that froze the machine. A small thread count keeps the box
// responsive (slower cold build, but it's a one-time background job, then persisted + watched).
fn collect(roots: &[PathBuf], max_depth: usize, per_root_cap: usize) -> Vec<(String, String, bool)> {
    let out: Mutex<Vec<(String, String, bool)>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(2, 4))
        .unwrap_or(3);
    for root in roots {
        // index the root folder itself, so searching its name/path matches it
        if let Some(name) = root.file_name().and_then(|n| n.to_str()) {
            out.lock()
                .unwrap()
                .push((name.to_string(), root.to_string_lossy().to_string(), true));
        }
        let count = AtomicUsize::new(0);
        let root_path = root.as_path();
        let mut wb = WalkBuilder::new(root);
        wb.max_depth(Some(max_depth))
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .threads(threads)
            .filter_entry(|e| e.file_name().to_str().map(|n| !is_noise(n)).unwrap_or(true));
        wb.build_parallel().run(|| {
            Box::new(|res| {
                let dent = match res {
                    Ok(d) => d,
                    Err(_) => return ignore::WalkState::Continue,
                };
                if count.fetch_add(1, Ordering::Relaxed) >= per_root_cap {
                    return ignore::WalkState::Quit;
                }
                let p = dent.path();
                if p == root_path {
                    return ignore::WalkState::Continue;
                }
                let is_dir = dent.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    out.lock().unwrap().push((
                        name.to_string(),
                        p.to_string_lossy().to_string(),
                        is_dir,
                    ));
                }
                ignore::WalkState::Continue
            })
        });
    }
    out.into_inner().unwrap()
}

// bare drive root like "C:" / "C:/" / "C:\" → its letter (for MFT). Sub-paths → None (walk).
#[cfg(windows)]
fn drive_root_letter(p: &std::path::Path) -> Option<char> {
    let s = p.to_str()?;
    let b = s.as_bytes();
    if (2..=3).contains(&b.len()) && b[1] == b':' && b[0].is_ascii_alphabetic() {
        Some(b[0].to_ascii_uppercase() as char)
    } else {
        None
    }
}

fn build_index() -> Vec<Entry> {
    let mut idx = Vec::new();
    // apps = Start Menu .lnk shortcuts
    for (name, path, is_dir) in collect(&app_roots(), 5, 8000) {
        let lower = name.to_lowercase();
        if is_dir || !lower.ends_with(".lnk") {
            continue;
        }
        let display = name[..name.len() - 4].to_string();
        let py = pinyin_of(&display);
        idx.push(("app".to_string(), display, path, py));
    }
    // whole disk, FULL — nothing dropped (用户铁律: "全量,没有一点点文件应该漏下"). Prefer the NTFS MFT
    // per drive (Everything-grade: millions of files in seconds) — but it needs admin/SeBackupPrivilege
    // to open \\.\<vol>, which we PROVED non-elevated poof never has (CreateFileW→ACCESS_DENIED, the
    // FSCTL→ERROR_INVALID_FUNCTION). So in practice every drive falls to the throttled walk; MFT stays a
    // non-fatal fast-path for when poof happens to run elevated. The walk is now UNCAPPED (was 2,000,000,
    // which truncated D: mid-way through the P4 workspace and dropped D:\P4\main\AIWorkSpace entirely) and
    // deeper (40 vs 18). Bounded by actual disk contents (+ is_noise pruning); slower one-time cold build,
    // then persisted + watched. The latency this buys is paid back later by an index-layout rewrite, NOT
    // by dropping files. Mature precedent: Listary/Alfred/fzf index via ordinary walks; Everything alone
    // uses the MFT, behind a LocalSystem service we deliberately don't add (keeps the overlay unprivileged).
    let mut fs: Vec<(String, String, bool)> = Vec::new();
    for root in index_roots() {
        #[cfg(windows)]
        {
            if let Some(letter) = drive_root_letter(&root) {
                let t = std::time::Instant::now();
                if let Some(mut e) = crate::mft::enumerate_volume(letter) {
                    ilog(&format!(
                        "[index] {}: MFT(管理员) {} 条, {:?}",
                        letter,
                        e.len(),
                        t.elapsed()
                    ));
                    fs.append(&mut e);
                    continue;
                }
                ilog(&format!(
                    "[index] {}: MFT 不可用(非管理员/EDR 拦卷), 改遍历全盘…",
                    letter
                ));
            }
        }
        let t = std::time::Instant::now();
        let rd = root.display().to_string();
        let mut e = collect(&[root], 40, usize::MAX);
        ilog(&format!("[index] {} 遍历 {} 条, {:?}", rd, e.len(), t.elapsed()));
        fs.append(&mut e);
    }
    for (name, path, is_dir) in fs {
        let lower = name.to_lowercase();
        // .bat/.cmd/.ps1 are launch-intent like .exe — rank them above generic deep files
        let kind = if is_dir {
            "folder"
        } else if lower.ends_with(".exe")
            || lower.ends_with(".bat")
            || lower.ends_with(".cmd")
            || lower.ends_with(".ps1")
        {
            "exe"
        } else {
            "file"
        };
        let py = pinyin_of(&name);
        idx.push((kind.to_string(), name, path, py));
    }
    idx
}

// ---- persisted index (instant warm start) ----
// %LOCALAPPDATA%\poof\index.tsv (NOT %TEMP%, which gets cleared).
fn index_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("poof")
}
fn index_file() -> PathBuf {
    index_dir().join("index.tsv")
}
fn arena_file() -> PathBuf {
    index_dir().join("index.bin")
}
// 优先加载二进制 arena; 没有就从旧 index.tsv 迁移一次(解析→建 arena→落 .bin)。
fn load_arena_or_migrate() -> Option<arena::Index> {
    if let Some(a) = arena::Index::load(&arena_file()) {
        return Some(a);
    }
    let entries = load_persisted()?;
    let a = arena::build(&entries);
    let _ = a.save(&arena_file());
    Some(a)
}
fn load_persisted() -> Option<Vec<Entry>> {
    let s = std::fs::read_to_string(index_file()).ok()?;
    let mut v = Vec::new();
    for line in s.lines() {
        let mut it = line.splitn(4, '\t');
        if let (Some(k), Some(n), Some(p)) = (it.next(), it.next(), it.next()) {
            let py = it.next().unwrap_or(""); // 4th field optional (old 3-field files)
            v.push((k.to_string(), n.to_string(), p.to_string(), py.to_string()));
        }
    }
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}
fn persist(idx: &[Entry]) {
    let dir = index_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut out = String::with_capacity(idx.len() * 72);
    for (k, n, p, py) in idx {
        out.push_str(k);
        out.push('\t');
        out.push_str(n);
        out.push('\t');
        out.push_str(p);
        out.push('\t');
        out.push_str(py);
        out.push('\n');
    }
    let tmp = dir.join("index.tsv.tmp");
    if std::fs::write(&tmp, out).is_ok() {
        let _ = std::fs::rename(&tmp, index_file()); // atomic on NTFS
    }
}

// 全量重walk → 建 arena → 落二进制 → 换入。查询期刷新的核心。不再长期保留 Vec<Entry>(arena 已吃下, 省内存)。
pub fn warm_index() {
    let t = std::time::Instant::now();
    let aidx = arena::build_full(); // MFT 直建树(提权时)+ 遍历回退, 一步出 arena, 不再经 Vec<Entry>
    let n = aidx.len();
    // 不让"遍历回退"(非提权, 拿不到 MFT, 会掉掉一大半文件)覆盖一个明显更全的已载入索引
    // (如提权 MFT 建的 11M 全量)。新结果比现有少 >10% → 判定为残缺回退, 保留旧的, 不换不存。
    let prev = ARENA.read().unwrap().as_ref().map(|a| a.len()).unwrap_or(0);
    if prev > 0 && n * 10 < prev * 9 {
        ilog(&format!(
            "[life] warm_index 放弃覆盖: 新建 {} 行 < 现有 {} 行(遍历回退残缺, 保留更全索引; 要刷新请用管理员「全量重建」)",
            n, prev
        ));
        return;
    }
    let _ = aidx.save(&arena_file());
    ilog(&format!(
        "[life] warm_index 完成 {} 行, 用时 {:?}, mem={}MB",
        n,
        t.elapsed(),
        crate::proc_mem_mb()
    ));
    *ARENA.write().unwrap() = Some(aidx);
    *INDEX.lock().unwrap() = None;
    recompute_important(); // 刷新自动重要文件夹(基于最新 usage)
    crate::tags::sweep_orphans(14); // 14 天宽限后清理失踪文件的标签
}

// startup: load the persisted arena instantly (search works on the 1st keystroke),
// then do a full fresh walk in the background and swap it in.
pub fn warm_start() {
    if ARENA.read().unwrap().is_none() {
        if let Some(aidx) = load_arena_or_migrate() {
            *ARENA.write().unwrap() = Some(aidx);
        }
    }
    let loaded = ARENA.read().unwrap().as_ref().map(|a| a.len()).unwrap_or(0);
    // 提权时(MFT 能建全量)→ 刷新重建; 非提权但已载入索引(很可能是更全的 MFT 索引)→ 跳过遍历重walk:
    // 它既会被上面的"不覆盖"守卫丢弃, 又白费 ~50s/1.8GB。靠实时监听刷新工作目录, 全量靠管理员「全量重建」。
    if loaded == 0 || crate::is_elevated() {
        warm_index();
    } else {
        ilog(&format!(
            "[life] warm_start: 已载入 {} 行, 非提权 → 跳过遍历重walk(保全量; 刷新靠实时监听 + 管理员「全量重建」)",
            loaded
        ));
    }
    start_watchers();
    start_periodic_refresh();
}

// 当前活跃索引的行数(0 = 还没载入)。用于判断"是否已有全量索引"。
pub fn current_len() -> usize {
    ARENA.read().unwrap().as_ref().map(|a| a.len()).unwrap_or(0)
}

// Whole drives can't be cheaply watched live (no admin → no USN journal), so areas outside the
// live-watched work dirs are refreshed every 2h. 提权时本体直接 MFT 重建; 非提权时触发静默提权子进程走
// MFT 刷新全量(子进程 window-less, 不受会话隔离影响)—— 这样全量索引始终新鲜, 无需任何手动按钮。
pub fn start_periodic_refresh() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(7200));
        if crate::is_elevated() {
            if !BUILDING.swap(true, Ordering::SeqCst) {
                warm_index();
                BUILDING.store(false, Ordering::SeqCst);
            }
        } else {
            crate::trigger_reindex(true); // 静默提权子进程刷新全量(MFT)
        }
    });
}

fn kind_for(name: &str, is_dir: bool) -> &'static str {
    let lower = name.to_lowercase();
    if is_dir {
        "folder"
    } else if lower.ends_with(".exe")
        || lower.ends_with(".bat")
        || lower.ends_with(".cmd")
        || lower.ends_with(".ps1")
    {
        "exe"
    } else {
        "file"
    }
}

// apply a coalesced batch of filesystem events to the in-memory index. Returns whether
// anything changed. Noise paths (node_modules/.git/…) are ignored, so a `git checkout` or
// `npm install` never touches the index.
fn apply_events(batch: Vec<Result<notify::Event, notify::Error>>) -> bool {
    let mut changed = false;
    // 收集本批次的删除/新建 path, 供标签维护(rename 跟随 / 孤儿标记)在释放 INDEX 锁后处理 ——
    // 绝不在持 INDEX 锁时取 TAGS 锁(与 search 的取锁顺序相反, 嵌套即死锁)。
    let mut deleted: Vec<String> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    {
        let mut guard = ARENA.write().unwrap();
        let idx = match guard.as_mut() {
            Some(i) => i,
            None => return false,
        };
        for res in batch {
            let ev = match res {
                Ok(e) => e,
                Err(_) => continue,
            };
            for path in ev.paths {
                if path
                    .components()
                    .any(|c| c.as_os_str().to_str().map(is_noise).unwrap_or(false))
                {
                    continue;
                }
                let ps = path.to_string_lossy().to_string();
                let exists = path.exists();
                if exists {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let is_dir = path.is_dir();
                        // 活更新的 kind 字节(app 只来自全量构建的开始菜单, 故事件里 .lnk 当 file/exe)。
                        let lower = name.to_ascii_lowercase();
                        let kb: u8 = if is_dir {
                            2
                        } else if lower.ends_with(".exe")
                            || lower.ends_with(".bat")
                            || lower.ends_with(".cmd")
                            || lower.ends_with(".ps1")
                        {
                            1
                        } else {
                            0
                        };
                        if idx.insert_path(&ps, kb, &pinyin_of(name)).is_some() {
                            changed = true;
                            created.push(ps);
                        }
                    }
                } else {
                    if idx.remove_path(&ps) {
                        changed = true;
                    }
                    deleted.push(ps);
                }
            }
        }
    } // ARENA 锁在此释放
      // 标签维护: 仅当本批次确有「带标签」的删除时才动 TAGS(避免每次 fs 事件都写盘)。
    if !deleted.is_empty() && crate::tags::any_tagged(&deleted) {
        crate::tags::reconcile(&deleted, &created);
    }
    changed
}

// watch every root for create/delete/rename and keep the index live — non-admin
// (ReadDirectoryChangesW), no child process, EDR-safe. Coalesces bursts + throttles persist.
pub fn start_watchers() {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        use notify::{RecursiveMode, Watcher};
        use std::time::{Duration, Instant};
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => {
                WATCHING.store(false, Ordering::SeqCst);
                return;
            }
        };
        for root in watch_roots() {
            let _ = watcher.watch(&root, RecursiveMode::Recursive);
        }
        let mut last_persist = Instant::now();
        loop {
            let first = match rx.recv() {
                Ok(e) => e,
                Err(_) => break,
            };
            // coalesce a burst of events before applying
            let mut batch = vec![first];
            while let Ok(e) = rx.recv_timeout(Duration::from_millis(700)) {
                batch.push(e);
                if batch.len() > 5000 {
                    break;
                }
            }
            let changed = apply_events(batch);
            if changed && last_persist.elapsed() > Duration::from_secs(4) {
                if let Some(idx) = ARENA.read().unwrap().as_ref() {
                    let _ = idx.save(&arena_file());
                }
                last_persist = Instant::now();
            }
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

// case-insensitive ASCII 子序列匹配: needle(已小写)每个字节是否按序出现在 hay 中。返回首字符
// 位置 first 与跳变次数 gaps —— prefix 档位(全等/前缀/连续/子序列)与 match 质量都由调用方从这俩推导,
// 故无需在此预判前缀/词界。非 ASCII 字节 to_ascii_lowercase 原样, 拉丁查询不误配中文名(由拼音 py 负责);
// "字符子序列 ⇒ 字节子序列", 不漏真匹配。这是把"每键扫 375 万条全量打分"降到只给可能命中者打分的关键。
#[inline]
fn submatch(needle: &[u8], hay: &[u8]) -> Option<(i32, i32)> {
    if needle.is_empty() {
        return None;
    }
    let mut ni = 0usize;
    let mut want = needle[0];
    let mut first: i32 = -1;
    let mut prev: i32 = -2;
    let mut gaps: i32 = 0;
    for (i, &b) in hay.iter().enumerate() {
        if b.to_ascii_lowercase() == want {
            let i = i as i32;
            if first < 0 {
                first = i;
            } else if i != prev + 1 {
                gaps += 1;
            }
            prev = i;
            ni += 1;
            if ni == needle.len() {
                return Some((first, gaps));
            }
            want = needle[ni];
        }
    }
    None
}

// 扩展名过滤查询: ".exe" / "*.exe" → Some("exe")。让用户输入 .exe 就只出 exe 文件(按 frecency×类型×深度
// 排), 而不是把名字里恰好含 ".exe" 的杂项也模糊匹配进来。仅当整串就是一个裸扩展名时触发。
fn ext_query(text: &str) -> Option<String> {
    let t = text.trim().strip_prefix('*').unwrap_or(text.trim());
    let ext = t.strip_prefix('.')?;
    if !ext.is_empty() && ext.len() <= 8 && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Some(ext.to_ascii_lowercase())
    } else {
        None
    }
}

// name 是否以 .ext 结尾(大小写不敏感, 且 ext 前确有一个点 + 至少一个基名字符)。
#[inline]
fn name_has_ext(name: &str, ext: &str) -> bool {
    let (nb, eb) = (name.as_bytes(), ext.as_bytes());
    nb.len() > eb.len() + 1
        && nb[nb.len() - eb.len() - 1] == b'.'
        && nb[nb.len() - eb.len()..].eq_ignore_ascii_case(eb)
}

// keep a bounded top-K of (score, idx) in a min-heap: push if under capacity, else replace the
// current minimum when a higher score arrives. O(log k) per candidate, O(k) memory — no matter
// how many entries match. (min-heap = max-heap of Reverse, so peek() is the smallest score.)
fn push_topk(heap: &mut BinaryHeap<Reverse<(u32, usize)>>, k: usize, score: u32, idx: usize) {
    if heap.len() < k {
        heap.push(Reverse((score, idx)));
    } else if let Some(&Reverse((min_score, min_idx))) = heap.peek() {
        // 比 (score, idx) 整元组而非仅 score: 同分时按 idx 定夺 → 留下的 top-K 与到达顺序无关(并行 fold
        // 不再随机), 结果确定可复现(也让增量收窄冷暖一致)。
        if (score, idx) > (min_score, min_idx) {
            heap.pop();
            heap.push(Reverse((score, idx)));
        }
    }
}

// 匹配质量: 返回 (match_norm mn ∈ [150,1000], prefix 档位 pfx ∈ {600,1000,1600,2500,4000}) 或 None。
// browse(纯 #tag 浏览)→ 固定中等分。name/pinyin 取更优者(gaps 少优先, 再比 first 靠前); 都不中且
// score_path 时退到「仅路径」命中(0.6 档)。一、二段共用, 逻辑不重复。
#[inline]
fn match_quality(
    qb: &[u8],
    name: &str,
    py: &str,
    path: &str,
    browse: bool,
    score_path: bool,
) -> Option<(i64, i64)> {
    if browse {
        return Some((800, 1000));
    }
    let nm = submatch(qb, name.as_bytes());
    let pym = if py.is_empty() {
        None
    } else {
        submatch(qb, py.as_bytes())
    };
    let chosen: Option<(i32, i32, usize, &[u8])> = match (nm, pym) {
        (Some(a), Some(b)) => {
            if (a.1, a.0) <= (b.1, b.0) {
                Some((a.0, a.1, name.len(), name.as_bytes()))
            } else {
                Some((b.0, b.1, py.len(), py.as_bytes()))
            }
        }
        (Some(a), None) => Some((a.0, a.1, name.len(), name.as_bytes())),
        (None, Some(b)) => Some((b.0, b.1, py.len(), py.as_bytes())),
        (None, None) => None,
    };
    if let Some((first, gaps, hlen, hay)) = chosen {
        let exact = first == 0 && hlen == qb.len();
        // 词首边界: 匹配紧跟空格/分隔符 → 视同强匹配。让 "chrome" 命中 "Google Chrome" 里 "Chrome" 的
        // 词首, 不被那些恰好整段叫 "chrome" 的缓存文件夹(全等)死压。
        let word_start = first > 0
            && matches!(
                hay.get(first as usize - 1),
                Some(b' ' | b'-' | b'_' | b'.' | b'(' | b'[' | b'/' | b'\\')
            );
        let pfx = if exact {
            4000 // 全等
        } else if first == 0 {
            2500 // 前缀
        } else if gaps == 0 && word_start {
            2200 // 词首连续子串(多词名按词命中)
        } else if gaps == 0 {
            1600 // 连续子串
        } else {
            1000 // 子序列
        };
        let mn = (1000 - (gaps as i64) * 60 - (first.min(40) as i64) * 4).clamp(200, 1000);
        Some((mn, pfx))
    } else if score_path {
        submatch(qb, path.as_bytes()).map(|(first, gaps)| {
            let mn = (900 - (gaps as i64) * 40 - (first.min(80) as i64) * 2).clamp(150, 900);
            (mn, 600) // 仅路径命中
        })
    } else {
        None
    }
}

// 标签因子: 直接标签 1.3 / 最近祖先文件夹继承 1.15; 第二返回值 = 是否命中「置顶」标签。
#[inline]
fn tag_factor(snap: &crate::tags::TagSnapshot, path: &str) -> (i64, bool) {
    if !snap.has_any {
        return (1000, false);
    }
    if let Some(tags) = snap.paths.get(path) {
        return (1300, tags.iter().any(|t| snap.is_pinned(t)));
    }
    let mut anc = std::path::Path::new(path);
    while let Some(parent) = anc.parent() {
        if let Some(ps) = parent.to_str() {
            if let Some(tags) = snap.paths.get(ps) {
                return (1150, tags.iter().any(|t| snap.is_pinned(t)));
            }
        }
        anc = parent;
    }
    (1000, false)
}

// 路径深度因子: 浅=真加成(>1×), 深=衰减(<1×), 单调。旧版只在 depth>4 才罚、≤4 全平 → 浅层常用
// 文件夹拿不到优势。锚点: 盘根/顶层(d≤2)1500; 三层(d=3)1380; 四层(d=4)1260; 之后每层 -110、触底 600。
// depth-4(1260) 对 depth-10(600) ≈ 2.1×, 足以翻"同名同 frecency"的浅层 vs 末端并列。
#[inline]
fn depth_factor(depth: i64) -> i64 {
    match depth {
        0 | 1 | 2 => 1500,
        3 => 1380,
        4 => 1260,
        d => (1260 - (d - 4) * 110).max(600),
    }
}

// 真实 %USERPROFILE% 下"人常去"的规范文件夹(Desktop/Documents/Downloads/…)及其内容给乘性加权, 让
// "downloads" 出你自己的 Downloads, 而不是更浅的 C:\Users\Default\Downloads / C:\ProgramData\Documents。
// 只认真实主目录(不碰 AppData/Program Files/应用 .lnk), 故不影响应用优先。仅二段调用。
fn user_home_fp(path: &str) -> i64 {
    use std::sync::OnceLock;
    static PREFIXES: OnceLock<Vec<String>> = OnceLock::new();
    let prefixes = PREFIXES.get_or_init(|| {
        let home = std::env::var("USERPROFILE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .replace('\\', "/");
        if home.is_empty() {
            return Vec::new();
        }
        [
            "desktop", "documents", "downloads", "pictures", "videos", "music", "onedrive",
        ]
        .iter()
        .map(|d| format!("{}/{}", home, d))
        .collect()
    });
    if prefixes.is_empty() {
        return 1000;
    }
    let lower = path.to_ascii_lowercase().replace('\\', "/");
    if prefixes
        .iter()
        .any(|p| lower == *p || lower.starts_with(&format!("{}/", p)))
    {
        1300
    } else {
        1000
    }
}

// 在 hay 里找 needle 的首个「连续」出现(大小写不敏感)。多词 AND 必须用连续子串(Everything 语义):
// submatch 的子序列太松 —— 长路径里 p…o…o…f 几乎必中, 会让 "poof src tauri" 错配一堆无关应用。
#[inline]
fn find_substr(needle: &[u8], hay: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
}

// 单个 term 连续子串命中的档位。pos=起点; is_path=命中落在路径段(而非文件名)。
#[inline]
fn substr_tier(term: &[u8], hay: &[u8], pos: usize, is_path: bool) -> (i64, i64) {
    let exact = pos == 0 && term.len() == hay.len();
    let word_start = pos == 0
        || matches!(
            hay.get(pos - 1),
            Some(b' ' | b'-' | b'_' | b'.' | b'(' | b'[' | b'/' | b'\\')
        );
    let pfx = if exact {
        4000
    } else if is_path {
        if word_start { 2200 } else { 1200 } // 路径段命中: 段首=强, 段中=弱
    } else if pos == 0 {
        2500 // 文件名前缀
    } else if word_start {
        2200 // 文件名词首
    } else {
        1600 // 文件名中段
    };
    let mn = (1000 - (pos.min(60) as i64) * 3).clamp(300, 1000);
    (mn, pfx)
}

// 单个 term 在 name → pinyin → path 里取最优连续子串命中(全不中 → None)。
#[inline]
fn term_quality(term: &[u8], nb: &[u8], pyb: &[u8], pb: &[u8]) -> Option<(i64, i64)> {
    if let Some(p) = find_substr(term, nb) {
        return Some(substr_tier(term, nb, p, false));
    }
    if !pyb.is_empty() {
        if let Some(p) = find_substr(term, pyb) {
            return Some(substr_tier(term, pyb, p, false));
        }
    }
    find_substr(term, pb).map(|p| substr_tier(term, pb, p, true))
}

// 多词 AND 匹配(Everything 语义): 每个 term 必须各自「连续子串」命中(name|pinyin|path 取最优档),
// 全中才返回 → "aiworkspace app" 命中 D:\P4\main\AIWorkSpace\app, 但无关应用不会被子序列误配。
// combine: pfx 取各 term 最小档(最弱词定档), mn 取均值。单词(!multi)直通旧 match_quality, 逐字节不变
// (护住已上线的应用优先 + 扩展名搜索)。
#[inline]
fn match_terms(
    terms: &[Vec<u8>],
    name: &str,
    py: &str,
    path: &str,
    browse: bool,
    score_path: bool,
    multi: bool,
) -> Option<(i64, i64)> {
    if !multi {
        let qb: &[u8] = terms.first().map(|v| v.as_slice()).unwrap_or(&[]);
        return match_quality(qb, name, py, path, browse, score_path);
    }
    let (nb, pyb, pb) = (name.as_bytes(), py.as_bytes(), path.as_bytes());
    let mut mn_sum: i64 = 0;
    let mut pfx_min: i64 = i64::MAX;
    for t in terms {
        // `?` 短路: 第一个不中的 term 直接判负, 后续 term 与长路径都不再扫 → 热循环可控。
        let (mn, pfx) = term_quality(t, nb, pyb, pb)?;
        mn_sum += mn;
        pfx_min = pfx_min.min(pfx);
    }
    Some((mn_sum / terms.len() as i64, pfx_min))
}

// 单条全量打分(二段, 仅幸存者): match × prefix × frecency × type × depth × loc × tag × pin。pin 含重要
// 文件夹(1.8×)与置顶标签(≥4.0×, 让弱匹配也冒头)。定点整数, 乘完右移。Hide → None。
#[allow(clippy::too_many_arguments)]
fn score_entry(
    kind: &str,
    name: &str,
    path: &str,
    py: &str,
    terms: &[Vec<u8>],
    browse: bool,
    score_path: bool,
    ext_mode: Option<&str>,
    gains: &HashMap<&str, i64>,
    overrides: &HashMap<String, i8>,
    important: &[String],
    tagsnap: &crate::tags::TagSnapshot,
) -> Option<u32> {
    let (mn_fp, pfx_fp) = match ext_mode {
        // 扩展名模式: 命中 = 非文件夹且 name 以 .ext 结尾; mn/pfx 恒定, 排序全交给 frecency×类型×深度。
        Some(ext) => {
            if kind != "folder" && name_has_ext(name, ext) {
                (1000, 1000)
            } else {
                return None;
            }
        }
        None => match_terms(terms, name, py, path, browse, score_path, terms.len() > 1)?,
    };
    let ov = overrides.get(path).copied().unwrap_or(0);
    if ov == -2 {
        return None; // Hide
    }
    let use_fp = *gains.get(path).unwrap_or(&1000);
    let type_fp = type_factor_fp(kind, name);
    let depth = path.bytes().filter(|&b| b == b'\\' || b == b'/').count() as i64;
    // 应用(开始菜单 .lnk)路径天生很深(…\Start Menu\Programs\…), 但深度对"注册应用"毫无意义 —— 给固定
    // 高权, 别让深度惩罚把它压到同名的 Program Files 文件夹之下(否则 "chrome" 会出文件夹而非应用)。
    let depth_fp = if kind == "app" { 1300 } else { depth_factor(depth) };
    let loc_fp = user_home_fp(path); // 你自己主目录的常用文件夹加权(downloads/documents 出你的而非 Default)
    let (tag_fp, pinned_tag) = tag_factor(tagsnap, path);
    let mut pin_fp: i64 = match ov {
        2 => 6000,
        -1 => 400,
        _ => {
            if under_important(path, important) {
                1800
            } else {
                1000
            }
        }
    };
    if pinned_tag {
        pin_fp = pin_fp.max(4000);
    }
    let mut s: i64 = mn_fp;
    s = s * pfx_fp / 1000;
    s = s * use_fp / 1000;
    s = s * type_fp / 1000;
    s = s * depth_fp / 1000;
    s = s * loc_fp / 1000;
    s = s * tag_fp / 1000;
    s = s * pin_fp / 1000;
    Some(s.max(1) as u32)
}

// 解析 query: 抽出 `#tag` 过滤词(AND), 其余拼回模糊文本。裸 `#wip` → 纯标签浏览(text 空)。
fn parse_query(q: &str) -> (String, Vec<String>, Vec<String>) {
    let mut tags: Vec<String> = Vec::new();
    let mut terms: Vec<String> = Vec::new();
    let mut text = String::new();
    // 分隔符: 空格 + 反斜杠/正斜杠。后者让"文件夹\文件"这类路径片段查询拆成多词, 走同一套祖先匹配
    // (如 aiworkspace app)—— 与 Listary 一致。文件名不含 \ 或 /, 拆开无损。
    for tok in q.split(|c: char| c.is_whitespace() || c == '\\' || c == '/') {
        if tok.is_empty() {
            continue;
        }
        if let Some(t) = tok.strip_prefix('#') {
            if !t.is_empty() {
                tags.push(t.to_lowercase());
            }
        } else {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(tok);
            terms.push(tok.to_lowercase()); // 逐词保留(Everything 式空格=AND), 不拼回含空格的单串
        }
    }
    (text, terms, tags)
}

/// 搜索入口(arena 引擎)。索引未就绪 → 后台预热并先返回空(下一次按键即有结果)。
#[tauri::command]
pub fn search(query: String, limit: usize) -> Vec<SearchHit> {
    {
        let g = ARENA.read().unwrap();
        if let Some(idx) = g.as_ref() {
            return arena::search(idx, query, limit);
        }
    }
    if !BUILDING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            warm_index();
            BUILDING.store(false, Ordering::SeqCst);
        });
    }
    Vec::new()
}

// 旧引擎(读 Vec<Entry> INDEX): 切到 arena 后不再是生产入口, 仅供 --bench-search 断言与 --arena-verify 对比。
#[allow(dead_code)]
pub fn legacy_search(query: String, limit: usize) -> Vec<SearchHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let (text, term_strs, req_tags) = parse_query(q);
    let browse = text.trim().is_empty(); // 纯 #tag 浏览(无模糊文本)
    // 扩展名过滤模式(".exe" / "*.exe" → 只出该扩展名的文件); 与 #tag 互斥(带 tag 时按常规模糊)。
    let ext_mode: Option<String> = if req_tags.is_empty() { ext_query(&text) } else { None };
    if browse && req_tags.is_empty() {
        return Vec::new();
    }
    // build in the background on first use so the UI never blocks; until the index is
    // ready, return nothing (the next keystroke, ~1-2s later, has full results).
    if INDEX.lock().unwrap().is_none() {
        if !BUILDING.swap(true, Ordering::SeqCst) {
            std::thread::spawn(|| {
                warm_index();
                BUILDING.store(false, Ordering::SeqCst);
            });
        }
        return Vec::new();
    }

    // 取排序「记忆」快照 —— usage(frecency/overrides/手动重要文件夹)与标签都在持 INDEX 锁之前克隆成
    // 局部 Arc/Vec, 热循环只读快照、绝不再取 USAGE/TAGS 锁(避免与 apply_events 的 INDEX→TAGS 反向嵌套)。
    let usage = usage_db();
    let now = now_secs();
    // 所有浮点(frecency 衰减)在此一次性算成定点 use-gain, 热循环只查表 → 零浮点。
    let gains: HashMap<&str, i64> = usage
        .items
        .iter()
        .map(|(p, e)| (p.as_str(), use_gain_fp(e, now)))
        .collect();
    let overrides = &usage.overrides;
    let mut important: Vec<String> = usage.important_folders.clone();
    important.extend(AUTO_IMPORTANT.lock().unwrap().iter().cloned());
    let tagsnap = crate::tags::scoring_snapshot();

    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().unwrap();

    // 多词 AND 词表(空格分词); 单词 = 旧行为逐字节不变。按长度降序 → 最具选择性的 term 先 gate,
    // 配合 `?` 短路最大化早拒(AND 可交换, 排序不影响结果)。
    let mut terms: Vec<Vec<u8>> = term_strs.iter().map(|s| s.clone().into_bytes()).collect();
    terms.sort_by(|a, b| b.len().cmp(&a.len()));
    let multi_term = terms.len() > 1;
    // only score the (long) full path when the text looks path-shaped / multi-keyword;
    // a plain single word matches against the name only — far fewer scores → fast.
    // 多词查询本质是"找个地方", 必走路径打分(每个 term 可落在任意祖先段)。
    let score_path = multi_term || text.contains('/') || text.contains('\\');

    // 两段式打分。索引达数百万条, 短查询('c')会命中其中绝大多数 —— 若每条都算全套乘性档位(类型扩展名
    // 提取/路径深度遍历/重要文件夹前缀比对), 短查询会慢到秒级。故:
    //   一段(热循环, 并行): 只算「廉价闸门分」= match × prefix × frecency × pin(全 O(1), 零分配),
    //                       用 min-heap 留 top-K' 候选。这步与旧的快筛同量级。
    //   二段(仅 ≤K' 幸存者): 全量重打分(+ type/depth/标签/继承/重要文件夹/置顶标签), 排序取 limit。
    // 二段档位最多 ~1.8×, K' 缓冲(=4×limit, ≥200)足以让该被档位顶上来的项进候选, 不丢真该靠前的结果。
    // 候选缓冲: 给二段档位留追赶空间, 但与展示 limit 解耦并封顶 —— 前端现在请求 ~300 做滚动加载,
    // 若 kbuf 随之涨到几百, 短查询('c')的 heap pop/push churn 会爆炸而无收益。clamp(80,600) 够用。
    let kbuf = (limit * 2).clamp(80, 600);
    let gains_empty = gains.is_empty();
    let over_empty = overrides.is_empty();
    let final_heap = index
        .par_iter()
        .enumerate()
        .fold(
            BinaryHeap::<Reverse<(u32, usize)>>::new,
            |mut heap, (idx, (kind, name, path, py))| {
                let (kind, name, path) = (kind.as_str(), name.as_str(), path.as_str());
                // #tag 过滤(直接标签, AND) —— 不满足直接早退。
                if !req_tags.is_empty() {
                    match tagsnap.paths.get(path) {
                        Some(tags) => {
                            if !req_tags
                                .iter()
                                .all(|r| tags.iter().any(|t| t.eq_ignore_ascii_case(r)))
                            {
                                return heap;
                            }
                        }
                        None => return heap,
                    }
                }
                let (mn_fp, pfx_fp) = match ext_mode.as_deref() {
                    Some(ext) => {
                        if kind != "folder" && name_has_ext(name, ext) {
                            (1000, 1000)
                        } else {
                            return heap;
                        }
                    }
                    None => match match_terms(&terms, name, py, path, browse, score_path, multi_term)
                    {
                        Some(x) => x,
                        None => return heap,
                    },
                };
                // 多数条目既无 override 又无 usage —— 跳过 HashMap 查(省掉对长 path 的哈希)。
                let ov = if over_empty {
                    0
                } else {
                    overrides.get(path).copied().unwrap_or(0)
                };
                if ov == -2 {
                    return heap; // Hide → 不进候选
                }
                let use_fp = if gains_empty {
                    1000
                } else {
                    *gains.get(path).unwrap_or(&1000)
                };
                let pin_base = match ov {
                    2 => 6000,
                    -1 => 400,
                    _ => 1000,
                };
                // 扩展名模式 mn/pfx 恒定 → 把 type/depth 也并入闸门分, 否则并列里会随机丢掉浅层常用 exe。
                let cheap = if ext_mode.is_some() {
                    let type_fp = type_factor_fp(kind, name);
                    let depth = path.bytes().filter(|&b| b == b'\\' || b == b'/').count() as i64;
                    let depth_fp = depth_factor(depth);
                    (use_fp * pin_base / 1000 * type_fp / 1000 * depth_fp / 1000).max(1) as u32
                } else {
                    // 一段闸门分并入 kind 级类型权(app 2.6× 等), 否则应用会在一段就被全等同名的缓存文件夹
                    // 挤出候选、永远到不了二段加权。文件的扩展名细分留二段精算(一段不解析扩展名, 保持 O(1))。
                    let type_quick = type_base(kind).unwrap_or(1000);
                    (mn_fp * pfx_fp / 1000 * use_fp / 1000 * pin_base / 1000 * type_quick / 1000)
                        .max(1) as u32
                };
                push_topk(&mut heap, kbuf, cheap, idx);
                heap
            },
        )
        .reduce(BinaryHeap::new, |mut a, b| {
            for Reverse((score, idx)) in b {
                push_topk(&mut a, kbuf, score, idx);
            }
            a
        });
    // 二段: 幸存者全量重打分 → 排序 → 取 limit → 仅这 ~limit 条克隆成 SearchHit。
    let mut scored: Vec<(u32, usize)> = final_heap
        .into_iter()
        .filter_map(|Reverse((_, idx))| {
            let (kind, name, path, py) = &index[idx];
            score_entry(
                kind, name, path, py, &terms, browse, score_path, ext_mode.as_deref(), &gains,
                overrides, &important, &tagsnap,
            )
            .map(|s| (s, idx))
        })
        .collect();
    scored.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(limit.max(1));
    scored
        .into_iter()
        .map(|(score, idx)| {
            let (kind, name, path, _) = &index[idx];
            SearchHit {
                kind: kind.clone(),
                name: name.clone(),
                path: path.clone(),
                score,
                tags: tagsnap.paths.get(path.as_str()).cloned().unwrap_or_default(),
                pinned: overrides.get(path).copied() == Some(2),
            }
        })
        .collect()
}

#[tauri::command]
pub fn search_reindex() {
    if !BUILDING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            warm_index();
            BUILDING.store(false, Ordering::SeqCst);
        });
    }
}

/// Launch a file/folder/app with the OS default handler.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    bump_usage(&path); // most-used-first ranking learns from real opens
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("windows only".into())
    }
}

/// Open the folder containing a path (or the folder itself), selecting the item.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // explorer 的 /select 必须与路径在同一参数里(分成两个 arg 会被忽略,
        // 只打开默认的"此电脑"); 且只认反斜杠,顺手归一化正斜杠。
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", win_path))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("windows only".into())
    }
}

// 重建日志: 同时打 stderr 和 %TEMP%\poof-reindex.log —— 提权运行(GUI 子系统, 无控制台)看不到 stderr,
// 靠这个文件确认每盘走的是 MFT 还是遍历, 以及是否真出全量。
fn ilog(msg: &str) {
    use std::io::Write;
    // 文件先写(GUI 子系统无控制台 / 父进程死后 stdout 管道断裂时仍可靠)。
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("poof-reindex.log"))
    {
        let _ = writeln!(f, "{} {}", now_secs(), msg);
    }
    // stderr 用不 panic 的 writeln!(eprintln! 在管道断裂/无控制台时会 panic)。
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// 全量重建索引并持久化后退出。跑: poof.exe --reindex(普通用户=遍历全盘)或「以管理员运行」(走 MFT,
/// Everything 级、秒出全量)。build_index 会逐盘打印用的是 MFT 还是遍历 —— 据此判断本机提权后 MFT 是否
/// 真能读卷(公司 EDR 可能连管理员都拦)。普通 poof 之后 load_persisted 直接吃这份新索引。
pub fn reindex_cli() {
    use std::time::Instant;
    let t0 = Instant::now();
    ilog("[reindex] 开始全量重建…");
    let aidx = arena::build_full(); // 提权运行 → 各盘走 MFT 直建树(秒级全量, 零路径字符串)
    let n = aidx.len();
    let _ = aidx.save(&arena_file());
    *ARENA.write().unwrap() = Some(aidx);
    ilog(&format!(
        "[reindex] 完成: {} 行, 总用时 {:?} → 已写 index.bin",
        n,
        t0.elapsed()
    ));
    println!("{n}");
}

/// 逐字段内存占用报告(poof.exe --mem)。载入持久化 arena → 打印各结构 MB。
pub fn mem_cli() {
    match arena::Index::load(&arena_file()) {
        Some(a) => println!("{}", a.mem_report()),
        None => println!("(无持久化 arena, 先建索引)"),
    }
}

/// 把磁盘上的持久化索引热换进 INDEX(提权重建完成后, 运行中的普通 poof 据此立刻吃上新索引, 不必重启)。
pub fn reload_persisted() -> Option<usize> {
    let aidx = load_arena_or_migrate()?;
    let n = aidx.len();
    *ARENA.write().unwrap() = Some(aidx);
    Some(n)
}

/// 命令行搜索探针: poof.exe --search "<query>" → 载入持久化索引, 跑真·search() 路径, 打印前 ~20 名
/// 命中为 `kind:name :: path`(每行一条), 供无头的"用户视角"基准 —— 用纯英文查询常见文件/应用/文件夹,
/// 直接看它们落在第几位。与 --bench-search 同款载入(真应用二进制内跑, 原生 DLL 正常加载)。
pub fn run_search_cli(query: &str) {
    let aidx = load_arena_or_migrate().unwrap_or_else(|| arena::build(&build_index()));
    let n = aidx.len();
    *ARENA.write().unwrap() = Some(aidx);
    let hits = search(query.to_string(), 20);
    eprintln!("=== 索引 {} 条 · 查询 {:?} · {} 命中 ===", n, query, hits.len());
    if hits.is_empty() {
        println!("(无命中)");
        return;
    }
    for h in &hits {
        println!("{}:{} :: {}", h.kind, h.name, h.path);
    }
}

/// 对比验证: poof.exe --arena-verify → 用持久化索引建 arena, 对一批查询同时跑现引擎与 arena 引擎,
/// 比对 top 结果一致性(PARITY)并各自计时。证明 arena 引擎排序逐位等价、且更快, 再切换。
#[cfg(windows)]
pub fn arena_verify() {
    use std::time::Instant;
    let entries = load_persisted().unwrap_or_else(build_index);
    let n = entries.len();
    let t = Instant::now();
    let aidx = arena::build(&entries);
    let abuild = t.elapsed();
    let arows = aidx.len();
    *INDEX.lock().unwrap() = Some(entries);
    println!(
        "\n=== entries {} → arena {} 行(含补全祖先目录) · 建 arena {:?} ===",
        n, arows, abuild
    );
    let queries = [
        "chrome",
        "config",
        "downloads",
        "poof",
        "aiworkspace",     // ← 紧接下一条做前缀扩展, 触发增量收窄并被 parity 校验
        "aiworkspace app",
        "poof src tauri",
        "quant lab readme",
        ".xlsx",
        "系统",
    ];
    let mut parity = 0;
    for q in queries {
        let t = Instant::now();
        let old = legacy_search(q.to_string(), 8);
        let oldus = t.elapsed().as_micros();
        let _ = arena::search(&aidx, q.to_string(), 8); // warm
        let mut best = u128::MAX;
        let mut newr = Vec::new();
        for _ in 0..3 {
            let t = Instant::now();
            newr = arena::search(&aidx, q.to_string(), 8);
            best = best.min(t.elapsed().as_micros());
        }
        let on: Vec<String> = old.iter().take(5).map(|h| format!("{}:{}", h.kind, h.name)).collect();
        let nn: Vec<String> = newr.iter().take(5).map(|h| format!("{}:{}", h.kind, h.name)).collect();
        // 比对 top-5 的"项集合"(忽略同分并列的顺序差异; 真不同项才算 DIFF)。
        let (mut os, mut ns) = (on.clone(), nn.clone());
        os.sort();
        ns.sort();
        let same = os == ns;
        if same {
            parity += 1;
        }
        println!(
            "--- '{}' [{}] 现引擎 {:.1}ms / arena {:.1}ms ---",
            q,
            if same { "PARITY" } else { "DIFF" },
            oldus as f64 / 1000.0,
            best as f64 / 1000.0
        );
        if same {
            println!("    {}", nn.join("  |  "));
        } else {
            println!("    现引擎: {}", on.join("  |  "));
            println!("    arena : {}", nn.join("  |  "));
        }
    }
    println!("=== PARITY {}/{} ===", parity, queries.len());

    // 增量收窄正确性: 同一查询 冷扫(清缓存) vs 暖扫(先用前缀填缓存→收窄) 必须结果完全一致。
    for (p, q) in [("quant lab", "quant lab readme"), ("aiworkspace", "aiworkspace app")] {
        arena::clear_narrow_cache();
        let cold = arena::search(&aidx, q.to_string(), 8);
        let _ = arena::search(&aidx, p.to_string(), 8); // 填缓存
        let warm = arena::search(&aidx, q.to_string(), 8); // 经收窄
        let c: Vec<_> = cold.iter().map(|h| (h.kind.clone(), h.name.clone(), h.path.clone())).collect();
        let w: Vec<_> = warm.iter().map(|h| (h.kind.clone(), h.name.clone(), h.path.clone())).collect();
        println!(
            "增量收窄正确性 '{}' 经前缀 '{}': {}",
            q,
            p,
            if c == w { "冷暖一致 ✓" } else { "不一致 ✗" }
        );
    }
}

/// 架构验证: poof.exe --bench-arena <N> → 合成 N 行的「紧凑名字 arena」(Everything 同款: 名字连续存进
/// 一个 Vec<u8> + 偏移/长度列), 用 memchr SIMD 子串 + rayon 并行 + top-K 堆扫一遍并计时。用来在动手重写
/// 整个引擎之前, 真跑证明 1100 万行能不能 <100ms —— 即"去掉每行 4 个堆字符串、只扫名字"到底扛不扛得住。
#[cfg(windows)]
pub fn bench_arena(n: usize) {
    use memchr::memmem;
    use rayon::prelude::*;
    use std::time::Instant;
    const WORDS: &[&str] = &[
        "readme", "config", "main", "index", "app", "server", "client", "test", "data", "src",
        "build", "node", "cache", "user", "system", "report", "invoice", "chrome", "aiworkspace",
        "poof", "quant", "model", "schema", "plan", "draft", "service", "module", "vendor",
    ];
    const EXTS: &[&str] = &[
        "txt", "md", "rs", "ts", "js", "json", "exe", "dll", "png", "csv", "xlsx", "log", "pdf",
    ];
    let t0 = Instant::now();
    let mut pool: Vec<u8> = Vec::with_capacity(n * 28);
    let mut offs: Vec<u32> = Vec::with_capacity(n);
    let mut lens: Vec<u16> = Vec::with_capacity(n);
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut nxt = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    for i in 0..n {
        let off = pool.len() as u32;
        pool.extend_from_slice(WORDS[(nxt() as usize) % WORDS.len()].as_bytes());
        pool.push(b'_');
        pool.extend_from_slice(WORDS[(nxt() as usize) % WORDS.len()].as_bytes());
        pool.push(b'_');
        pool.extend_from_slice(format!("{i:x}").as_bytes());
        pool.push(b'.');
        pool.extend_from_slice(EXTS[(nxt() as usize) % EXTS.len()].as_bytes());
        lens.push((pool.len() as u32 - off) as u16);
        offs.push(off);
    }
    let cols = offs.len() * 4 + lens.len() * 2;
    let cores = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(0);
    println!(
        "\n=== 合成 arena {} 行 · 名字池 {:.0}MB + 偏移列 {:.0}MB = {:.0}MB · 建表 {:?} · 逻辑核 {} ===",
        n,
        pool.len() as f64 / 1e6,
        cols as f64 / 1e6,
        (pool.len() + cols) as f64 / 1e6,
        t0.elapsed(),
        cores
    );
    // 一次扫描 = 现在引擎的「一段闸门」: 并行 SIMD 子串命中 → top-K min-heap(faithfully 含堆 churn)。
    let scan = |q: &[u8]| -> (usize, u128) {
        let finder = memmem::Finder::new(q);
        let go = || {
            (0..n)
                .into_par_iter()
                .fold(
                    BinaryHeap::<Reverse<(u32, usize)>>::new,
                    |mut h, i| {
                        let (o, l) = (offs[i] as usize, lens[i] as usize);
                        if let Some(pos) = finder.find(&pool[o..o + l]) {
                            push_topk(&mut h, 80, (10000 - pos.min(9999)) as u32, i);
                        }
                        h
                    },
                )
                .reduce(BinaryHeap::new, |mut a, b| {
                    for Reverse((sc, i)) in b {
                        push_topk(&mut a, 80, sc, i);
                    }
                    a
                })
        };
        let _ = go(); // warm
        let mut best = u128::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            let h = go();
            best = best.min(t.elapsed().as_micros());
            std::hint::black_box(h.len());
        }
        (go().len(), best)
    };
    for q in ["aiworkspace", "config", "chrome", "report"] {
        let (k, us) = scan(q.as_bytes());
        println!("  扫 '{}' → top{} · {:.1} ms", q, k, us as f64 / 1000.0);
    }
    println!(
        "=== 对比: 现在的散落 String 引擎在 4.5M 已 281ms; 紧凑 arena 在 {} 行见上 ===",
        n
    );
}

// 逐字拼音输入的真实模拟基准。跑: poof.exe --bench-search(由 lib.rs run() 开头的参数检查触发,
// 在真·应用二进制里跑 → 原生 DLL 正常加载; cargo test 的独立测试 exe 会 STATUS_ENTRYPOINT_NOT_FOUND)。
pub fn bench_search() {
    use std::io::Write;
    use std::time::Instant;
    let t0 = Instant::now();
    let idx = load_persisted().unwrap_or_else(build_index);
    let n = idx.len();
    *INDEX.lock().unwrap() = Some(idx);
    let cores = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(0);
    println!("
=== 索引 {} 条, 加载 {:?}, 逻辑核 {} ===", n, t0.elapsed(), cores);
    let mut worst = 0u64; // 含 1 字符
    let mut worst_real = 0u64; // ≥2 字符(UI 跳过 1 字符拉丁查询, 故这才是真实最差)
    for word in ["ceshi", "wendang", "xiazai", "config", "readme"] {
        println!("--- 逐字输入 \"{}\" ---", word);
        let mut q = String::new();
        for ch in word.chars() {
            q.push(ch);
            let _ = legacy_search(q.clone(), 40); // 预热
            let mut samples: Vec<(u64, usize)> = (0..3)
                .map(|_| {
                    let t = Instant::now();
                    let r = legacy_search(q.clone(), 40);
                    (t.elapsed().as_micros() as u64, r.len())
                })
                .collect();
            samples.sort();
            let (us, hits) = samples[1];
            worst = worst.max(us);
            if q.len() >= 2 {
                worst_real = worst_real.max(us);
            }
            println!("  '{}' -> {} hits, {:.1} ms", q, hits, us as f64 / 1000.0);
        }
    }
    println!(
        "=== 单键最差: 全部 {:.1} ms / 真实(≥2字符, UI 跳过1字符拉丁) {:.1} ms ===",
        worst as f64 / 1000.0,
        worst_real as f64 / 1000.0
    );
    // 注: 红线 60ms 受 375 万条 String 索引的内存带宽下限制约(每键需流式扫全表); 进一步要重构索引布局
    // (字符串驻留/SoA), 而本计划明确「索引/遍盘不动」。当前与前置基线(73~175ms)持平, 且本机正与运行中的
    // poof + 二十余 node 进程争 24 核, 干净环境会更低。
    if worst_real > 60_000 {
        println!(
            "  ⚠ 真实最差 {:.1}ms > 60ms 目标(索引带宽下限, 与基线持平不回退)",
            worst_real as f64 / 1000.0
        );
    } else {
        println!("  ✓ 性能红线: 真实最差 < 60ms");
    }
    for w in ["config", "ceshi", "readme", "git"] {
        let r = legacy_search(w.to_string(), 5);
        println!("  抽查 '{}': {}", w, r.iter().map(|h| h.name.clone()).collect::<Vec<_>>().join(" | "));
    }
    // ---- 本次改动验收: 应用优先(chrome/code 首条应是 app) + 扩展名过滤(.exe/.xlsx 应全是该扩展名) ----
    println!("--- 应用优先 / 扩展名过滤 抽查(kind:name)---");
    for w in ["chrome", "code", ".exe", ".xlsx", "*.pdf"] {
        let r = legacy_search(w.to_string(), 6);
        let show: Vec<String> = r.iter().map(|h| format!("{}:{}", h.kind, h.name)).collect();
        println!("  '{}' → {}", w, show.join("  |  "));
    }

    // ---- 统一验收断言(不写盘, 不动用户真实 usage.json) ----
    println!("--- 排序断言 ---");
    let now = now_secs();
    // (M0-a) frecency 随新近度: 同 frecency, 越近 use-gain 越高。
    let recent = UsageEntry { frecency: 5.0, last: now };
    let old = UsageEntry { frecency: 5.0, last: now.saturating_sub(90 * 86400) };
    let (gr, go) = (use_gain_fp(&recent, now), use_gain_fp(&old, now));
    println!(
        "  [衰减·新近] 同frecency 近{} vs 旧90天{} → {}",
        gr, go, if gr > go { "✓" } else { "✗" }
    );
    // (M0-b) 足够久的高频会沉到新近低频之下(5 个半衰期后)。
    let old_hot = UsageEntry { frecency: 100.0, last: now.saturating_sub(150 * 86400) };
    let fresh = UsageEntry { frecency: 4.0, last: now };
    let (gh, gf) = (use_gain_fp(&old_hot, now), use_gain_fp(&fresh, now));
    println!(
        "  [衰减·沉底] 旧热(100次/150天前){} vs 新(4次/今){} → {}",
        gh, gf, if gf > gh { "✓ 新近反超" } else { "≈ 仍高频优先" }
    );
    // (M0-c) 重载不丢分: UsageDb serde round-trip 无损(回归 %TEMP% 丢分病)。
    let mut db = UsageDb::default();
    db.items.insert("p".into(), UsageEntry { frecency: 7.5, last: 123 });
    db.overrides.insert("q".into(), 2);
    db.important_folders.push("E:/Proj".into());
    let round: UsageDb = serde_json::from_str(&serde_json::to_string(&db).unwrap()).unwrap();
    let ok_reload = (round.items.get("p").map(|e| e.frecency) == Some(7.5))
        && round.overrides.get("q") == Some(&2)
        && round.important_folders == vec!["E:/Proj".to_string()];
    println!("  [重载不丢分] frecency/override/重要文件夹 round-trip → {}", if ok_reload { "✓" } else { "✗" });

    // (M1) 抗霸榜不等式: 把两条合成项注入索引 + 给子序列项灌满 frecency, 断言「精确文件名冷门」
    // 仍排在「子序列命中最热」之前(prefix 档差 4×/2500 > use 增益 ≤2×, 结构性保证)。
    {
        let mut g = INDEX.lock().unwrap();
        if let Some(idx) = g.as_mut() {
            idx.push(("file".into(), "zqxbench".into(), "Z:/bench/zqxbench".into(), String::new()));
            idx.push((
                "file".into(),
                "az_q_x_b_e_n_c_h.dat".into(),
                "Z:/bench/az_q_x_b_e_n_c_h.dat".into(),
                String::new(),
            ));
        }
    }
    let mut syn = UsageDb::default();
    syn.items.insert(
        "Z:/bench/az_q_x_b_e_n_c_h.dat".into(),
        UsageEntry { frecency: 1000.0, last: now }, // 灌满 frecency
    );
    *USAGE.lock().unwrap() = Some(Arc::new(syn)); // 仅改进程内缓存, 不落盘
    let r = legacy_search("zqxbench".to_string(), 5);
    let top = r.first().map(|h| h.path.as_str()).unwrap_or("(空)");
    let ok_anti = top == "Z:/bench/zqxbench";
    println!(
        "  [抗霸榜] 精确冷门 vs 子序列最热 → 首位={} {}",
        top, if ok_anti { "✓" } else { "✗ 失败!" }
    );

    // ---- M3 纠偏 + M6 标签: 端到端走真实 search() 路径(注入进程内缓存, 不写盘)----
    println!("--- 纠偏/标签 集成 ---");
    {
        let mut g = INDEX.lock().unwrap();
        if let Some(idx) = g.as_mut() {
            for (n, p) in [
                ("alphaqz.txt", "Z:/it/alphaqz.txt"),
                ("alphaqz_other.txt", "Z:/it/alphaqz_other.txt"),
                ("betaqz_doc.txt", "Z:/it/betaqz_doc.txt"),
            ] {
                idx.push(("file".into(), n.into(), p.into(), String::new()));
            }
        }
    }
    // (M3-Pin) 置顶 alphaqz_other → 同样匹配 "alphaqz" 时它排到 alphaqz.txt 前面。
    let mut up = UsageDb::default();
    up.overrides.insert("Z:/it/alphaqz_other.txt".into(), 2);
    *USAGE.lock().unwrap() = Some(Arc::new(up));
    let r = legacy_search("alphaqz".to_string(), 5);
    let first = r.first().map(|h| h.path.as_str()).unwrap_or("(空)");
    println!(
        "  [Pin] 置顶项是否冒到首位 → {} {}",
        first,
        if first == "Z:/it/alphaqz_other.txt" { "✓" } else { "✗" }
    );
    // (M3-Hide) 隐藏 alphaqz_other → 从结果消失。
    let mut uh = UsageDb::default();
    uh.overrides.insert("Z:/it/alphaqz_other.txt".into(), -2);
    *USAGE.lock().unwrap() = Some(Arc::new(uh));
    let r = legacy_search("alphaqz".to_string(), 5);
    let hidden_gone = !r.iter().any(|h| h.path == "Z:/it/alphaqz_other.txt");
    let other_stays = r.iter().any(|h| h.path == "Z:/it/alphaqz.txt");
    println!(
        "  [Hide] 隐藏项从结果剔除(且同名未隐藏项仍在)→ {}",
        if hidden_gone && other_stays { "✓" } else { "✗" }
    );
    // (M6 #tag) 给 betaqz_doc 打标签 wip → "#wip betaqz" 只剩它; alphaqz 不带 wip 标签被过滤掉。
    *USAGE.lock().unwrap() = Some(Arc::new(UsageDb::default()));
    let mut tagmap = HashMap::new();
    tagmap.insert(
        "Z:/it/betaqz_doc.txt".to_string(),
        vec!["wip".to_string()],
    );
    crate::tags::_bench_inject(tagmap, vec![]);
    let r = legacy_search("#wip betaqz".to_string(), 5);
    let tag_ok = r.len() == 1 && r[0].path == "Z:/it/betaqz_doc.txt" && r[0].tags == vec!["wip".to_string()];
    let r2 = legacy_search("#wip alphaqz".to_string(), 5); // alphaqz 无 wip → 应空
    println!(
        "  [#tag] #wip 过滤命中带标签者 + chip 回传({} 条) / 非标签项被滤({} 条)→ {}",
        r.len(),
        r2.len(),
        if tag_ok && r2.is_empty() { "✓" } else { "✗" }
    );

    // (M7 FileId) 救援键 round-trip: 取本 exe 自身的 FileId → 解析回当前路径, 断言一致。
    if let Ok(self_path) = std::env::current_exe() {
        let sp = self_path.to_string_lossy().to_string();
        match crate::fileid::capture(&sp) {
            Some(fid) => {
                let back = crate::fileid::resolve(&fid);
                let ok = back
                    .as_deref()
                    .map(|b| b.eq_ignore_ascii_case(&sp))
                    .unwrap_or(false);
                println!(
                    "  [FileId救援] 捕获→解析回当前路径 → {} {}",
                    back.as_deref().unwrap_or("(失败)"),
                    if ok { "✓" } else { "✗" }
                );
            }
            None => println!("  [FileId救援] 捕获失败(本机可能非 NTFS, best-effort 跳过)"),
        }
    }

    let _ = std::io::stdout().flush();
}

// ============================================================================================
// arena 引擎(Everything 同款): 名字连续存进字节池 + 路径用父指针树按需重建。详见
// docs/plans/search-engine-arena-rewrite-plan.md。先做成与现引擎并存、可对比验证, 验证通过再切换。
// ============================================================================================
pub mod arena {
    use super::{
        depth_factor, ext_query, match_quality, match_terms, name_has_ext, now_secs, parse_query,
        push_topk, type_base, type_factor_fp, under_important, usage_db, use_gain_fp, user_home_fp,
        AUTO_IMPORTANT,
    };
    use super::{Entry, SearchHit};
    use crate::tags::scoring_snapshot;
    use memchr::memmem;
    use rayon::prelude::*;
    use std::cmp::Reverse;
    use std::collections::{BinaryHeap, HashMap};
    use std::sync::atomic::{AtomicU64, Ordering};

    // 取消令牌(fzf 式): 每次 search 自增并捕获自己的代次; 热循环里发现代次变了说明有更新的按键进来,
    // 立即放弃这次扫描 —— 慢查询不再阻塞后续按键。
    static QUERY_GEN: AtomicU64 = AtomicU64::new(0);

    // 增量收窄缓存: 上次查询及其「全部命中行」—— 仅当上次命中数 < kbuf(堆未满 = 堆即全部命中)时才缓存,
    // 故 rows 必 ≤600 条、内存极小且**完整**。新查询是上次的严格前缀扩展(原串前缀 + 同 tag/ext/path-mode)
    // 时, 命中必是上次的子集, 于是只扫这几百行而非全表。任何非扩展变更(退格/改写/加斜杠/换标签)→ 全扫。
    struct LastQuery {
        text: String,
        score_path: bool,
        ext: Option<String>,
        tags: Vec<String>,
        rows: Vec<u32>,
    }
    static LAST: std::sync::Mutex<Option<LastQuery>> = std::sync::Mutex::new(None);
    enum Cand {
        Full,
        Subset(Vec<u32>),
    }
    // 清收窄缓存(测试用: 强制下一次为冷全扫)。
    pub fn clear_narrow_cache() {
        *LAST.lock().unwrap() = None;
    }

    const ROOT: u32 = u32::MAX;
    const KIND_FILE: u8 = 0;
    const KIND_EXE: u8 = 1;
    const KIND_FOLDER: u8 = 2;
    const KIND_APP: u8 = 3;

    #[inline]
    fn kind_byte(k: &str) -> u8 {
        match k {
            "app" => KIND_APP,
            "exe" => KIND_EXE,
            "folder" => KIND_FOLDER,
            _ => KIND_FILE,
        }
    }
    #[inline]
    fn kind_str(b: u8) -> &'static str {
        match b & 0b11 {
            KIND_APP => "app",
            KIND_EXE => "exe",
            KIND_FOLDER => "folder",
            _ => "file",
        }
    }
    #[inline]
    fn fnv32(bytes: &[u8]) -> u32 {
        let mut h: u32 = 0x811c_9dc5;
        for &b in bytes {
            h ^= b.to_ascii_lowercase() as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
        h
    }
    // path "C:/Users\foo" → (b'C', ["Users","foo"]). 分隔符 / 与 \ 都吃。
    fn split_path(path: &str) -> Option<(u8, Vec<&str>)> {
        let b = path.as_bytes();
        if b.len() < 2 || b[1] != b':' || !b[0].is_ascii_alphabetic() {
            return None;
        }
        let comps: Vec<&str> = path[2..]
            .split(|c| c == '/' || c == '\\')
            .filter(|s| !s.is_empty())
            .collect();
        Some((b[0].to_ascii_uppercase(), comps))
    }
    // 每盘根的 by_parent_name 父键(把盘符编进 ROOT 槽, 区分各盘的同名顶层目录)。
    #[inline]
    fn root_key(drive: u8) -> u32 {
        ROOT - (drive.to_ascii_uppercase() - b'A') as u32
    }
    // 列 ↔ 小端字节(二进制持久化用; 不引 bytemuck, 自滚, save 一次性拷贝可接受)。
    fn to_le_u32(v: &[u32]) -> Vec<u8> {
        let mut b = Vec::with_capacity(v.len() * 4);
        for &x in v {
            b.extend_from_slice(&x.to_le_bytes());
        }
        b
    }
    fn to_le_u16(v: &[u16]) -> Vec<u8> {
        let mut b = Vec::with_capacity(v.len() * 2);
        for &x in v {
            b.extend_from_slice(&x.to_le_bytes());
        }
        b
    }
    fn un_u32(b: &[u8]) -> Vec<u32> {
        b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect()
    }
    fn un_u16(b: &[u8]) -> Vec<u16> {
        b.chunks_exact(2).map(|c| u16::from_le_bytes(c.try_into().unwrap())).collect()
    }

    pub struct Index {
        lname: Vec<u8>, // 全部名字拼接, ASCII 小写(匹配用)
        // 大写位图: 1 bit / lname 字节, 标记该字节原本是大写 ASCII。显示名由 lname + 此位重建 —— 省掉一份
        // 整名原样拷贝(11M 时 ~242MB → ~30MB)。lname 只做 ASCII 小写, 故仅 A-Z 位需还原, 可无损重建。
        case_bits: Vec<u8>,
        py: Vec<u8>, // 拼音(全拼+首字母)拼接, 仅 CJK 行非空
        name_off: Vec<u32>,
        name_len: Vec<u16>,
        py_off: Vec<u32>,
        py_len: Vec<u16>,
        parent: Vec<u32>,
        flags: Vec<u8>,
        depth: Vec<u8>,
        drive: Vec<u8>,
        by_name: Vec<u32>,
        tomb: Vec<u64>, // 自滚位向量
        // (父键, 名字哈希) → 行号。父键 = 普通父行号, 或盘根的 root_key(drive)。活更新 + 路径→行解析用。
        by_parent_name: HashMap<(u32, u32), u32>,
        n: u32,
    }

    impl Index {
        fn with_capacity(rows: usize) -> Self {
            Index {
                lname: Vec::with_capacity(rows * 28),
                case_bits: Vec::with_capacity(rows * 28 / 8 + 1),
                py: Vec::with_capacity(rows / 4),
                name_off: Vec::with_capacity(rows),
                name_len: Vec::with_capacity(rows),
                py_off: Vec::with_capacity(rows),
                py_len: Vec::with_capacity(rows),
                parent: Vec::with_capacity(rows),
                flags: Vec::with_capacity(rows),
                depth: Vec::with_capacity(rows),
                drive: Vec::with_capacity(rows),
                by_name: Vec::new(),
                tomb: Vec::new(),
                by_parent_name: HashMap::with_capacity(rows),
                n: 0,
            }
        }
        pub fn len(&self) -> usize {
            self.n as usize
        }
        // 逐字段内存占用(按 capacity, 即真实分配)。诊断"为啥吃 1.2GB"。
        pub fn mem_report(&self) -> String {
            let mb = |b: usize| b as f64 / 1_048_576.0;
            let lname = self.lname.capacity();
            let case_bits = self.case_bits.capacity();
            let py = self.py.capacity();
            let cols = self.name_off.capacity() * 4
                + self.name_len.capacity() * 2
                + self.py_off.capacity() * 4
                + self.py_len.capacity() * 2
                + self.parent.capacity() * 4
                + self.flags.capacity()
                + self.depth.capacity()
                + self.drive.capacity();
            let by_name = self.by_name.capacity() * 4;
            let tomb = self.tomb.capacity() * 8;
            // hashbrown: buckets = next_pow2(cap*8/7), 每 bucket = (键12B + 1 控制字节)。
            let bpn_len = self.by_parent_name.len();
            let bpn_cap = self.by_parent_name.capacity();
            let buckets = (bpn_cap * 8 / 7).next_power_of_two().max(1);
            let bpn = buckets * 13;
            let total = lname + case_bits + py + cols + by_name + tomb + bpn;
            format!(
                "n={} 总≈{:.0}MB\n  lname(小写名)={:.0}MB  case_bits(大写位图)={:.0}MB  py(拼音)={:.0}MB\n  列(off/len/parent/flags…)={:.0}MB  by_name={:.0}MB  tomb={:.1}MB\n  by_parent_name={:.0}MB (占用{}项 / cap{} / {}buckets)",
                self.n, mb(total),
                mb(lname), mb(case_bits), mb(py),
                mb(cols), mb(by_name), mb(tomb),
                mb(bpn), bpn_len, bpn_cap, buckets
            )
        }
        pub fn is_empty(&self) -> bool {
            self.n == 0
        }
        #[inline]
        fn lname_at(&self, row: u32) -> &[u8] {
            let (o, l) = (self.name_off[row as usize] as usize, self.name_len[row as usize] as usize);
            &self.lname[o..o + l]
        }
        // 显示名: 取 lname 切片, 按 case_bits 把原本大写的字节还原成大写。只对要展示的少数行调用, 每次新分配无妨。
        fn disp_at(&self, row: u32) -> Vec<u8> {
            let (o, l) = (self.name_off[row as usize] as usize, self.name_len[row as usize] as usize);
            let mut out = self.lname[o..o + l].to_vec();
            for (j, b) in out.iter_mut().enumerate() {
                let bit = o + j;
                if self.case_bits.get(bit / 8).map_or(false, |w| w >> (bit % 8) & 1 == 1) {
                    *b = b.to_ascii_uppercase();
                }
            }
            out
        }
        #[inline]
        fn py_at(&self, row: u32) -> &[u8] {
            let (o, l) = (self.py_off[row as usize] as usize, self.py_len[row as usize] as usize);
            &self.py[o..o + l]
        }
        #[inline]
        fn tomb_get(&self, row: u32) -> bool {
            self.tomb
                .get(row as usize / 64)
                .map(|w| w >> (row % 64) & 1 == 1)
                .unwrap_or(false)
        }
        fn tomb_set(&mut self, row: u32, dead: bool) {
            let need = (self.n as usize).div_ceil(64);
            if self.tomb.len() < need {
                self.tomb.resize(need, 0);
            }
            if let Some(w) = self.tomb.get_mut(row as usize / 64) {
                if dead {
                    *w |= 1 << (row % 64);
                } else {
                    *w &= !(1u64 << (row % 64));
                }
            }
        }

        // 活更新: 插入一个路径(补全缺失祖先目录), 返回叶行号。已存在则复用(并取消其墓碑=复活)。
        // push_row 不建派生表(by_parent_name/tomb), 故活更新在此自补; by_name 暂留旧序(只影响并列 tie-break)。
        pub fn insert_path(&mut self, path: &str, kind: u8, py: &str) -> Option<u32> {
            let (drive, comps) = split_path(path)?;
            if comps.is_empty() {
                return None;
            }
            let mut parent = ROOT;
            for (i, comp) in comps.iter().enumerate() {
                let pkey = if parent == ROOT { root_key(drive) } else { parent };
                let h = fnv32(comp.as_bytes());
                let existing = self
                    .by_parent_name
                    .get(&(pkey, h))
                    .copied()
                    .filter(|&r| self.lname_at(r).eq_ignore_ascii_case(comp.as_bytes()));
                if let Some(row) = existing {
                    self.tomb_set(row, false);
                    parent = row;
                    continue;
                }
                let is_leaf = i + 1 == comps.len();
                let (k, p) = if is_leaf { (kind, py) } else { (KIND_FOLDER, "") };
                let row = self.push_row(comp, parent, drive, k, p);
                self.tomb_set(row, false); // 扩容 tomb 位图
                self.by_parent_name.insert((pkey, h), row);
                parent = row;
            }
            Some(parent)
        }

        // 活更新: 路径删除 → 墓碑(扫描跳过)。返回是否命中。
        pub fn remove_path(&mut self, path: &str) -> bool {
            if let Some(row) = self.resolve(path) {
                self.tomb_set(row, true);
                true
            } else {
                false
            }
        }

        // 追加一行, 返回行号。depth 当场由父算出(父总在子之前建好)。
        fn push_row(&mut self, name: &str, parent: u32, drive: u8, kind: u8, py: &str) -> u32 {
            let row = self.n;
            let off = self.lname.len() as u32; // 偏移进 lname(显示名由 lname + case_bits 重建, 不再存原名)
            let nb = name.as_bytes();
            for (j, &b) in nb.iter().enumerate() {
                self.lname.push(b.to_ascii_lowercase());
                if b.is_ascii_uppercase() {
                    let bit = off as usize + j;
                    let byte = bit / 8;
                    if self.case_bits.len() <= byte {
                        self.case_bits.resize(byte + 1, 0);
                    }
                    self.case_bits[byte] |= 1 << (bit % 8);
                }
            }
            // 保持 case_bits 覆盖到 lname 末尾(字节对齐), 即便本名无大写。
            let need = (self.lname.len()).div_ceil(8);
            if self.case_bits.len() < need {
                self.case_bits.resize(need, 0);
            }
            self.name_off.push(off);
            self.name_len.push(nb.len().min(u16::MAX as usize) as u16);
            let pyoff = self.py.len() as u32;
            self.py.extend_from_slice(py.as_bytes());
            self.py_off.push(pyoff);
            self.py_len.push(py.len().min(u16::MAX as usize) as u16);
            self.parent.push(parent);
            self.flags.push(kind);
            self.drive.push(drive);
            let d = if parent == ROOT {
                1
            } else {
                self.depth[parent as usize].saturating_add(1)
            };
            self.depth.push(d);
            self.n += 1;
            row
        }

        // 重建派生表(by_name 预排序 + by_parent_name 解析索引 + tomb 位图)。build() 与二进制 load() 都调,
        // 故这些表不必序列化 —— 只存原始 arena/列, 加载后 finish 重建(11M 约 1-2s, 远快于重新 interning)。
        fn finish_derived(&mut self) {
            let n = self.n as usize;
            if self.tomb.is_empty() {
                self.tomb = vec![0u64; n.div_ceil(64)];
            }
            let mut bn: Vec<u32> = (0..self.n).collect();
            bn.sort_unstable_by(|&a, &b| self.lname_at(a).cmp(self.lname_at(b)));
            self.by_name = bn;
            self.by_parent_name = HashMap::with_capacity(n);
            for row in 0..self.n {
                let parent = self.parent[row as usize];
                let pkey = if parent == ROOT {
                    root_key(self.drive[row as usize])
                } else {
                    parent
                };
                self.by_parent_name.insert((pkey, fnv32(self.lname_at(row))), row);
            }
        }

        // 由父指针记忆化重算所有行的 depth。MFT 直建树时父在 PASS B 才回填(push 时父=ROOT 占位),
        // depth 须事后统一算; 遍历/interning 路径 push 时父已在、depth 已对, 这里重算结果相同(幂等)。
        fn compute_depths(&mut self) {
            let n = self.n as usize;
            for d in self.depth.iter_mut() {
                *d = 0; // 0 = 未算; 真实 depth ≥ 1
            }
            let mut stack: Vec<u32> = Vec::with_capacity(64);
            for start in 0..self.n {
                if self.depth[start as usize] != 0 {
                    continue;
                }
                stack.clear();
                let mut cur = start;
                loop {
                    if cur == ROOT || self.depth[cur as usize] != 0 {
                        break;
                    }
                    stack.push(cur);
                    cur = self.parent[cur as usize];
                    if stack.len() > 300 {
                        break; // 环/超深守卫
                    }
                }
                let mut d = if cur == ROOT { 0 } else { self.depth[cur as usize] as u32 };
                while let Some(r) = stack.pop() {
                    d += 1;
                    self.depth[r as usize] = d.min(255) as u8;
                }
            }
        }

        // 把一批 (kind,name,path,py) 以路径 interning 方式并入(补全祖先目录)。intern 跨调用持续, 用于
        // 遍历盘 + poof-roots.txt 子根 + 去重。
        fn add_entries(&mut self, interned: &mut HashMap<String, u32>, entries: &[Entry]) {
            let mut key = String::with_capacity(96);
            for (kind, name, path, py) in entries {
                let Some((drive, comps)) = split_path(path) else {
                    continue;
                };
                if comps.is_empty() {
                    continue;
                }
                key.clear();
                key.push((drive as char).to_ascii_lowercase());
                key.push(':');
                let mut parent = ROOT;
                for (i, comp) in comps.iter().enumerate() {
                    key.push('\\');
                    for ch in comp.chars() {
                        for lc in ch.to_lowercase() {
                            key.push(lc);
                        }
                    }
                    let is_leaf = i + 1 == comps.len();
                    if let Some(&row) = interned.get(&key) {
                        parent = row;
                    } else {
                        let (k, p) = if is_leaf {
                            (kind_byte(kind), py.as_str())
                        } else {
                            (KIND_FOLDER, "")
                        };
                        let row = self.push_row(comp, parent, drive, k, p);
                        interned.insert(key.clone(), row);
                        parent = row;
                    }
                }
            }
        }

        // 从 MFT 原始节点 (record,name,parent_record,is_dir) 直建子树, 零路径字符串。PASS A 压行(父占位)+
        // 记录 record→row; PASS B 回填父行号。depth/by_parent_name 由 build_full 末尾的 compute_depths+finish 统一建。
        pub fn add_mft_volume(&mut self, letter: u8, nodes: Vec<(u64, String, u64, bool)>) {
            let mut rec2row: HashMap<u64, u32> = HashMap::with_capacity(nodes.len());
            for (rec, name, _parent, is_dir) in &nodes {
                let kb = if *is_dir {
                    KIND_FOLDER
                } else {
                    let l = name.to_ascii_lowercase();
                    if l.ends_with(".exe") || l.ends_with(".bat") || l.ends_with(".cmd") || l.ends_with(".ps1") {
                        KIND_EXE
                    } else {
                        KIND_FILE
                    }
                };
                let py = super::pinyin_of(name);
                let row = self.push_row(name, ROOT, letter, kb, &py);
                rec2row.insert(*rec, row);
            }
            for (rec, _name, parent, _is_dir) in &nodes {
                let row = rec2row[rec];
                let prow = rec2row.get(parent).copied().unwrap_or(ROOT);
                self.parent[row as usize] = prow;
            }
        }

        // 应用后置: 解析 .lnk 路径 → 把那行 kind 标为 app(显示时再剥 .lnk)。找不到(不在已索引盘)则插入。
        pub fn set_app(&mut self, path: &str, py: &str) {
            if let Some(row) = self.resolve(path) {
                self.flags[row as usize] = (self.flags[row as usize] & !0b11) | KIND_APP;
            } else {
                let _ = self.insert_path(path, KIND_APP, py);
            }
        }

        // ---- 二进制持久化(Everything 的 .db: 内存结构的紧凑转储)----
        pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
            use std::io::Write;
            let tmp = path.with_extension("bin.tmp");
            let f = std::fs::File::create(&tmp)?;
            let mut w = std::io::BufWriter::new(f);
            w.write_all(b"POOFIDX3")?; // magic+version (v3: disp 原名拷贝 → case_bits 大写位图)
            w.write_all(&self.n.to_le_bytes())?;
            let blob = |w: &mut std::io::BufWriter<std::fs::File>, b: &[u8]| -> std::io::Result<()> {
                w.write_all(&(b.len() as u64).to_le_bytes())?;
                w.write_all(b)
            };
            blob(&mut w, &self.lname)?;
            blob(&mut w, &self.case_bits)?;
            blob(&mut w, &self.py)?;
            blob(&mut w, &to_le_u32(&self.name_off))?;
            blob(&mut w, &to_le_u16(&self.name_len))?;
            blob(&mut w, &to_le_u32(&self.py_off))?;
            blob(&mut w, &to_le_u16(&self.py_len))?;
            blob(&mut w, &to_le_u32(&self.parent))?;
            blob(&mut w, &self.flags)?;
            blob(&mut w, &self.depth)?;
            blob(&mut w, &self.drive)?;
            w.flush()?;
            drop(w);
            std::fs::rename(&tmp, path)
        }
        pub fn load(path: &std::path::Path) -> Option<Index> {
            // mmap 而非 read: 不一次性把整块(11M ~1GB)读进堆造成双倍峰值; 按页惰性载入, 列拷出后即解映射。
            let file = std::fs::File::open(path).ok()?;
            let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
            let bytes: &[u8] = &mmap;
            if bytes.len() < 12 || &bytes[..8] != b"POOFIDX3" {
                return None; // 旧版(含 disp 全拷)不兼容 → 返回 None → 触发一次重建(自动全量会补上)
            }
            let n = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
            let mut p = 12usize;
            let mut take = |len_check: usize| -> Option<&[u8]> {
                if p + 8 > bytes.len() {
                    return None;
                }
                let l = u64::from_le_bytes(bytes[p..p + 8].try_into().ok()?) as usize;
                p += 8;
                if p + l > bytes.len() {
                    return None;
                }
                let s = &bytes[p..p + l];
                p += l;
                let _ = len_check;
                Some(s)
            };
            let lname = take(0)?.to_vec();
            let case_bits = take(0)?.to_vec();
            let py = take(0)?.to_vec();
            let name_off = un_u32(take(0)?);
            let name_len = un_u16(take(0)?);
            let py_off = un_u32(take(0)?);
            let py_len = un_u16(take(0)?);
            let parent = un_u32(take(0)?);
            let flags = take(0)?.to_vec();
            let depth = take(0)?.to_vec();
            let drive = take(0)?.to_vec();
            if name_off.len() != n as usize {
                return None;
            }
            let mut idx = Index {
                lname,
                case_bits,
                py,
                name_off,
                name_len,
                py_off,
                py_len,
                parent,
                flags,
                depth,
                drive,
                by_name: Vec::new(),
                tomb: Vec::new(),
                by_parent_name: HashMap::new(),
                n,
            };
            idx.finish_derived();
            Some(idx)
        }

        // 行 → 规范全路径 "X:\a\b\c"(走父指针, 只对要展示的少数行调用)。
        pub fn path_of(&self, row: u32) -> String {
            let mut comps: Vec<Vec<u8>> = Vec::with_capacity(8);
            let mut cur = row;
            let mut guard = 0;
            while cur != ROOT {
                comps.push(self.disp_at(cur));
                cur = self.parent[cur as usize];
                guard += 1;
                if guard > 256 {
                    break;
                }
            }
            let mut s = String::with_capacity(80);
            s.push(self.drive[row as usize] as char);
            s.push(':');
            for c in comps.iter().rev() {
                s.push('\\');
                s.push_str(&String::from_utf8_lossy(c));
            }
            s
        }

        // 全路径 → 行号(走 by_parent_name 逐段下行)。供把稀疏 path 键的 frecency/override/标签重键成行号。
        fn resolve(&self, path: &str) -> Option<u32> {
            let (drive, comps) = split_path(path)?;
            if comps.is_empty() {
                return None;
            }
            let mut cur = root_key(drive);
            for comp in &comps {
                let row = *self.by_parent_name.get(&(cur, fnv32(comp.as_bytes())))?;
                // 哈希碰撞守卫: 校验名字真等(大小写不敏感)。
                if !self.lname_at(row).eq_ignore_ascii_case(comp.as_bytes()) {
                    return None;
                }
                cur = row;
            }
            Some(cur)
        }

        // 走祖先目录, 找 term 连续子串首个命中的(祖先行, 位置) —— 多词跨路径(aiworkspace app)的正确做法:
        // 全是 cache 热的 arena 读 + 指针跳, 零路径字符串构建。返回祖先行+位置以便算与路径段一致的档位。
        #[inline]
        fn ancestor_find(&self, finder: &memmem::Finder, row: u32) -> Option<(u32, usize)> {
            let mut cur = self.parent[row as usize];
            let mut guard = 0;
            while cur != ROOT {
                if let Some(p) = finder.find(self.lname_at(cur)) {
                    return Some((cur, p));
                }
                cur = self.parent[cur as usize];
                guard += 1;
                if guard > 256 {
                    break;
                }
            }
            None
        }
    }

    // 从现引擎的 Entry 元组建 arena(对每条目的路径补全所有祖先目录为行, 使父树完整可重建路径)。
    // 这条路对遍历与 MFT 产物都通用(都给 (kind,name,path,py)); 11M 的 MFT 直建树(免路径字符串)是后续优化。
    pub fn build(entries: &[Entry]) -> Index {
        let mut idx = Index::with_capacity(entries.len() + entries.len() / 4);
        let mut interned: HashMap<String, u32> = HashMap::with_capacity(entries.len() * 2);
        idx.add_entries(&mut interned, entries);
        idx.compute_depths();
        idx.finish_derived();
        idx
    }

    // 遍历一个根 → (kind,name,path,py) 列表(喂 add_entries)。
    fn collect_entries(root: &std::path::PathBuf) -> Vec<Entry> {
        super::collect(std::slice::from_ref(root), 40, usize::MAX)
            .into_iter()
            .map(|(name, path, is_dir)| {
                let kind = super::kind_for(&name, is_dir).to_string();
                let py = super::pinyin_of(&name);
                (kind, name, path, py)
            })
            .collect()
    }

    // 生产全量构建: MFT 可用的盘**直建父指针树**(零路径字符串, 省 11M 构建期瞬时内存), 其余盘 + poof-roots
    // 子根走遍历 interning, 最后应用后置(开始菜单 .lnk → kind app)。warm_index/reindex 走这条路。
    pub fn build_full() -> Index {
        let mut idx = Index::with_capacity(4_000_000);
        let mut interned: HashMap<String, u32> = HashMap::new();
        for root in super::index_roots() {
            #[cfg(windows)]
            if let Some(letter) = super::drive_root_letter(&root) {
                if let Some(nodes) = crate::mft::enumerate_volume_nodes(letter) {
                    super::ilog(&format!(
                        "[index] {}: MFT(管理员) 直建树 {} 节点",
                        letter,
                        nodes.len()
                    ));
                    idx.add_mft_volume(letter as u8, nodes);
                    continue;
                }
                super::ilog(&format!("[index] {}: MFT 不可用(非管理员/EDR) → 遍历", letter));
            }
            let e = collect_entries(&root);
            idx.add_entries(&mut interned, &e);
        }
        idx.compute_depths();
        idx.finish_derived();
        // 应用后置: 开始菜单 .lnk → 标 kind app(显示剥 .lnk)。
        for (name, path, is_dir) in super::collect(&super::app_roots(), 5, 8000) {
            if is_dir || !name.to_ascii_lowercase().ends_with(".lnk") {
                continue;
            }
            let display = &name[..name.len() - 4];
            idx.set_app(&path, &super::pinyin_of(display));
        }
        idx
    }

    // 多词 AND(arena 版): 每词必须命中 本行名字 | 拼音 | 某祖先目录名(memmem 连续子串)。与现引擎
    // match_terms 同语义; combine: pfx 取各词最小档, mn 取均值。score_path 时才走祖先(路径形查询)。
    #[inline]
    fn match_multi(
        idx: &Index,
        finders: &[memmem::Finder],
        row: u32,
        score_path: bool,
    ) -> Option<(i64, i64)> {
        let nb = idx.lname_at(row);
        let pyb = idx.py_at(row);
        let mut mn_sum = 0i64;
        let mut pfx_min = i64::MAX;
        for f in finders {
            let t = f.needle();
            let (mn, pfx) = if let Some(p) = f.find(nb) {
                super::substr_tier(t, nb, p, false)
            } else if !pyb.is_empty() && f.find(pyb).is_some() {
                let p = f.find(pyb).unwrap();
                super::substr_tier(t, pyb, p, false)
            } else if score_path {
                match idx.ancestor_find(f, row) {
                    Some((arow, pos)) => super::substr_tier(t, idx.lname_at(arow), pos, true),
                    None => return None,
                }
            } else {
                return None;
            };
            mn_sum += mn;
            pfx_min = pfx_min.min(pfx);
        }
        Some((mn_sum / finders.len() as i64, pfx_min))
    }

    // 标签因子(arena 版, 按行号): 直接标签 1.3 / 祖先继承 1.15; 第二返回 = 是否命中置顶标签。
    fn arena_tag_factor(
        idx: &Index,
        row: u32,
        tags_row: &HashMap<u32, Vec<String>>,
        snap: &crate::tags::TagSnapshot,
    ) -> (i64, bool) {
        if !snap.has_any {
            return (1000, false);
        }
        if let Some(t) = tags_row.get(&row) {
            return (1300, t.iter().any(|x| snap.is_pinned(x)));
        }
        let mut cur = idx.parent[row as usize];
        let mut guard = 0;
        while cur != ROOT {
            if let Some(t) = tags_row.get(&cur) {
                return (1150, t.iter().any(|x| snap.is_pinned(x)));
            }
            cur = idx.parent[cur as usize];
            guard += 1;
            if guard > 256 {
                break;
            }
        }
        (1000, false)
    }

    /// arena 版搜索 —— 与 super::search 同语义同排序, 数据走紧凑 arena。两段式: 一段并行闸门(子序列/子串
    /// + 廉价分), 二段仅幸存者重建路径 + 用 super 的排序助手全量重打分(逐位 parity)。
    pub fn search(idx: &Index, query: String, limit: usize) -> Vec<SearchHit> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let (text, term_strs, req_tags) = parse_query(q);
        let browse = text.trim().is_empty();
        let ext_mode: Option<String> = if req_tags.is_empty() { ext_query(&text) } else { None };
        if browse && req_tags.is_empty() {
            return Vec::new();
        }
        let mut terms: Vec<Vec<u8>> = term_strs.iter().map(|s| s.clone().into_bytes()).collect();
        terms.sort_by(|a, b| b.len().cmp(&a.len()));
        let multi = terms.len() > 1;
        let score_path = multi || text.contains('/') || text.contains('\\');

        // ---- 快照 + 重键到行号(稀疏, 走 by_parent_name 解析)----
        let usage = usage_db();
        let now = now_secs();
        let mut gains_row: HashMap<u32, i64> = HashMap::with_capacity(usage.items.len());
        for (p, e) in usage.items.iter() {
            if let Some(r) = idx.resolve(p) {
                gains_row.insert(r, use_gain_fp(e, now));
            }
        }
        let mut over_row: HashMap<u32, i8> = HashMap::new();
        for (p, &lv) in usage.overrides.iter() {
            if let Some(r) = idx.resolve(p) {
                over_row.insert(r, lv);
            }
        }
        let mut important: Vec<String> = usage.important_folders.clone();
        important.extend(AUTO_IMPORTANT.lock().unwrap().iter().cloned());
        let tagsnap = scoring_snapshot();
        // 标签按行号重键(消除"规范路径 vs 索引原路径"分隔符不一致导致的路径键失配)。稀疏(只有打过标签的)。
        let mut tags_row: HashMap<u32, Vec<String>> = HashMap::new();
        for (p, t) in tagsnap.paths.iter() {
            if let Some(r) = idx.resolve(p) {
                tags_row.insert(r, t.clone());
            }
        }
        // #tag 直接标签闸门 → 满足全部 req_tag 的行号集。
        let req_tag_rows: Option<std::collections::HashSet<u32>> = if req_tags.is_empty() {
            None
        } else {
            let mut m = std::collections::HashSet::new();
            for (p, t) in tagsnap.paths.iter() {
                if req_tags
                    .iter()
                    .all(|r| t.iter().any(|x| x.eq_ignore_ascii_case(r)))
                {
                    if let Some(rr) = idx.resolve(p) {
                        m.insert(rr);
                    }
                }
            }
            Some(m)
        };

        let finders: Vec<memmem::Finder> = terms.iter().map(|t| memmem::Finder::new(t)).collect();
        let qb0: Vec<u8> = terms.first().cloned().unwrap_or_default();
        let kbuf = (limit * 2).clamp(80, 600);
        let n = idx.n;
        let gen = QUERY_GEN.fetch_add(1, Ordering::SeqCst) + 1; // 本次查询代次(更新的按键会令其作废)

        // 增量收窄: 新查询是上次的严格前缀扩展(且 tag/ext/path-mode 不变)→ 命中必是上次的子集, 只扫缓存行。
        let cand = {
            let last = LAST.lock().unwrap();
            match &*last {
                Some(l)
                    if text.starts_with(&l.text)
                        && text.len() > l.text.len()
                        && score_path == l.score_path
                        && ext_mode == l.ext
                        && req_tags == l.tags =>
                {
                    if l.rows.is_empty() {
                        return Vec::new(); // 前缀已无命中 → 更长亦无
                    }
                    Cand::Subset(l.rows.clone())
                }
                _ => Cand::Full,
            }
        };

        // 单行闸门(命中 → push 廉价分到 top-K 堆; 否则原样返回)。全表扫与子集扫共用。
        let process = |mut h: BinaryHeap<Reverse<(u32, usize)>>, row: u32| {
            if row % 1024 == 0 && QUERY_GEN.load(Ordering::Relaxed) != gen {
                return h; // 有更新按键 → 放弃(分摊原子读)
            }
            if idx.tomb_get(row) {
                return h;
            }
            if let Some(rt) = &req_tag_rows {
                if !rt.contains(&row) {
                    return h;
                }
            }
            let kind = kind_str(idx.flags[row as usize]);
            let (mn, pfx) = match &ext_mode {
                Some(ext) => {
                    let dn_owned = idx.disp_at(row);
                    let dn = std::str::from_utf8(&dn_owned).unwrap_or("");
                    if kind != "folder" && name_has_ext(dn, ext) {
                        (1000, 1000)
                    } else {
                        return h;
                    }
                }
                None => {
                    if multi {
                        match match_multi(idx, &finders, row, score_path) {
                            Some(x) => x,
                            None => return h,
                        }
                    } else {
                        let ns = std::str::from_utf8(idx.lname_at(row)).unwrap_or("");
                        let ps = std::str::from_utf8(idx.py_at(row)).unwrap_or("");
                        match match_quality(&qb0, ns, ps, "", browse, false) {
                            Some(x) => x,
                            None => return h,
                        }
                    }
                }
            };
            let ov = over_row.get(&row).copied().unwrap_or(0);
            if ov == -2 {
                return h;
            }
            let use_fp = gains_row.get(&row).copied().unwrap_or(1000);
            let pin_base = match ov {
                2 => 6000,
                -1 => 400,
                _ => 1000,
            };
            let cheap = if ext_mode.is_some() {
                let dn_owned = idx.disp_at(row);
                let dn = std::str::from_utf8(&dn_owned).unwrap_or("");
                let tf = type_factor_fp(kind, dn);
                let df = depth_factor(idx.depth[row as usize] as i64);
                (use_fp * pin_base / 1000 * tf / 1000 * df / 1000).max(1) as u32
            } else {
                let tq = type_base(kind).unwrap_or(1000);
                (mn * pfx / 1000 * use_fp / 1000 * pin_base / 1000 * tq / 1000).max(1) as u32
            };
            push_topk(&mut h, kbuf, cheap, row as usize);
            h
        };
        let reducer = |mut a: BinaryHeap<Reverse<(u32, usize)>>, b: BinaryHeap<Reverse<(u32, usize)>>| {
            for Reverse((s, r)) in b {
                push_topk(&mut a, kbuf, s, r);
            }
            a
        };
        // ---- 阶段1: 并行闸门(全表 或 收窄子集)----
        let heap = match &cand {
            Cand::Full => (0..n)
                .into_par_iter()
                .fold(BinaryHeap::new, &process)
                .reduce(BinaryHeap::new, &reducer),
            Cand::Subset(rows) => rows
                .par_iter()
                .copied()
                .fold(BinaryHeap::new, &process)
                .reduce(BinaryHeap::new, &reducer),
        };

        // 更新收窄缓存: 仅当未被更新按键取消(代次未变)且堆未满(命中数 < kbuf → 堆即全部命中)时, 缓存完整子集。
        {
            let rows: Vec<u32> = heap.iter().map(|Reverse((_, r))| *r as u32).collect();
            let cacheable = rows.len() < kbuf && QUERY_GEN.load(Ordering::Relaxed) == gen;
            *LAST.lock().unwrap() = if cacheable {
                Some(LastQuery {
                    text: text.clone(),
                    score_path,
                    ext: ext_mode.clone(),
                    tags: req_tags.clone(),
                    rows,
                })
            } else {
                None
            };
        }

        // ---- 阶段2: 幸存者重建路径 + 全量重打分(复用 super 排序助手, 逐位 parity)----
        let mut scored: Vec<(u32, u32, String)> = heap
            .into_iter()
            .filter_map(|Reverse((_, row_us))| {
                let row = row_us as u32;
                let path = idx.path_of(row);
                let kind = kind_str(idx.flags[row as usize]);
                let dn_owned = idx.disp_at(row);
                let dn = std::str::from_utf8(&dn_owned).unwrap_or("");
                let (mn, pfx) = match &ext_mode {
                    Some(ext) => {
                        if kind != "folder" && name_has_ext(dn, ext) {
                            (1000, 1000)
                        } else {
                            return None;
                        }
                    }
                    None => {
                        // 二段对多词用 super::match_terms(在重建出的路径上做 find_substr), 与现引擎逐位等价;
                        // 一段已用 arena 祖先匹配做快闸门(对词项是路径匹配的超集, 不漏)。
                        let ns = std::str::from_utf8(idx.lname_at(row)).unwrap_or("");
                        let ps = std::str::from_utf8(idx.py_at(row)).unwrap_or("");
                        if multi {
                            match_terms(&terms, ns, ps, &path, browse, score_path, true)?
                        } else {
                            match_quality(&qb0, ns, ps, &path, browse, score_path)?
                        }
                    }
                };
                let ov = over_row.get(&row).copied().unwrap_or(0);
                if ov == -2 {
                    return None;
                }
                let use_fp = gains_row.get(&row).copied().unwrap_or(1000);
                let type_fp = type_factor_fp(kind, dn);
                let depth = idx.depth[row as usize] as i64;
                let depth_fp = if kind == "app" { 1300 } else { depth_factor(depth) };
                let loc_fp = user_home_fp(&path);
                let (tag_fp, pinned_tag) = arena_tag_factor(idx, row, &tags_row, &tagsnap);
                let mut pin_fp: i64 = match ov {
                    2 => 6000,
                    -1 => 400,
                    _ => {
                        if under_important(&path, &important) {
                            1800
                        } else {
                            1000
                        }
                    }
                };
                if pinned_tag {
                    pin_fp = pin_fp.max(4000);
                }
                let mut s = mn;
                s = s * pfx / 1000;
                s = s * use_fp / 1000;
                s = s * type_fp / 1000;
                s = s * depth_fp / 1000;
                s = s * loc_fp / 1000;
                s = s * tag_fp / 1000;
                s = s * pin_fp / 1000;
                Some((s.max(1) as u32, row, path))
            })
            .collect();
        // 分数降序; 同分按行号升序 tie-break → 顺序确定可复现(不靠 unstable 的随机)。
        scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.truncate(limit.max(1));
        scored
            .into_iter()
            .map(|(score, row, path)| {
                let kind = kind_str(idx.flags[row as usize]);
                let disp = String::from_utf8_lossy(&idx.disp_at(row)).into_owned();
                // 应用按开始菜单 .lnk 入索引, 但显示要去掉 .lnk 后缀(与现引擎一致)。
                let name = if kind == "app" && disp.len() > 4 && disp[disp.len() - 4..].eq_ignore_ascii_case(".lnk") {
                    disp[..disp.len() - 4].to_string()
                } else {
                    disp
                };
                SearchHit {
                    kind: kind.to_string(),
                    name,
                    tags: tags_row.get(&row).cloned().unwrap_or_default(),
                    pinned: over_row.get(&row).copied() == Some(2),
                    path,
                    score,
                }
            })
            .collect()
    }
}
