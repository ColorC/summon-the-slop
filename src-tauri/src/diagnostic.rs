//! 全量诊断快照 (Ctrl+Alt+D 触发) —— 给"反馈渠道"用: 一键截下 poof 当前所有可见界面 + 时间 + 关键状态,
//! 落 ~/Pictures/poof-diagnostics/diag-<ns>/{screen.png, win-<label>.png, report.md}, 并把 report.md
//! 的 [[链接]] 复制到剪贴板(发给 AI / 贴进笔记即用)。前端状态(笔记数/面板/JS 堆)由前端传 state_json。
use std::path::{Path, PathBuf};
use tauri::Manager;

fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn diag_root() -> PathBuf {
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("poof-diagnostics")
}

fn strip_unc(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

#[derive(serde::Serialize)]
pub struct DiagResult {
    pub dir: String,
    pub md: String,
    pub screenshot: String,
    pub link: String,
    pub windows: usize,
}

#[cfg(windows)]
fn local_time_str() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    unsafe {
        let mut st: SYSTEMTIME = std::mem::zeroed();
        GetLocalTime(&mut st);
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
        )
    }
}
#[cfg(not(windows))]
fn local_time_str() -> String {
    String::new()
}

// 纯 Rust 拿到的状态(热键路径用, 不依赖前端)。前端点按钮的路径会传更全的 state_json。
fn rust_state_summary() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let count_ext = |dir: &Path, ext: &str| -> usize {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some(ext))
                    .count()
            })
            .unwrap_or(0)
    };
    let notes = count_ext(Path::new("E:\\WindowsWorkspace\\poof-notes\\docs"), "ydoc");
    let clips = std::fs::read_to_string(Path::new(&home).join(".poof").join("clipboard").join("index.jsonl"))
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0);
    let diags = std::fs::read_dir(diag_root())
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    format!(
        "{{\n  \"来源\": \"Rust(热键)\",\n  \"笔记ydoc数\": {notes},\n  \"剪贴板历史条目\": {clips},\n  \"已存诊断数\": {diags}\n}}"
    )
}

