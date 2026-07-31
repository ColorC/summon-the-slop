// 自定义文件标签 —— path → tags, 落 %LOCALAPPDATA%\overlay-shell\tags.json(不用 %TEMP%, 不被清)。
// 进程内 Arc 缓存; search() 取 scoring_snapshot() 零 IO。与 notes 的 localStorage 标签独立(键空间
// 不同: 这里是 path, notes 是 docId), 但前端复用同一套 chip 视觉。定义(TagDef: 名/色/组/置顶)与
// 赋予(PathTags)解耦。详见 docs/file-tagging-system.md。
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// 标签定义: 名(=id, 大小写敏感保存但匹配不敏感)/色/组/置顶。
#[derive(Serialize, Deserialize, Clone)]
pub struct TagDef {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub pin: bool,
    #[serde(default)]
    pub created: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TagData {
    #[serde(default)]
    defs: HashMap<String, TagDef>, // name -> def
    #[serde(default)]
    paths: HashMap<String, Vec<String>>, // path -> tag 名列表
    #[serde(default)]
    orphans: HashMap<String, u64>, // path -> 首次发现缺失的 unix secs(孤儿宽限)
    #[serde(default)]
    file_ids: HashMap<String, String>, // path -> 卷根|FileId(冗余救援键, best-effort)
}

// 自动分色板(新建标签按已用数取模分配; 可在管理面板改)。
const PALETTE: [&str; 10] = [
    "#6366f1", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6", "#14b8a6",
    "#f97316", "#84cc16",
];

static TAGS: Mutex<Option<Arc<TagData>>> = Mutex::new(None);
// scoring 快照缓存(仅标签变更时失效重建, 故 search() 不每键克隆整张表)。
static SNAP: Mutex<Option<Arc<TagSnapshot>>> = Mutex::new(None);

fn tags_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("overlay-shell")
}
fn tags_file() -> PathBuf {
    tags_dir().join("tags.json")
}
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_from_disk() -> TagData {
    std::fs::read_to_string(tags_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn cache() -> Arc<TagData> {
    let mut g = TAGS.lock().unwrap();
    if g.is_none() {
        *g = Some(Arc::new(load_from_disk()));
    }
    g.as_ref().unwrap().clone()
}
fn persist(d: &TagData) {
    let dir = tags_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string(d) {
        let tmp = dir.join("tags.json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, tags_file()); // atomic on NTFS
        }
    }
}
// 单锁内: 克隆当前 → 改 → 落盘 → 换新 Arc, 并失效 scoring 快照。
fn update(f: impl FnOnce(&mut TagData)) {
    let mut g = TAGS.lock().unwrap();
    let mut d = match g.take() {
        Some(a) => (*a).clone(),
        None => load_from_disk(),
    };
    f(&mut d);
    persist(&d);
    *g = Some(Arc::new(d));
    drop(g);
    *SNAP.lock().unwrap() = None;
}

pub fn warm() {
    let _ = cache();
}

// ---- search() 打分用的快照 ----
pub struct TagSnapshot {
    pub paths: HashMap<String, Vec<String>>,
    pinned: HashSet<String>, // 置顶标签名(小写)
    pub has_any: bool,
}
impl TagSnapshot {
    #[inline]
    pub fn is_pinned(&self, tag: &str) -> bool {
        if self.pinned.is_empty() {
            return false;
        }
        self.pinned.contains(&tag.to_ascii_lowercase())
    }
}
pub fn scoring_snapshot() -> Arc<TagSnapshot> {
    {
        let g = SNAP.lock().unwrap();
        if let Some(s) = g.as_ref() {
            return s.clone();
        }
    }
    let d = cache();
    let pinned: HashSet<String> = d
        .defs
        .values()
        .filter(|v| v.pin)
        .map(|v| v.name.to_ascii_lowercase())
        .collect();
    let snap = Arc::new(TagSnapshot {
        paths: d.paths.clone(),
        pinned,
        has_any: !d.paths.is_empty(),
    });
    *SNAP.lock().unwrap() = Some(snap.clone());
    snap
}

// ---- watch 维护(由 search::apply_events 调用, 不持 INDEX 锁) ----
// 仅当批次里有「带标签」的删除路径时才写盘。
pub fn any_tagged(paths: &[String]) -> bool {
    let d = cache();
    paths.iter().any(|p| d.paths.contains_key(p))
}
fn basename(p: &str) -> Option<String> {
    std::path::Path::new(p)
        .file_name()
        .and_then(|x| x.to_str())
        .map(|s| s.to_string())
}
// 删除/移动对账: 同批次里出现同名新建 → 当作 rename, 键迁移; 否则标孤儿(宽限期内不删)。
pub fn reconcile(deleted: &[String], created: &[String]) {
    update(|d| {
        let now = now_secs();
        for del in deleted {
            if !d.paths.contains_key(del) {
                continue;
            }
            let moved = basename(del).and_then(|b| {
                created
                    .iter()
                    .find(|c| basename(c).as_deref() == Some(b.as_str()))
            });
            if let Some(newp) = moved {
                if let Some(tags) = d.paths.remove(del) {
                    d.paths.entry(newp.clone()).or_default().extend(tags);
                }
                if let Some(fid) = d.file_ids.remove(del) {
                    d.file_ids.insert(newp.clone(), fid);
                }
                d.orphans.remove(del);
            } else {
                d.orphans.entry(del.clone()).or_insert(now);
            }
        }
    });
}
// 周期清理(warm_index 调): 孤儿 path 若复现则消标记; 超宽限期才真删。
pub fn sweep_orphans(grace_days: u64) {
    let d = cache();
    if d.orphans.is_empty() {
        return;
    }
    let now = now_secs();
    let grace = grace_days * 86400;
    update(|d| {
        let keys: Vec<String> = d.orphans.keys().cloned().collect();
        let mut drop: Vec<String> = Vec::new();
        for p in keys {
            if std::path::Path::new(&p).exists() {
                d.orphans.remove(&p); // 复现 → 消除孤儿标记
                continue;
            }
            // FileId 救援: 文件移到别处(监视目录外)→ 解析出新路径, 标签整体跟随, 不删。
            if let Some(np) = d.file_ids.get(&p).and_then(|fid| crate::fileid::resolve(fid)) {
                if np != p && std::path::Path::new(&np).exists() {
                    if let Some(tags) = d.paths.remove(&p) {
                        d.paths.entry(np.clone()).or_default().extend(tags);
                    }
                    if let Some(fid) = d.file_ids.remove(&p) {
                        d.file_ids.insert(np, fid);
                    }
                    d.orphans.remove(&p);
                    continue;
                }
            }
            if let Some(t) = d.orphans.get(&p) {
                if now.saturating_sub(*t) > grace {
                    drop.push(p.clone());
                }
            }
        }
        for p in drop {
            d.orphans.remove(&p);
            d.paths.remove(&p);
            d.file_ids.remove(&p);
        }
    });
}

// ---- 命令 ----
#[tauri::command]
pub fn tag_add(path: String, tag: String) -> Vec<String> {
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return tags_for(path);
    }
    update(|d| {
        if !d.defs.keys().any(|k| k.eq_ignore_ascii_case(&tag)) {
            let color = PALETTE[d.defs.len() % PALETTE.len()].to_string();
            d.defs.insert(
                tag.clone(),
                TagDef {
                    name: tag.clone(),
                    color,
                    group: None,
                    pin: false,
                    created: now_secs(),
                },
            );
        }
        let v = d.paths.entry(path.clone()).or_default();
        if !v.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            v.push(tag.clone());
        }
        d.orphans.remove(&path);
        // 顺手记一份 FileId 作冗余救援键(文件移到监视目录外时, rename-follow 收不到, 靠它自愈)
        if !d.file_ids.contains_key(&path) {
            if let Some(fid) = crate::fileid::capture(&path) {
                d.file_ids.insert(path.clone(), fid);
            }
        }
    });
    tags_for(path)
}

