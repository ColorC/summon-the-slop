//! 区域录制 — the convenient, zero-config recorder. The 截图 overlay hands a selected
//! PHYSICAL-pixel rect to start(); a background thread then screenshots THAT rect on a loop,
//! OCRs each frame to text, and records foreground-window + activity — all into the SAME
//! session store. No token, no extension, no collector, no extra window: fully in-process,
//! exactly like 截图. Keyframes (image + OCR text) are the AI-readable "what was on screen
//! over time"; the rrweb surfaces stay as the high-fidelity option for web/editor.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
    IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SID: Mutex<Option<String>> = Mutex::new(None);
static RECT: Mutex<(i32, i32, i32, i32)> = Mutex::new((0, 0, 0, 0)); // physical desktop coords
static SEQ: AtomicU64 = AtomicU64::new(0);
static GEN: AtomicU64 = AtomicU64::new(0); // see native_rec: kills a stale poll thread on rapid restart
static FOLLOW_HWND: AtomicI64 = AtomicI64::new(0); // !=0 → record this window, following its moves

const TICK_MS: u64 = 2000;

pub fn is_recording() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Start recording the given physical-pixel rect (l,t,r,b). If `hwnd` != 0 the recorder follows
/// that window (re-reads its rect each frame, stops when it closes). One session at a time.
pub fn start(l: i32, t: i32, r: i32, b: i32, hwnd: i64) -> Result<String, String> {
    if ACTIVE.load(Ordering::SeqCst) {
        return Err("屏幕录制已在进行".into());
    }
    if r - l < 4 || b - t < 4 {
        return Err("选区太小".into());
    }
    let title = if hwnd != 0 { "窗口录制" } else { "屏幕录制" };
    let sid = crate::record_cmd::init_session(title, "screen")?;
    std::fs::create_dir_all(crate::record_cmd::session_dir(&sid).join("frames")).map_err(|e| e.to_string())?;
    *SID.lock().unwrap() = Some(sid.clone());
    *RECT.lock().unwrap() = (l, t, r, b);
    FOLLOW_HWND.store(hwnd, Ordering::SeqCst);
    SEQ.store(0, Ordering::SeqCst);
    let gen = GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    ACTIVE.store(true, Ordering::SeqCst);
    let sid_thread = sid.clone();
    std::thread::spawn(move || poll_loop(gen, sid_thread));
    Ok(sid)
}

