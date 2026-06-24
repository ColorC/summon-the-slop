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
    Ok(md_path.to_string_lossy().into_owned())
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
        // 收集 poof 所有窗口的 HWND 一并跳过(main/snap/recbar/pin/view…)
        let mut skip: Vec<isize> = Vec::new();
        for (_label, w) in app.webview_windows() {
            if let Ok(h) = w.hwnd() {
                skip.push(h.0 as isize);
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
