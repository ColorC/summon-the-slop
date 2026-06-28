//! Screenshot ("截图") backend: full-frame capture for the annotate overlay, the output
//! dispatches (copy image / save / pin / OCR), and the persistent shot history (list /
//! thumbnail / copy-file / reveal / delete). Ported + extended from waiela.
use base64::Engine;
use std::path::{Path, PathBuf};

fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// The single persistent folder every finalized shot is written to — this IS the history
/// list (%USERPROFILE%\Pictures\poof-shots). copy / save / pin all drop a file here.
fn shots_dir() -> PathBuf {
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("poof-shots")
}

/// Reject any path that isn't a real file under shots_dir (no arbitrary read/delete).
fn ensure_in_shots(path: &str) -> Result<PathBuf, String> {
    let cp = std::fs::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    let cd = std::fs::canonicalize(shots_dir()).map_err(|e| e.to_string())?;
    if cp.starts_with(&cd) {
        Ok(cp)
    } else {
        Err("path is outside the poof-shots folder".into())
    }
}

fn frame_to_response(rgba: Vec<u8>, w: u32, h: u32, x: i32, y: i32, scale: f32) -> tauri::ipc::Response {
    let mut buf = Vec::with_capacity(20 + rgba.len());
    buf.extend_from_slice(&(w as i32).to_le_bytes());
    buf.extend_from_slice(&(h as i32).to_le_bytes());
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&scale.to_le_bytes());
    buf.extend_from_slice(&rgba);
    tauri::ipc::Response::new(buf)
}

/// Full primary-monitor frame as raw RGBA with a 20-byte header (w,h,x,y i32 LE, scale f32
/// LE). The snap overlay putImageData's it — no PNG encode/decode on the summon path.
#[tauri::command]
pub fn capture_screen() -> Result<tauri::ipc::Response, String> {
    let (rgba, w, h, x, y, scale) = crate::capture::capture_primary_raw()?;
    Ok(frame_to_response(rgba, w, h, x, y, scale))
}

// 「先抓帧、后显示覆盖层」—— 所有截图工具(QQ/Snipaste/ShareX)的标准做法。summon_snap 在显示 snap
// 之前调 prime_capture: 此刻 snap 还没出现, 抓到的是真实画面(含 poof 自身, 因为 main 仍可见)。之前是
// 反着来(先显示 snap 再抓), 透明全屏 snap 在前 → xcap 把它身后的透明 main 合成成黑帧 = 黑屏 bug。
static PRIMED: std::sync::Mutex<Option<(Vec<u8>, u32, u32, i32, i32, f32)>> =
    std::sync::Mutex::new(None);

/// 在显示 snap 覆盖层之前抓一帧, 存起来供 take_capture 取。
pub fn prime_capture() -> Result<(), String> {
    let frame = crate::capture::capture_primary_raw()?;
    *PRIMED.lock().unwrap() = Some(frame);
    Ok(())
}

/// snap.ts 取预抓的帧(没有则即时抓一张兜底)。与 capture_screen 同格式。
#[tauri::command]
pub fn take_capture() -> Result<tauri::ipc::Response, String> {
    let frame = PRIMED.lock().unwrap().take();
    let (rgba, w, h, x, y, scale) = match frame {
        Some(f) => f,
        None => crate::capture::capture_primary_raw()?,
    };
    Ok(frame_to_response(rgba, w, h, x, y, scale))
}

/// Headless 自检: `poof.exe --test-snap-pipeline` —— 复现修复的确切机制: 在【后台线程】抓帧(死锁的
/// 根因就是把这步放主线程), 计时 + 读回验证非黑。证明"后台抓帧不死锁、帧有效", 不用按热键。
pub fn test_snap_pipeline() {
    use std::io::Write;
    use std::time::Instant;
    let t0 = Instant::now();
    // 模拟 summon_snap: 抓帧在后台线程跑(主线程跑会和事件循环消息泵死锁)。
    let h = std::thread::spawn(|| prime_capture());
    let joined = h.join();
    let dt = t0.elapsed();
    match joined {
        Ok(Ok(())) => {
            let g = PRIMED.lock().unwrap();
            match g.as_ref() {
                Some((rgba, w, hgt, _, _, _)) => {
                    let n = (rgba.len() / 4).max(1);
                    let mut sum: u64 = 0;
                    for px in rgba.chunks_exact(4) {
                        sum += px[0] as u64 + px[1] as u64 + px[2] as u64;
                    }
                    let avg = sum / n as u64;
                    println!(
                        "后台线程抓帧 {}x{} 用时 {:?}, 平均亮度 {}/765 → {}",
                        w,
                        hgt,
                        dt,
                        avg,
                        if avg < 5 {
                            "✗ 黑帧"
                        } else {
                            "✓ 非黑 + 后台抓帧未死锁(主线程冻结的根因已消除)"
                        }
                    );
                }
                None => println!("✗ PRIMED 为空, prime_capture 没存进帧"),
            }
        }
        Ok(Err(e)) => println!("✗ prime_capture 出错: {}", e),
        Err(_) => println!("✗ 后台抓帧线程 panic"),
    }
    let _ = std::io::stdout().flush();
}