/// 核心: 截屏 + 每个可见 poof 窗口区域 + 写报告 + 复制链接。纯 Rust, 不依赖前端 → poof 隐藏/卡住也能跑。
/// state_json 空 = 热键路径(用 Rust 状态); 非空 = 前端按钮传来的更全状态。
pub fn capture_diag(app: &tauri::AppHandle, state_json: String) -> Result<DiagResult, String> {
    let when = local_time_str();
    let state_json = if state_json.trim().is_empty() {
        rust_state_summary()
    } else {
        state_json
    };
    let dir = diag_root().join(format!("diag-{}", now_ns()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("建诊断目录失败: {e}"))?;

    // 1) 整屏(GDI 抓的是合成后画面, 含可见的 poof 透明覆盖层) → RGBA
    let (rgba, mw, mh, mx, my, _scale) = crate::capture::capture_primary_raw()?;
    let full = image::RgbaImage::from_raw(mw, mh, rgba).ok_or("RGBA→image 失败")?;
    let screen_path = dir.join("screen.png");
    full.save(&screen_path).map_err(|e| format!("存整屏失败: {e}"))?;

    // 2) 每个可见 poof 窗口: 从整屏裁出它的区域 + 记元数据
    let mut win_lines: Vec<String> = Vec::new();
    let mut win_imgs: Vec<(String, String)> = Vec::new();
    for (label, w) in app.webview_windows() {
        let visible = w.is_visible().unwrap_or(false);
        let pos = w.outer_position().ok();
        let size = w.outer_size().ok();
        let (px, py) = pos.map(|p| (p.x, p.y)).unwrap_or((0, 0));
        let (sw, sh) = size.map(|s| (s.width, s.height)).unwrap_or((0, 0));
        win_lines.push(format!(
            "- `{label}`: visible={visible} pos=({px},{py}) size={sw}×{sh}"
        ));
        if visible && sw > 0 && sh > 0 {
            let ox = (px - mx).max(0) as u32;
            let oy = (py - my).max(0) as u32;
            if ox < mw && oy < mh {
                let cw = sw.min(mw - ox);
                let ch = sh.min(mh - oy);
                let sub = image::imageops::crop_imm(&full, ox, oy, cw, ch).to_image();
                let fname = format!("win-{label}.png");
                if sub.save(dir.join(&fname)).is_ok() {
                    win_imgs.push((label.clone(), fname));
                }
            }
        }
    }

    // 3) 报告
    let mut md = String::new();
    md.push_str("# 捕获 · poof 全量诊断快照\n\n");
    md.push_str(&format!("- 时间: {when}\n"));
    md.push_str(&format!("- 主屏: {mw}×{mh}\n"));
    md.push_str(&format!("- 可见窗口截图: {}\n", win_imgs.len()));
    md.push_str("\n## 关键状态(前端)\n\n```json\n");
    md.push_str(&state_json);
    md.push_str("\n```\n\n## 窗口\n\n");
    for l in &win_lines {
        md.push_str(l);
        md.push('\n');
    }
    md.push_str("\n## 截图\n\n**整屏**\n\n![整屏](screen.png)\n\n");
    for (label, file) in &win_imgs {
        md.push_str(&format!("**窗口 {label}**\n\n![{label}]({file})\n\n"));
    }
    let md_path = dir.join("report.md");
    std::fs::write(&md_path, md.as_bytes()).map_err(|e| format!("写报告失败: {e}"))?;

    // 4) 复制 [[报告链接]]
    let link = format!("[[{}]]", strip_unc(&md_path));
    let _ = arboard::Clipboard::new().and_then(|mut c| c.set_text(link.clone()));

    Ok(DiagResult {
        dir: strip_unc(&dir),
        md: strip_unc(&md_path),
        screenshot: strip_unc(&screen_path),
        link,
        windows: win_imgs.len(),
    })
}

/// 前端按钮路径: 带上前端状态(笔记/JS堆等)。
#[tauri::command]
pub async fn diagnostic_snapshot(
    app: tauri::AppHandle,
    state_json: String,
) -> Result<DiagResult, String> {
    capture_diag(&app, state_json)
}

/// 热键(Ctrl+Alt+S)路径: 纯 Rust 跑, 不经前端 → poof 隐藏/卡死也能出快照。失败返回 None。
pub fn do_diagnostic(app: &tauri::AppHandle) -> Option<DiagResult> {
    match capture_diag(app, String::new()) {
        Ok(r) => Some(r),
        Err(e) => {
            crate::log_line(&format!("diagnostic_snapshot 失败: {e}"));
            None
        }
    }
}

#[derive(serde::Serialize)]
pub struct DiagInfo {
    pub dir: String,
    pub name: String,
    pub ts_ms: u64,
    pub md: Option<String>,
    pub screenshot: Option<String>,
}

/// 历史诊断快照(每个 diag-<ns> 目录一条), 新的在前。给内容管理界面列。
#[tauri::command]
pub fn list_diagnostics() -> Result<Vec<DiagInfo>, String> {
    let root = diag_root();
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&root) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let ts_ms = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let md = p.join("report.md");
        let png = p.join("screen.png");
        out.push(DiagInfo {
            dir: strip_unc(&p),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ts_ms,
            md: if md.exists() { Some(strip_unc(&md)) } else { None },
            screenshot: if png.exists() { Some(strip_unc(&png)) } else { None },
        });
    }
    out.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(out)
}

#[tauri::command]
pub fn delete_diagnostic(dir: String) -> Result<(), String> {
    let cp = std::fs::canonicalize(Path::new(&dir)).map_err(|e| e.to_string())?;
    let cr = std::fs::canonicalize(diag_root()).map_err(|e| e.to_string())?;
    if !cp.starts_with(&cr) {
        return Err("不在 diagnostics 目录内".into());
    }
    std::fs::remove_dir_all(cp).map_err(|e| e.to_string())
}
