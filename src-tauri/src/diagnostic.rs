//! 全量诊断快照 (Ctrl+Alt+D 触发) —— 给"反馈渠道"用: 一键截下 poof 当前所有可见界面 + 时间 + 关键状态,
//! 落 ~/Pictures/overlay-shell-diagnostics/diag-<ns>/{screen.png, win-<label>.png, report.md}, 并把 report.md
//! 的 [[链接]] 复制到剪贴板(发给 AI / 贴进笔记即用)。前端状态(笔记数/面板/JS 堆)由前端传 state_json。
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use std::path::{Path, PathBuf};
use tauri::Manager;

// 快速 PNG: 低压缩 + 不做自适应滤波。整屏 2560×1440 用默认压缩要近 1 秒(诊断"慢"的根因);
// 这里求快不求小 —— 文件大几倍但编码快好几倍, 诊断快照本就只为看一眼。
fn save_png_fast(path: &Path, rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("建PNG失败: {e}"))?;
    // Sub 滤波几乎不花 CPU, 却把截图的大片平坦区变成 0 → deflate 又快又小(比 NoFilter 文件小数倍)。
    let enc = PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        CompressionType::Fast,
        FilterType::Sub,
    );
    enc.write_image(rgba, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| format!("编码PNG失败: {e}"))
}


fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn diag_root() -> PathBuf {
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("overlay-shell-diagnostics")
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
    let notes = count_ext(&crate::notesstore::root().join("docs"), "ydoc");
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
    save_png_fast(&screen_path, full.as_raw(), mw, mh)?;

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
                // 接近整屏的覆盖层(poof 主窗就是全屏的)和 screen.png 几乎一模一样, 再编码一张大图纯属重复 ——
                // 这是"慢"的另一半。只为真正局部的小窗口(浮层/面板)单独裁图, 整屏级的直接引用 screen.png。
                let area_ratio = (cw as f64 * ch as f64) / (mw as f64 * mh as f64);
                if area_ratio < 0.9 {
                    let sub = image::imageops::crop_imm(&full, ox, oy, cw, ch).to_image();
                    let fname = format!("win-{label}.png");
                    if save_png_fast(&dir.join(&fname), sub.as_raw(), sub.width(), sub.height()).is_ok() {
                        win_imgs.push((label.clone(), fname));
                    }
                }
            }
        }
    }

    // 3) 报告
    let mut md = String::new();
    md.push_str("# 捕获 · overlay-shell 全量诊断快照\n\n");
    md.push_str(&format!("- 时间: {when}\n"));
    md.push_str(&format!("- 主屏: {mw}×{mh}\n"));
    md.push_str(&format!("- 可见窗口截图: {}\n", win_imgs.len()));
    // 全量状态(含整页 DOM)单独落 state.json; 报告里内联"精简版"(把巨大的 dom 换成计数指针)便于人读。
    let state_path = dir.join("state.json");
    let _ = std::fs::write(&state_path, state_json.as_bytes());
    let report_state = match serde_json::from_str::<serde_json::Value>(&state_json) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                if let Some(dom) = obj.get("dom") {
                    let cnt = dom.get("count").and_then(|c| c.as_u64()).unwrap_or(0);
                    let trunc = dom.get("truncated").and_then(|c| c.as_bool()).unwrap_or(false);
                    obj.insert(
                        "dom".into(),
                        serde_json::json!(format!(
                            "<全量 DOM {cnt} 个元素{} → 见同目录 state.json>",
                            if trunc { "(已截断)" } else { "" }
                        )),
                    );
                }
            }
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| state_json.clone())
        }
        Err(_) => state_json.clone(),
    };
    md.push_str("\n## 关键状态(前端) · 全量见 [state.json](state.json)\n\n```json\n");
    md.push_str(&report_state);
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

    // 5) 弹个小提示(底部居中, 不抢焦点、无声) —— poof 藏着也能看见"拍到了"。✓ 图标由提示窗自带。
    crate::show_toast(app, "已存诊断快照 · 链接已复制");

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

// 前端回传的"全量状态"暂存槽。热键路径先问前端要一次, 拿到就并进报告。
static PENDING_DIAG_STATE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 前端应答 collect-diag-state 时, 把 gatherDiagState 的 JSON 回传到这里。
#[tauri::command]
pub fn report_diag_state(json: String) {
    if let Ok(mut g) = PENDING_DIAG_STATE.lock() {
        *g = Some(json);
    }
}

/// 热键路径问前端要一次全量状态: 发 collect-diag-state, 等最多 ~700ms。拿到就用(打开的笔记/选区/JS堆…),
/// 拿不到(前端真藏着/卡死)就返回 None → 退回纯 Rust 状态。等待在后台线程里, 不挡钩子/累加器。
fn request_frontend_state(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(mut g) = PENDING_DIAG_STATE.lock() {
        *g = None;
    }
    // 用 eval 直接调 main 里的 __reportDiagState(事件 emit 送不到这个 listen, 和小提示窗一个坑)。
    // 回主线程做 —— 后台线程调 webview 方法不生效。
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::Manager;
        if let Some(m) = app2.get_webview_window("main") {
            let _ = m.eval("window.__reportDiagState && window.__reportDiagState()");
        }
    });
    // 全量 DOM 抓取要点时间, 给到 ~3s; 前端真藏着/卡死才会走到超时退回。
    for _ in 0..300 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if let Ok(g) = PENDING_DIAG_STATE.lock() {
            if let Some(s) = g.as_ref() {
                return Some(s.clone());
            }
        }
    }
    crate::log_line("[diag] 前端 ~3s 没回传 → 退回纯 Rust 状态(前端藏着/卡了)");
    None
}

/// 热键(Ctrl+Alt+S)路径: 先问前端要全量状态(打开的笔记/选中的块等), 拿不到再退回纯 Rust。
/// 这样热键拍的快照也是"全量信息", 而不只是几个磁盘数出来的数字。poof 真藏着/卡死时仍能出快照。
pub fn do_diagnostic(app: &tauri::AppHandle) -> Option<DiagResult> {
    let state = request_frontend_state(app).unwrap_or_default();
    match capture_diag(app, state) {
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