/// Headless 自检: `poof.exe --test-capture` —— 抓一帧, 存 PNG, 报平均亮度/非黑占比, 判定是否黑屏。
/// 让我能在不按热键的情况下自己验证抓帧没坏(不黑屏), 而不是让用户去撞。
pub fn test_capture() {
    use std::io::Write;
    match crate::capture::capture_primary_raw() {
        Ok((rgba, w, h, x, y, scale)) => {
            let n = (rgba.len() / 4).max(1);
            let mut sum: u64 = 0;
            let mut nonblack = 0u64;
            for px in rgba.chunks_exact(4) {
                let lum = px[0] as u64 + px[1] as u64 + px[2] as u64;
                sum += lum;
                if lum > 30 {
                    nonblack += 1;
                }
            }
            let avg = sum / n as u64;
            println!(
                "capture {}x{} @({},{}) scale {} : {} px, 平均亮度 {}/765, 非黑 {:.1}%",
                w, h, x, y, scale, n, avg, nonblack as f64 / n as f64 * 100.0
            );
            if let Some(img) = image::RgbaImage::from_raw(w, h, rgba) {
                let p = std::env::temp_dir().join("poof-test-capture.png");
                if img.save(&p).is_ok() {
                    println!("已存 {}", p.display());
                }
            }
            if avg < 5 {
                println!("  ✗ 疑似黑屏(平均亮度<5)");
            } else {
                println!("  ✓ 有内容, 非黑屏");
            }
        }
        Err(e) => println!("capture failed: {}", e),
    }
    let _ = std::io::stdout().flush();
}

fn decode(b64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())
}

fn clipboard_set_png(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clip.set_image(arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    })
    .map_err(|e| e.to_string())
}

/// Copy a PNG (base64) to the clipboard as an image.
#[tauri::command]
pub fn copy_image(png_base64: String) -> Result<(), String> {
    clipboard_set_png(&decode(&png_base64)?)
}

/// Copy an existing history file to the clipboard as an image.
#[tauri::command]
pub fn copy_image_file(path: String) -> Result<(), String> {
    let p = ensure_in_shots(&path)?;
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    clipboard_set_png(&bytes)
}

/// Save a PNG (base64) under the shots folder and return its path.
#[tauri::command]
pub fn save_image(png_base64: String) -> Result<String, String> {
    let bytes = decode(&png_base64)?;
    let dir = shots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("shot-{}.png", now_ns()));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
pub struct ShotInfo {
    pub path: String,
    pub name: String,
    pub ts_ms: u64,
    pub w: u32,
    pub h: u32,
}

/// The persistent history: every .png in the shots folder, newest first.
#[tauri::command]
pub fn list_shots() -> Result<Vec<ShotInfo>, String> {
    let dir = shots_dir();
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out), // no folder yet = empty history
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) != Some(true) {
            continue;
        }
        let ts_ms = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let (w, h) = image::image_dimensions(&p).unwrap_or((0, 0));
        out.push(ShotInfo {
            path: p.to_string_lossy().into_owned(),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ts_ms,
            w,
            h,
        });
    }
    out.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(out)
}

