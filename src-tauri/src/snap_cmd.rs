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

/// Full primary-monitor frame as raw RGBA with a 20-byte header (w,h,x,y i32 LE, scale f32
/// LE). The snap overlay putImageData's it — no PNG encode/decode on the summon path.
#[tauri::command]
pub fn capture_screen() -> Result<tauri::ipc::Response, String> {
    let (rgba, w, h, x, y, scale) = crate::capture::capture_primary_raw()?;
    let mut buf = Vec::with_capacity(20 + rgba.len());
    buf.extend_from_slice(&(w as i32).to_le_bytes());
    buf.extend_from_slice(&(h as i32).to_le_bytes());
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&scale.to_le_bytes());
    buf.extend_from_slice(&rgba);
    Ok(tauri::ipc::Response::new(buf))
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