pub fn stop() {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    let sid = SID.lock().unwrap().take();
    if let Some(sid) = sid {
        crate::record_cmd::stamp_stop(&sid);
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit(sid: &str, kind: &str, p: serde_json::Value) {
    let ev = serde_json::json!({
        "sid": sid,
        "seq": SEQ.fetch_add(1, Ordering::SeqCst),
        "ts": epoch_ms(),
        "surface": "screen",
        "src": "region",
        "kind": kind,
        "p": p,
    });
    let _ = crate::record_cmd::append_events(sid, std::slice::from_ref(&ev));
}

/// Capture the primary frame, crop to the physical rect, return (png_bytes, w, h).
fn capture_rect_png(l: i32, t: i32, r: i32, b: i32) -> Option<(Vec<u8>, u32, u32)> {
    let (rgba, w, h, mx, my, _) = crate::capture::capture_primary_raw().ok()?;
    let img = image::RgbaImage::from_raw(w, h, rgba)?;
    let lx = (l - mx).max(0) as u32;
    let ty = (t - my).max(0) as u32;
    if lx >= w || ty >= h {
        return None;
    }
    let rw = ((r - l).max(1) as u32).min(w - lx);
    let rh = ((b - t).max(1) as u32).min(h - ty);
    let sub = image::imageops::crop_imm(&img, lx, ty, rw, rh).to_image();
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(sub)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some((png, rw, rh))
}

fn poll_loop(gen: u64, sid: String) {
    // WinRT OCR is called from this worker thread, which (unlike a Tauri command thread) has no
    // initialized apartment — RoInitialize it (MTA), ignoring "already initialized" (S_FALSE /
    // RPC_E_CHANGED_MODE) so OCR doesn't silently fail to empty text.
    unsafe {
        let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
    }
    let frames_dir = crate::record_cmd::session_dir(&sid).join("frames");
    let mut frame_n: u32 = 0;
    let mut last_text = String::new();
    let mut last_focus = String::new();
    let mut last_active: Option<bool> = None;
    let mut tick: u64 = 0;
    loop {
        if !ACTIVE.load(Ordering::SeqCst) || GEN.load(Ordering::SeqCst) != gen {
            break;
        }
        // if following a window, track its CURRENT rect; finalize this session if it closed
        let fhwnd = FOLLOW_HWND.load(Ordering::SeqCst);
        let (l, t, r, b) = if fhwnd != 0 {
            match window_rect(fhwnd) {
                Some(rc) => rc,
                None => {
                    if GEN.load(Ordering::SeqCst) == gen && ACTIVE.swap(false, Ordering::SeqCst) {
                        if let Some(s) = SID.lock().unwrap().take() {
                            crate::record_cmd::stamp_stop(&s);
                        }
                    }
                    break;
                }
            }
        } else {
            *RECT.lock().unwrap()
        };
        // ---- keyframe: screenshot the rect + OCR. Save+emit on first / text-change / ~16s heartbeat
        if let Some((png, w, h)) = capture_rect_png(l, t, r, b) {
            let text = crate::ocr::ocr_png(&png).unwrap_or_default();
            let changed = text.trim() != last_text.trim();
            if frame_n == 0 || changed || tick % 8 == 0 {
                let name = format!("frames/{:04}.png", frame_n);
                let _ = std::fs::write(frames_dir.join(format!("{:04}.png", frame_n)), &png);
                frame_n += 1;
                last_text = text.clone();
                emit(&sid, "keyframe", serde_json::json!({ "frame": name, "text": text.trim(), "w": w, "h": h }));
            }
        }
        // ---- foreground window (reuse the native-layer sampler)
        if let Some((_fg, title, process)) = crate::native_rec::foreground() {
            let key = format!("{title}|{process}");
            if key != last_focus {
                last_focus = key;
                emit(&sid, "native.focus", serde_json::json!({ "title": title, "process": process }));
            }
        }
        // ---- activity (active/idle, sampled ~ every 8s)
        if tick % 4 == 0 {
            let idle = crate::native_rec::idle_ms();
            let active = idle < 5000;
            if last_active != Some(active) {
                last_active = Some(active);
                emit(&sid, "native.activity", serde_json::json!({ "active": active, "idleMs": idle }));
            }
        }
        tick += 1;
        std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
    }
}

#[derive(serde::Serialize)]
pub struct WinInfo {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
    pub hwnd: i64,
    pub title: String,
}

/// Current physical rect of a window, or None if it's gone / hidden.
fn window_rect(hwnd: i64) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) == 0 || IsWindowVisible(h) == 0 {
            return None;
        }
        let mut rc: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut rc) == 0 {
            return None;
        }
        Some((rc.left, rc.top, rc.right, rc.bottom))
    }
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
    let out = &mut *(lparam as *mut Vec<WinInfo>);
    if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
        return 1;
    }
    if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
        return 1; // skip tool windows (tray helpers etc.)
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return 1; // skip untitled
    }
    let mut rc: RECT = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rc) == 0 {
        return 1;
    }
    if rc.right - rc.left < 80 || rc.bottom - rc.top < 60 {
        return 1; // skip slivers
    }
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    if title.starts_with("poof") {
        return 1; // skip our own overlay/bar/windows
    }
    out.push(WinInfo { l: rc.left, t: rc.top, r: rc.right, b: rc.bottom, hwnd: hwnd as i64, title });
    1
}

/// Top-level windows, TOP of the z-order first (EnumWindows order), visible + titled, excluding
/// poof's own. Captured once when entering 录制模式 so the overlay can hit-test the cursor.
pub fn list_windows() -> Vec<WinInfo> {
    let mut out: Vec<WinInfo> = Vec::new();
    unsafe {
        EnumWindows(Some(enum_cb), &mut out as *mut _ as LPARAM);
    }
    out
}
