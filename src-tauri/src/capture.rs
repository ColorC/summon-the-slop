//! Screen capture. Returns RAW RGBA bytes (no PNG encode/base64) so the summon path skips a
//! ~400ms PNG compression plus a webview image-decode — the frontend putImageData's the bytes
//! straight onto the canvas. v1 = primary monitor; multi-monitor compositing is a follow-up.
//!
//! PRIMARY method = GDI BitBlt of the screen DC ("单纯抓电脑的屏幕"): grabs the FINAL composited
//! screen pixels as displayed (所见即所得). Transparent/layered windows show their content behind
//! them (CAPTUREBLT), so poof's own transparent overlay does NOT turn the shot black — unlike
//! xcap/WGC, which fought poof's transparent fullscreen overlay (black frame). GDI is also fast
//! (~few ms vs xcap ~250ms), which removes the freeze. xcap stays as a fallback.

/// (rgba8, width, height, monitor_x, monitor_y, scale_factor)
pub fn capture_primary_raw() -> Result<(Vec<u8>, u32, u32, i32, i32, f32), String> {
    #[cfg(windows)]
    {
        match capture_primary_gdi() {
            Ok(v) => return Ok(v),
            Err(e1) => {
                return capture_primary_xcap().map_err(|e2| format!("gdi: {e1}; xcap fallback: {e2}"));
            }
        }
    }
    #[cfg(not(windows))]
    {
        capture_primary_xcap()
    }
}

// GDI BitBlt of the primary-monitor screen DC. Captures the composited desktop incl. any
// transparent/layered windows on top (CAPTUREBLT). Fast and robust. Forces per-monitor-v2 DPI
// awareness on this thread so GetSystemMetrics/GetDC report PHYSICAL pixels (else DPI-virtualized
// to logical 1707×960, which misaligns the frontend's dpr mapping); restores it after.
#[cfg(windows)]
fn capture_primary_gdi() -> Result<(Vec<u8>, u32, u32, i32, i32, f32), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        let prev_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        let screen = if w > 0 && h > 0 { GetDC(0) } else { 0 };
        let res: Result<Vec<u8>, String> = if screen == 0 {
            Err(format!("bad screen / GetDC ({w}x{h})"))
        } else {
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            if mem == 0 || bmp == 0 {
                if mem != 0 {
                    DeleteDC(mem);
                }
                if bmp != 0 {
                    DeleteObject(bmp);
                }
                Err("GDI alloc failed".into())
            } else {
                let old = SelectObject(mem, bmp);
                let blt = BitBlt(mem, 0, 0, w, h, screen, 0, 0, SRCCOPY | CAPTUREBLT);
                let mut bi: BITMAPINFO = std::mem::zeroed();
                bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                bi.bmiHeader.biWidth = w;
                bi.bmiHeader.biHeight = -h; // negative = top-down rows
                bi.bmiHeader.biPlanes = 1;
                bi.bmiHeader.biBitCount = 32;
                bi.bmiHeader.biCompression = BI_RGB as u32;
                let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
                let got = GetDIBits(
                    mem,
                    bmp,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    &mut bi,
                    DIB_RGB_COLORS,
                );
                SelectObject(mem, old);
                DeleteObject(bmp);
                DeleteDC(mem);
                if blt == 0 || got == 0 {
                    Err("BitBlt/GetDIBits failed".into())
                } else {
                    // GDI 32bpp 是 BGRX(小端内存序 B,G,R,X)。转成 RGBA 不透明给前端 putImageData / PNG。
                    // 用 u32 整字处理(一读一写 + 位运算)比逐字节 swap 在 debug 构建下快好几倍 —— 整屏 370 万
                    // 像素, 这个循环本身就是诊断"慢"的一大块。len 恒为 w*h*4, 必是 4 的倍数。
                    let p = buf.as_mut_ptr() as *mut u32;
                    let n = buf.len() / 4;
                    for i in 0..n {
                        unsafe {
                            let v = *p.add(i); // 小端: X<<24 | R<<16 | G<<8 | B
                            // 目标 RGBA 小端: 0xFF<<24 | B<<16 | G<<8 | R
                            *p.add(i) = 0xFF00_0000
                                | ((v & 0x0000_00FF) << 16)
                                | (v & 0x0000_FF00)
                                | ((v >> 16) & 0x0000_00FF);
                        }
                    }
                    Ok(buf)
                }
            }
        };
        if screen != 0 {
            ReleaseDC(0, screen);
        }
        let _ = SetThreadDpiAwarenessContext(prev_dpi); // restore DPI context
        res.map(|buf| (buf, w as u32, h as u32, 0, 0, 1.0))
    }
}

// Fallback: xcap (WGC). Kept in case GDI fails on some setup.
fn capture_primary_xcap() -> Result<(Vec<u8>, u32, u32, i32, i32, f32), String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitor found".into());
    }
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .unwrap_or_else(|| monitors[0].clone());

    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (width, height) = (img.width(), img.height());
    Ok((
        img.into_raw(),
        width,
        height,
        monitor.x().unwrap_or(0),
        monitor.y().unwrap_or(0),
        monitor.scale_factor().unwrap_or(1.0),
    ))
}
