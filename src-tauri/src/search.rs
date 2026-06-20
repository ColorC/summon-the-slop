// In-process search: files + folders + apps + executables, walked with the `ignore`
// crate (no child process, EDR-friendly), ranked with nucleo-matcher. Real Windows
// file icons via systemicons (cached). Index built lazily on first query.
use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub kind: String, // "app" | "folder" | "exe" | "file"
    pub name: String,
    pub path: String,
    pub score: u32,
}

// (kind, name, path)
static INDEX: Mutex<Option<Vec<(String, String, String)>>> = Mutex::new(None);

fn user_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("USERPROFILE") {
        let base = PathBuf::from(p);
        for sub in ["Desktop", "Documents", "Downloads"] {
            v.push(base.join(sub));
        }
    }
    v.push(PathBuf::from("E:/WindowsWorkspace"));
    v.into_iter().filter(|p| p.exists()).collect()
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

// (name, path, is_dir)
fn collect(roots: &[PathBuf], max_depth: usize, cap: usize) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    for root in roots {
        let mut wb = WalkBuilder::new(root);
        wb.max_depth(Some(max_depth))
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false);
        for dent in wb.build().flatten() {
            if out.len() >= cap {
                break;
            }
            let p = dent.path();
            if p == root.as_path() {
                continue;
            }
            let is_dir = p.is_dir();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                out.push((name.to_string(), p.to_string_lossy().to_string(), is_dir));
            }
        }
    }
    out
}

fn build_index() -> Vec<(String, String, String)> {
    let mut idx = Vec::new();
    // apps = Start Menu .lnk shortcuts
    for (name, path, is_dir) in collect(&app_roots(), 5, 6000) {
        let lower = name.to_lowercase();
        if is_dir || !lower.ends_with(".lnk") {
            continue;
        }
        let display = name[..name.len() - 4].to_string();
        idx.push(("app".to_string(), display, path));
    }
    // user roots: folders + files (incl. executables)
    for (name, path, is_dir) in collect(&user_roots(), 6, 50000) {
        let kind = if is_dir {
            "folder"
        } else if name.to_lowercase().ends_with(".exe") {
            "exe"
        } else {
            "file"
        };
        idx.push((kind.to_string(), name, path));
    }
    idx
}

#[tauri::command]
pub fn search(query: String, limit: usize) -> Vec<SearchHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let mut guard = INDEX.lock().unwrap();
    if guard.is_none() {
        *guard = Some(build_index());
    }
    let index = guard.as_ref().unwrap();

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pat = Pattern::parse(q, CaseMatching::Ignore, Normalization::Smart);
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut buf: Vec<char> = Vec::new();
    for (kind, name, path) in index.iter() {
        buf.clear();
        if let Some(score) = pat.score(Utf32Str::new(name, &mut buf), &mut matcher) {
            // surface apps/folders/exes a bit above deep files
            let bonus = match kind.as_str() {
                "app" => 24,
                "exe" => 16,
                "folder" => 8,
                _ => 0,
            };
            hits.push(SearchHit {
                kind: kind.clone(),
                name: name.clone(),
                path: path.clone(),
                score: score + bonus,
            });
        }
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score));
    hits.truncate(limit);
    hits
}

#[tauri::command]
pub fn search_reindex() {
    *INDEX.lock().unwrap() = None;
}

/// Launch a file/folder/app with the OS default handler.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
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
