//! Screen-region snapshot via GDI BitBlt. Captures whatever is visually on screen in
//! the given rect (including GPU-composited WebView2 / BlockSuite canvas — a real screen
//! grab, unlike PrintWindow which returns black for the webview) and saves a PNG.
//! The overlay window is fixed-fullscreen at (0,0), so client coords == screen coords.

#[cfg(windows)]
fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    if w <= 0 || h <= 0 {
        return Err("bad size".into());
    }
    unsafe {
        let screen = GetDC(0);
        if screen == 0 {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp as _);
        let blt = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);

        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // negative => top-down rows
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB as u32;

        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut _,
            &mut bi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        DeleteObject(bmp as _);
        DeleteDC(mem);
        ReleaseDC(0, screen);

        if blt == 0 || lines == 0 {
            return Err("BitBlt/GetDIBits failed".into());
        }
        // GDI gives BGRA; convert to RGBA and force opaque alpha
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(buf)
    }
}

/// Capture a screen rect to a PNG under %TEMP%/overlay-shell-snapshots and return its path.
#[cfg(windows)]
#[tauri::command]
pub fn snapshot_region(x: i32, y: i32, w: i32, h: i32) -> Result<String, String> {
    let rgba = capture_region(x, y, w, h)?;
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or("buffer→image")?;
    let dir = std::env::temp_dir().join("overlay-shell-snapshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("snap-{}.png", ts));
    img.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn snapshot_region(x: i32, y: i32, w: i32, h: i32) -> Result<String, String> {
    let _ = (x, y, w, h);
    Err("windows only".into())
}