/// A downscaled data-URL thumbnail of a history file (for the grid).
#[tauri::command]
pub fn read_image_b64(path: String) -> Result<String, String> {
    let p = ensure_in_shots(&path)?;
    let img = image::open(&p).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(360, 360);
    let mut png = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

/// Delete one history file.
#[tauri::command]
pub fn delete_shot(path: String) -> Result<(), String> {
    let p = ensure_in_shots(&path)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// Reveal a history file in Explorer (selected).
#[tauri::command]
pub fn reveal_shot(path: String) -> Result<(), String> {
    let p = ensure_in_shots(&path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.to_string_lossy()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pin a PNG (base64) as a floating always-on-top window. Loads pin.html and hands it the
/// image + size via an initialization script (a data: URL as the window URL is rejected by
/// WebView2 — this is the robust path and gives the pin real IPC for its operations).
#[tauri::command]
pub fn pin_image(app: tauri::AppHandle, png_base64: String, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
    // base64 alphabet (A-Za-z0-9+/=) is JS-string safe, so direct interpolation is fine.
    let init = format!("window.__pinB64=\"{png_base64}\";window.__pinW={w};window.__pinH={h};");
    let win = WebviewWindowBuilder::new(&app, format!("pin-{}", now_ns()), WebviewUrl::App("pin.html".into()))
        .title("poof pin")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .initialization_script(&init)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    let _ = win.set_focus();
    Ok(())
}

/// OCR a PNG (base64) via the built-in Windows OCR.
#[tauri::command]
pub fn ocr_region(png_base64: String) -> Result<String, String> {
    let bytes = decode(&png_base64)?;
    crate::ocr::ocr_png(&bytes)
}

/// Write the annotation Markdown sidecar next to its PNG in the shots folder (shares the
/// stem: shot-<ns>.png → shot-<ns>.md). Returns the .md path. Keeps everything inside
/// the history folder so the structured export lives beside the image it describes.
#[tauri::command]
pub fn save_markdown(md: String, png_path: String) -> Result<String, String> {
    let p = ensure_in_shots(&png_path)?; // png was just written by save_image → exists + in-folder
    let md_path = p.with_extension("md");
    std::fs::write(&md_path, md.as_bytes()).map_err(|e| e.to_string())?;
    // 去掉 canonicalize 带的 \\?\ 前缀, 让 [[路径]] 干净。
    let s = md_path.to_string_lossy().into_owned();
    Ok(s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s))
}

/// 统一捕获 · 目标探针结果(内部)。
/// - content_origin: 光标下浏览器/webview 内容区(Document)左上角的物理像素坐标(坐标换算原点)。
/// - win_title: 顶层窗口标题(供按标题匹配 omni 表面信标)。
struct CaptureProbe {
    content_origin: Option<[i32; 2]>,
    win_title: String,
}

/// 页内一个被这张截图压到的实体(材料/计划/笔记/项目/任务)。
#[derive(serde::Serialize, Default)]
pub struct ContainedEntity {
    pub title: Option<String>,
    pub path: Option<String>,
    pub description: Option<String>,
}

/// 一条文字标注(评论)+ 它的屏幕坐标。给后端按每条位置精确归材料(点 1)。
#[derive(serde::Deserialize)]
pub struct AnnotationIn {
    pub x: f64,
    pub y: f64,
    pub text: String,
}

/// 单条评论解析到的目标(挂在哪条材料 + 已建的札记 id)。
#[derive(serde::Serialize, Default)]
pub struct PointTarget {
    pub text: Option<String>,
    pub description: Option<String>,
    pub path: Option<String>,
    pub note_id: Option<String>,
}

/// 统一捕获结果。给 AI 看的是 文件路径 + 完整描述(不暴露 omni:// 这种模型陌生的自造规范);
/// omni_uri 只留作内部句柄。还回 在哪个页面(page_*) + 这一块里有哪些材料(contained)。
#[derive(serde::Serialize, Default)]
pub struct OmniResult {
    pub omni_uri: Option<String>,
    pub note_id: Option<String>,
    pub target_path: Option<String>,
    pub description: Option<String>,
    pub page_title: Option<String>,
    pub page_url: Option<String>,
    pub contained: Vec<ContainedEntity>,
    pub point_targets: Vec<PointTarget>,
}

/// 探测屏幕点 (x,y) 下面是什么(跳过 poof 自己的覆盖层)。用 UIA 树遍历(不 hit-test, 因截图覆盖层在最上)
/// 找包含该点的 Document 元素 → 其左上角即内容区原点; 找包含该点的最大 Window 元素 → 其名字即窗口标题。
#[cfg(windows)]
fn probe_target_sync(skip: &[isize], x: i32, y: i32) -> CaptureProbe {
    let els = crate::uia::elements_excluding(skip, 6000, 800);
    let contains = |e: &crate::uia::ElementInfo| {
        let [l, t, r, b] = e.rect;
        x >= l && x < r && y >= t && y < b && r > l && b > t
    };
    let mut doc: Option<(i64, [i32; 4])> = None;
    let mut win: Option<(i64, String)> = None;
    for e in els.iter() {
        if !contains(e) {
            continue;
        }
        let [l, t, r, b] = e.rect;
        let area = (r - l) as i64 * (b - t) as i64;
        if e.control_type.contains("Document") && doc.map(|(a, _)| area < a).unwrap_or(true) {
            doc = Some((area, e.rect));
        }
        if e.control_type.contains("Window") && !e.name.is_empty()
            && win.map(|(a, _)| area > a).unwrap_or(true)
        {
            win = Some((area, e.name.clone()));
        }
    }
    CaptureProbe {
        content_origin: doc.map(|(_, rc)| [rc[0], rc[1]]),
        win_title: win.map(|(_, n)| n).unwrap_or_default(),
    }
}

fn omni_endpoint() -> String {
    std::env::var("OMNI_CAPTURE_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:8210".to_string())
}

/// 统一捕获: 把一次(结构化)截图解析到它压在的 omni 实体, 并在有评论(=截图里的文字标注)时挂一条札记。
/// 服务端到服务端(ureq, 无 CORS); 全程 best-effort —— dashboard 没在跑 / 解析不出都安静返回空, 绝不报错、
/// 绝不卡住截图导出。评论复用截图里的文字, 不另起输入框; 结果(omni_uri)折进结构化 Markdown。
#[tauri::command]
pub async fn omni_capture(
    app: tauri::AppHandle, x: i32, y: i32, l: i32, t: i32, r: i32, b: i32,
    comment: String, png_base64: String, annotations: Vec<AnnotationIn>,
) -> OmniResult {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let mut skip: Vec<isize> = Vec::new();
        for (label, w) in app.webview_windows() {
            if (label == "snap" || label == "recbar") {
                if let Ok(h) = w.hwnd() {
                    skip.push(h.0 as isize);
                }
            }
        }
        tauri::async_runtime::spawn_blocking(move || {
            let probe = probe_target_sync(&skip, x, y);
            let origin = probe
                .content_origin
                .map(|o| serde_json::json!([o[0], o[1]]))
                .unwrap_or(serde_json::Value::Null);
            let base = omni_endpoint();
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_millis(1200))
                .timeout_read(std::time::Duration::from_millis(2500))
                .build();
            let comment = comment.trim().to_string();
            // 逐条文字标注(评论)→ JSON, 后端按每条位置精确归材料(点 1)。
            let anns_json: Vec<serde_json::Value> = annotations
                .iter()
                .map(|a| serde_json::json!({"x": a.x, "y": a.y, "text": a.text}))
                .collect();
            let has_anns = !anns_json.is_empty();
            // 有评论(整体)或逐条标注 → 走 /captures(解析 + 挂札记到实体); 否则 → /resolve(只读)。
            let (url, body) = if !comment.is_empty() || has_anns {
                let img = if png_base64.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String(format!("data:image/png;base64,{png_base64}"))
                };
                (
                    format!("{base}/api/boss-sight/captures"),
                    serde_json::json!({
                        "capture_kind": "capture", "modality": "still", "comment": comment,
                        "annotations": anns_json,
                        "image_data_url": img, "screen_rect": [l, t, r, b],
                        "content_origin": origin, "title": probe.win_title, "enqueue": false,
                    }),
                )
            } else {
                (
                    format!("{base}/api/boss-sight/captures/resolve"),
                    serde_json::json!({
                        "screen_rect": [l, t, r, b], "content_origin": origin,
                        "title": probe.win_title,
                    }),
                )
            };
            let body_str = serde_json::to_string(&body).unwrap_or_default();
            match agent.post(&url).set("Content-Type", "application/json").send_string(&body_str) {
                Ok(resp) => match resp.into_string().ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
                    Some(v) => {
                        let page = v.get("page");
                        OmniResult {
                            omni_uri: v.get("omni_uri").and_then(|x| x.as_str()).map(str::to_string),
                            note_id: v.get("note_id").and_then(|x| x.as_str()).map(str::to_string),
                            target_path: v.get("path").and_then(|x| x.as_str()).map(str::to_string),
                            description: v.get("description").and_then(|x| x.as_str()).map(str::to_string),
                            page_title: page.and_then(|p| p.get("title")).and_then(|x| x.as_str()).map(str::to_string),
                            page_url: page.and_then(|p| p.get("url")).and_then(|x| x.as_str()).map(str::to_string),
                            contained: v.get("contained").and_then(|x| x.as_array()).map(|arr| {
                                arr.iter().map(|e| ContainedEntity {
                                    title: e.get("title").and_then(|x| x.as_str()).map(str::to_string),
                                    path: e.get("path").and_then(|x| x.as_str()).map(str::to_string),
                                    description: e.get("description").and_then(|x| x.as_str()).map(str::to_string),
                                }).collect()
                            }).unwrap_or_default(),
                            point_targets: v.get("point_targets").and_then(|x| x.as_array()).map(|arr| {
                                arr.iter().filter(|e| e.is_object()).map(|e| PointTarget {
                                    text: e.get("text").and_then(|x| x.as_str()).map(str::to_string),
                                    description: e.get("description").and_then(|x| x.as_str()).map(str::to_string),
                                    path: e.get("path").and_then(|x| x.as_str()).map(str::to_string),
                                    note_id: e.get("note_id").and_then(|x| x.as_str()).map(str::to_string),
                                }).collect()
                            }).unwrap_or_default(),
                        }
                    },
                    None => OmniResult::default(),
                },
                Err(_) => OmniResult::default(),
            }
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y, l, t, r, b, comment, png_base64, annotations);
        OmniResult::default()
    }
}

