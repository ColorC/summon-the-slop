// In-process search: files + folders + apps + executables, walked with the `ignore`
// crate (no child process, EDR-friendly), ranked with nucleo-matcher. Real Windows
// file icons via systemicons (cached). Index built lazily on first query.
use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub kind: String, // "app" | "folder" | "exe" | "file"
    pub name: String,
    pub path: String,
    pub score: u32,
}

// (kind, name, path, pinyin) — pinyin is non-empty only for CJK names (full + initials),
// so typing "ceshi" or "cs" finds 测试…
type Entry = (String, String, String, String);
static INDEX: Mutex<Option<Vec<Entry>>> = Mutex::new(None);
static BUILDING: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);

// All FIXED local drives (C:, D:, E:, …). Like Listary/Everything we do NOT avoid any user
// directory — we index whole volumes and let noise-pruning + ranking carry the weight.
// (Removable/USB/network drives are skipped: walking them would be slow / surprising.)
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

// Roots we INDEX (full walk): every fixed drive + any user-added paths. No hand-picked
// "only these folders" allow-list anymore — that allow-list is exactly what made me miss
// D:/P4/main/Excel/LineQuest.xlsm until I added it by hand.
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

// Roots we WATCH live (ReadDirectoryChangesW). Watching whole drives recursively would be a
// CPU/IO storm — Everything/Listary stay live via the NTFS USN journal, which needs admin
// (poof is deliberately non-elevated). So we live-watch only the dirs the user actually
// works in; the rest of every drive stays fresh via the periodic full re-walk.
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

// ---- usage frequency (most-used first) ----
fn usage_file() -> PathBuf {
    std::env::temp_dir().join("poof-usage.json")
}
fn load_usage() -> HashMap<String, u32> {
    std::fs::read_to_string(usage_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn bump_usage(path: &str) {
    let mut m = load_usage();
    *m.entry(path.to_string()).or_insert(0) += 1;
    if let Ok(s) = serde_json::to_string(&m) {
        let _ = std::fs::write(usage_file(), s);
    }
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

// (name, path, is_dir) — PARALLEL walk (all cores) so the cold build is ~seconds, not
// tens of seconds. Per-root cap (not shared) + the root folder itself is indexed.
fn collect(roots: &[PathBuf], max_depth: usize, per_root_cap: usize) -> Vec<(String, String, bool)> {
    let out: Mutex<Vec<(String, String, bool)>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
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
    // whole fixed drives: deep + high PER-DRIVE cap (noise pruned). The cap is a runaway
    // safety valve, not an allow-list — real work files sit shallow and get caught early.
    for (name, path, is_dir) in collect(&index_roots(), 16, 1_500_000) {
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

// full fresh walk → persist → swap in. The query-time refresh core.
pub fn warm_index() {
    let idx = build_index();
    persist(&idx);
    *INDEX.lock().unwrap() = Some(idx);
}

// startup: load the persisted index instantly (search works on the 1st keystroke),
// then do a full fresh walk in the background and swap it in.
pub fn warm_start() {
    if INDEX.lock().unwrap().is_none() {
        if let Some(idx) = load_persisted() {
            *INDEX.lock().unwrap() = Some(idx);
        }
    }
    warm_index();
    start_watchers();
    start_periodic_refresh();
}

// Whole drives can't be cheaply watched (no admin → no USN journal), so areas outside the
// live-watched work dirs are kept fresh by a full re-walk every 30 min (background, parallel,
// persisted). Guarded by BUILDING so it never overlaps a manual reindex.
pub fn start_periodic_refresh() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(1800));
        if !BUILDING.swap(true, Ordering::SeqCst) {
            warm_index();
            BUILDING.store(false, Ordering::SeqCst);
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
    let mut guard = INDEX.lock().unwrap();
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
            let pos = idx.iter().position(|(_, _, p, _)| p == &ps);
            let exists = path.exists();
            if exists && pos.is_none() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    let is_dir = path.is_dir();
                    idx.push((
                        kind_for(name, is_dir).to_string(),
                        name.to_string(),
                        ps,
                        pinyin_of(name),
                    ));
                    changed = true;
                }
            } else if !exists {
                if let Some(p) = pos {
                    idx.swap_remove(p);
                    changed = true;
                }
            }
        }
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
                let snap = INDEX.lock().unwrap().clone();
                if let Some(idx) = snap {
                    persist(&idx);
                }
                last_persist = Instant::now();
            }
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub fn search(query: String, limit: usize) -> Vec<SearchHit> {
    let q = query.trim();
    if q.is_empty() {
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
    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().unwrap();

    let pat = Pattern::parse(q, CaseMatching::Ignore, Normalization::Smart);
    let usage = load_usage();
    // only score the (long) full path when the query looks path-shaped / multi-keyword;
    // a plain single word matches against the name only — far fewer scores → fast.
    let score_path = q.contains('/') || q.contains('\\') || q.contains(' ');

    // parallel scoring across the (200k+) index with a per-thread Matcher + scratch buf
    let mut hits: Vec<SearchHit> = index
        .par_iter()
        .fold(
            || {
                (
                    Matcher::new(Config::DEFAULT),
                    Vec::<char>::new(),
                    Vec::<SearchHit>::new(),
                )
            },
            |(mut matcher, mut buf, mut acc), (kind, name, path, py)| {
                buf.clear();
                let sn = pat.score(Utf32Str::new(name, &mut buf), &mut matcher);
                // pinyin match (typing "ceshi"/"cs" finds 测试…) counts as a name match
                let spy = if !py.is_empty() {
                    buf.clear();
                    pat.score(Utf32Str::new(py, &mut buf), &mut matcher)
                } else {
                    None
                };
                let name_score = match (sn, spy) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                let sp = if score_path {
                    buf.clear();
                    pat.score(Utf32Str::new(path, &mut buf), &mut matcher)
                } else {
                    None
                };
                // prefer a name/pinyin match; fall back to a lower-weighted full-path match
                let base = match (name_score, sp) {
                    (Some(n), Some(p)) => n.max(p / 2),
                    (Some(n), None) => n,
                    (None, Some(p)) => p / 3,
                    (None, None) => return (matcher, buf, acc),
                };
                let kind_bonus = match kind.as_str() {
                    "app" => 24,
                    "exe" => 16,
                    "folder" => 8,
                    _ => 0,
                };
                let freq_bonus = usage.get(path).map(|c| (*c * 10).min(150)).unwrap_or(0);
                acc.push(SearchHit {
                    kind: kind.clone(),
                    name: name.clone(),
                    path: path.clone(),
                    score: base + kind_bonus + freq_bonus,
                });
                (matcher, buf, acc)
            },
        )
        .map(|(_, _, acc)| acc)
        .reduce(Vec::new, |mut a, mut b| {
            a.append(&mut b);
            a
        });
    hits.sort_by(|a, b| b.score.cmp(&a.score));
    hits.truncate(limit);
    hits
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
        std::process::Command::new("explorer")
            .args(["/select,", &path])
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