#[tauri::command]
pub fn tag_remove(path: String, tag: String) -> Vec<String> {
    update(|d| {
        if let Some(v) = d.paths.get_mut(&path) {
            v.retain(|t| !t.eq_ignore_ascii_case(&tag));
            if v.is_empty() {
                d.paths.remove(&path);
                d.file_ids.remove(&path);
            }
        }
    });
    tags_for(path)
}

#[tauri::command]
pub fn tags_for(path: String) -> Vec<String> {
    cache().paths.get(&path).cloned().unwrap_or_default()
}

#[tauri::command]
pub fn tag_defs() -> Vec<TagDef> {
    let mut v: Vec<TagDef> = cache().defs.values().cloned().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

#[tauri::command]
pub fn tag_files(tag: String) -> Vec<String> {
    let mut v: Vec<String> = cache()
        .paths
        .iter()
        .filter(|(_, t)| t.iter().any(|x| x.eq_ignore_ascii_case(&tag)))
        .map(|(p, _)| p.clone())
        .collect();
    v.sort();
    v
}

#[tauri::command]
pub fn tag_set_def(name: String, color: Option<String>, group: Option<String>, pin: Option<bool>) {
    update(|d| {
        if let Some(def) = d.defs.get_mut(&name) {
            if let Some(c) = color {
                def.color = c;
            }
            if let Some(g) = group {
                def.group = if g.is_empty() { None } else { Some(g) };
            }
            if let Some(p) = pin {
                def.pin = p;
            }
        }
    });
}

#[tauri::command]
pub fn tag_rename(old: String, new: String) {
    let new = new.trim().to_string();
    if new.is_empty() || new.eq_ignore_ascii_case(&old) {
        return;
    }
    update(|d| {
        if let Some(mut def) = d.defs.remove(&old) {
            def.name = new.clone();
            d.defs.insert(new.clone(), def);
        }
        for v in d.paths.values_mut() {
            for t in v.iter_mut() {
                if t.eq_ignore_ascii_case(&old) {
                    *t = new.clone();
                }
            }
        }
    });
}

#[tauri::command]
pub fn tag_delete(name: String) {
    update(|d| {
        d.defs.remove(&name);
        for v in d.paths.values_mut() {
            v.retain(|t| !t.eq_ignore_ascii_case(&name));
        }
        d.paths.retain(|_, v| !v.is_empty());
        let keep: Vec<String> = d.paths.keys().cloned().collect();
        d.file_ids.retain(|p, _| keep.contains(p));
    });
}

// 孤儿视图(管理面板「孤儿」页): 当前已不存在的带标签 path。
#[tauri::command]
pub fn tag_orphans() -> Vec<String> {
    let mut v: Vec<String> = cache()
        .paths
        .keys()
        .filter(|p| !std::path::Path::new(p).exists())
        .cloned()
        .collect();
    v.sort();
    v
}

// 重新指认: 把某 path 的标签整体迁到新 path(管理面板孤儿页 / FileId 救援用)。
#[tauri::command]
pub fn tag_reassign(old_path: String, new_path: String) {
    update(|d| {
        if let Some(tags) = d.paths.remove(&old_path) {
            d.paths.entry(new_path.clone()).or_default().extend(tags);
        }
        if let Some(fid) = d.file_ids.remove(&old_path) {
            d.file_ids.insert(new_path.clone(), fid);
        } else if let Some(fid) = crate::fileid::capture(&new_path) {
            d.file_ids.insert(new_path.clone(), fid);
        }
        d.orphans.remove(&old_path);
    });
}

// 手动触发一次 FileId 救援(管理台孤儿页用): 扫所有孤儿, 能解析到新位置且存在的自动改打。返回 (旧, 新)。
#[tauri::command]
pub fn tag_rescue() -> Vec<(String, String)> {
    let d = cache();
    let mut moves: Vec<(String, String)> = Vec::new();
    for (p, fid) in d.file_ids.iter() {
        if std::path::Path::new(p).exists() {
            continue;
        }
        if let Some(np) = crate::fileid::resolve(fid) {
            if np != *p && std::path::Path::new(&np).exists() {
                moves.push((p.clone(), np));
            }
        }
    }
    for (old, new) in moves.iter() {
        tag_reassign(old.clone(), new.clone());
    }
    moves
}

// 仅供 --bench-search 集成测试: 直接注入 scoring 快照, 不读盘也不写盘(不碰用户真实 tags.json)。
#[doc(hidden)]
pub fn _bench_inject(paths: HashMap<String, Vec<String>>, pinned: Vec<String>) {
    let has_any = !paths.is_empty();
    let snap = Arc::new(TagSnapshot {
        paths,
        pinned: pinned.into_iter().map(|s| s.to_ascii_lowercase()).collect(),
        has_any,
    });
    *SNAP.lock().unwrap() = Some(snap);
}