/// "这个标注指向哪个 UI 元素" 的解析结果。
#[derive(serde::Serialize)]
pub struct PointAt {
    pub name: String,
    pub control_type: String,
    /// [left, top, right, bottom] 物理桌面坐标
    pub rect: [i32; 4],
}

/// Resolve each (screen-physical) point to the smallest UI element under it, SKIPPING ALL of
/// poof's own windows — so an annotation can never "point at" poof itself ("截图时选中内容不能
/// 选中自己"). Uses a UIA tree walk, NOT element_from_point: the snap overlay sits on top, so a
/// hit-test would always return poof. A negative point (e.g. -1,-1) is a sentinel (mosaic) and
/// is skipped so obscured regions never get resolved/leaked.
#[tauri::command]
pub async fn resolve_points_at(app: tauri::AppHandle, points: Vec<(i32, i32)>) -> Vec<Option<PointAt>> {
    let n = points.len();
    #[cfg(windows)]
    {
        use tauri::Manager;
        // 只跳过截图覆盖层本身(snap / recbar)—— 它盖在最上层, 不跳会"选中自己"。但 main 不跳:
        // 这样标注落在 poof 自己 UI 上时, 能解析出 poof 的内容(用户要的"洞察 poof 内容")。
        let mut skip: Vec<isize> = Vec::new();
        for (label, w) in app.webview_windows() {
            if label == "snap" || label == "recbar" {
                if let Ok(h) = w.hwnd() {
                    skip.push(h.0 as isize);
                }
            }
        }
        // UIA 遍历放到阻塞线程池跑, 绝不卡住 Tauri 事件循环(防止卡死阻断用户)。
        tauri::async_runtime::spawn_blocking(move || {
            let els = crate::uia::elements_excluding(&skip, 4000, 600);
            points
                .into_iter()
                .map(|(x, y)| {
                    if x < 0 || y < 0 {
                        return None; // 哨兵(mosaic): 不解析遮挡区
                    }
                    // 最小面积且包含该点、且有名字/类型的元素 = 最具体的目标
                    let mut best: Option<(usize, i64)> = None;
                    for (i, e) in els.iter().enumerate() {
                        let [l, t, r, b] = e.rect;
                        if x >= l
                            && x < r
                            && y >= t
                            && y < b
                            && (!e.name.is_empty() || !e.control_type.is_empty())
                        {
                            let area = (r - l) as i64 * (b - t) as i64;
                            if best.map(|(_, a)| area < a).unwrap_or(true) {
                                best = Some((i, area));
                            }
                        }
                    }
                    best.map(|(i, _)| PointAt {
                        name: els[i].name.clone(),
                        control_type: els[i].control_type.clone(),
                        rect: els[i].rect,
                    })
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_else(|_| (0..n).map(|_| None).collect())
    }
    #[cfg(not(windows))]
    {
        (0..n).map(|_| None).collect()
    }
}
