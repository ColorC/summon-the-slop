//! Recording ("录制") backend for the AI session-recording feature (P1).
//! One session = a subdir under %USERPROFILE%\Pictures\poof-recordings\<sid>\ holding
//! events.jsonl (one schema-envelope per line) + meta.json. Mirrors snap_cmd.rs file
//! management (path guard, timestamp naming, structured meta). Transport is Tauri IPC —
//! the recording webview is poof's own app:// surface, so no HTTP collector is needed here
//! (that arrives with P2/P3 external pages + extensions).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Sessions root, beside poof-shots so the existing reveal/explorer habits hold.
fn recordings_dir() -> PathBuf {
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("poof-recordings")
}

/// Reject any path that isn't under the recordings root (no traversal).
fn ensure_in_recordings(path: &str) -> Result<PathBuf, String> {
    let cp = std::fs::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    let cd = std::fs::canonicalize(recordings_dir()).map_err(|e| e.to_string())?;
    if cp.starts_with(&cd) {
        Ok(cp)
    } else {
        Err("path is outside the poof-recordings folder".into())
    }
}

/// The one active session (managed in lib.rs via `.manage(RecState::default())`).
#[derive(Default)]
pub struct RecState {
    sid: Mutex<Option<String>>,
    seq: AtomicU64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    sid: String,
    start_ms: u64,
    stop_ms: Option<u64>,
    surfaces: Vec<String>,
    title: String,
}

#[derive(serde::Serialize)]
pub struct SessionInfo {
    pub session_path: String,
    pub sid: String,
    pub start_ms: u64,
    pub stop_ms: Option<u64>,
    pub title: String,
    pub event_lines: u64,
}

/// Atomic meta write: write to a temp file then rename, so a concurrent list_sessions can
/// never read a half-written meta.json (NTFS rename is atomic).
fn write_atomic_meta(path: &Path, meta: &Meta) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Stamp stop_ms on a session's meta.json (best-effort).
pub fn stamp_stop(sid: &str) {
    let meta_path = recordings_dir().join(sid).join("meta.json");
    if let Ok(text) = std::fs::read_to_string(&meta_path) {
        if let Ok(mut meta) = serde_json::from_str::<Meta>(&text) {
            meta.stop_ms = Some(now_ms());
            let _ = write_atomic_meta(&meta_path, &meta);
        }
    }
}

/// Cleanly close whatever session is active (used by record_stop AND the window-close
/// handler in lib.rs, so closing the record window never orphans an in-progress session).
pub fn stop_active(state: &RecState) {
    if let Ok(mut g) = state.sid.lock() {
        if let Some(sid) = g.take() {
            stamp_stop(&sid);
        }
    }
}

// ── Transport-agnostic session fs ops (shared by the Tauri IPC commands AND the P2 HTTP
//    collector in http_rec.rs, so there is ONE copy of the store logic) ─────────────────

/// A sid is attacker-influenced over HTTP — only allow the rec-<alnum> shape (no separators,
/// so no path traversal) before touching the filesystem with it.
fn sid_ok(sid: &str) -> bool {
    sid.len() > 4 && sid.starts_with("rec-") && sid[4..].bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Create a new session dir + seed empty events.jsonl + meta.json; return the sid.
pub fn init_session(title: &str, surface: &str) -> Result<String, String> {
    let sid = format!("rec-{}", now_ns());
    let dir = recordings_dir().join(&sid);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("events.jsonl"), b"").map_err(|e| e.to_string())?;
    let meta = Meta {
        sid: sid.clone(),
        start_ms: now_ms(),
        stop_ms: None,
        surfaces: vec![surface.to_string()],
        title: title.to_string(),
    };
    write_atomic_meta(&dir.join("meta.json"), &meta)?;
    Ok(sid)
}

/// Lazily ensure a session dir + meta exists (crash-safety: an extension event that arrives
/// without a prior /rec/start still lands instead of erroring).
pub fn ensure_session(sid: &str, surface: &str) -> Result<(), String> {
    if !sid_ok(sid) {
        return Err("bad sid".into());
    }
    let dir = recordings_dir().join(sid);
    if dir.join("meta.json").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !dir.join("events.jsonl").exists() {
        std::fs::write(dir.join("events.jsonl"), b"").map_err(|e| e.to_string())?;
    }
    let meta = Meta {
        sid: sid.to_string(),
        start_ms: now_ms(),
        stop_ms: None,
        surfaces: vec![surface.to_string()],
        title: format!("{surface} 网页录制"),
    };
    write_atomic_meta(&dir.join("meta.json"), &meta)
}

/// Append a batch of schema-envelope events to a session's events.jsonl, verbatim
/// (p.ev raw rrweb + the client-set seq are never rewritten).
pub fn append_events(sid: &str, batch: &[serde_json::Value]) -> Result<(), String> {
    if !sid_ok(sid) {
        return Err("bad sid".into());
    }
    let path = recordings_dir().join(sid).join("events.jsonl");
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    for ev in batch {
        buf.push_str(&serde_json::to_string(ev).map_err(|e| e.to_string())?);
        buf.push('\n');
    }
    f.write_all(buf.as_bytes()).map_err(|e| e.to_string())
}

/// Begin a session (poof IPC surface): create it + arm RecState. Any session still marked
/// active is stamped-stopped first (re-summon / orphan guard).
#[tauri::command]
pub fn record_start(state: tauri::State<RecState>, title: Option<String>) -> Result<String, String> {
    let sid = init_session(&title.unwrap_or_else(|| "未命名录制".into()), "poof")?;
    let mut g = state.sid.lock().map_err(|e| e.to_string())?;
    if let Some(old) = g.take() {
        stamp_stop(&old);
    }
    *g = Some(sid.clone());
    state.seq.store(0, Ordering::SeqCst);
    Ok(sid)
}

/// Append to the active poof session. Holds the session lock across the append so concurrent
/// flushes can't interleave half-lines.
#[tauri::command]
pub fn record_event(state: tauri::State<RecState>, batch: Vec<serde_json::Value>) -> Result<(), String> {
    let guard = state.sid.lock().map_err(|e| e.to_string())?;
    let sid = guard.as_ref().ok_or("no active recording session")?;
    append_events(sid, &batch)?;
    state.seq.fetch_add(batch.len() as u64, Ordering::SeqCst);
    Ok(())
}

/// End the active session: stamp stop_ms in meta.json, clear state.
#[tauri::command]
pub fn record_stop(state: tauri::State<RecState>) -> Result<(), String> {
    stop_active(state.inner());
    Ok(())
}

/// All recorded sessions, newest first.
#[tauri::command]
pub fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let dir = recordings_dir();
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out), // no folder yet = empty
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let meta: Meta = match std::fs::read_to_string(p.join("meta.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
        {
            Some(m) => m,
            None => continue,
        };
        let event_lines = std::fs::read_to_string(p.join("events.jsonl"))
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u64)
            .unwrap_or(0);
        out.push(SessionInfo {
            session_path: p.to_string_lossy().into_owned(),
            sid: meta.sid,
            start_ms: meta.start_ms,
            stop_ms: meta.stop_ms,
            title: meta.title,
            event_lines,
        });
    }
    out.sort_by(|a, b| b.start_ms.cmp(&a.start_ms));
    Ok(out)
}

/// The raw events.jsonl of one session (replay parses + filters client-side).
#[tauri::command]
pub fn read_session(session_path: String) -> Result<String, String> {
    let dir = ensure_in_recordings(&session_path)?;
    std::fs::read_to_string(dir.join("events.jsonl")).map_err(|e| e.to_string())
}
