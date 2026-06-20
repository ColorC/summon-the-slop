//! Screenshot ("截图") backend: full-frame capture for the annotate overlay, plus the
//! output dispatches (copy image / save / pin / OCR). Ported from waiela.
use base64::Engine;

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

/// Copy a PNG (base64) to the clipboard as an image.
#[tauri::command]
pub fn copy_image(png_base64: String) -> Result<(), String> {
    let bytes = decode(&png_base64)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clip.set_image(arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Save a PNG (base64) under %USERPROFILE%\Pictures\poof-shots and return its path.
#[tauri::command]
pub fn save_image(png_base64: String) -> Result<String, String> {
    let bytes = decode(&png_base64)?;
    let dir = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("poof-shots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("shot-{ts}.png"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Pin a PNG (base64) as a borderless always-on-top window at the given physical rect.
#[tauri::command]
pub fn pin_image(app: tauri::AppHandle, png_base64: String, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
    let url = format!("data:image/png;base64,{png_base64}");
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let win = WebviewWindowBuilder::new(&app, format!("pin-{ts}"), WebviewUrl::External(parsed))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    Ok(())
}

/// OCR a PNG (base64) via the built-in Windows OCR.
#[tauri::command]
pub fn ocr_region(png_base64: String) -> Result<String, String> {
    let bytes = decode(&png_base64)?;
    crate::ocr::ocr_png(&bytes)
}
