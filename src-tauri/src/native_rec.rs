//! P4 native coarse layer. When a native recording session is active, a background thread polls
//! the foreground window (app + title) and system input activity (active/idle), writing native.*
//! events into the SAME session store as the other surfaces (in-process via record_cmd).
//!
//! COARSE BY DESIGN — and deliberately so: it records WHICH app you're in and WHEN you're active,
//! never keystrokes or content. The fine-grained, in-app signal (clicks, typed text) is captured
//! by the rrweb surfaces (poof/chrome) and the VSCode surface, each with redaction. A global
//! keystroke recorder here would be a keylogger; we use GetLastInputInfo (idle time only) instead.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SID: Mutex<Option<String>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(0);
// Generation guard: a rapid stop()->start() (within the 500ms poll tick) could otherwise leave
// the old poll thread alive alongside the new one. Each start() bumps GEN; a poll thread exits
// the moment GEN no longer matches the generation it was spawned with.
static GEN: AtomicU64 = AtomicU64::new(0);

pub fn is_recording() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Start a native recording session (one at a time). Spawns the poll thread.
pub fn start(title: &str) -> Result<String, String> {
    if ACTIVE.load(Ordering::SeqCst) {
        return Err("native 录制已在进行".into());
    }
    let sid = crate::record_cmd::init_session(title, "native")?;
    *SID.lock().unwrap() = Some(sid.clone());
    SEQ.store(0, Ordering::SeqCst);
    let gen = GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    ACTIVE.store(true, Ordering::SeqCst);
    std::thread::spawn(move || poll_loop(gen));
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

fn emit(kind: &str, p: serde_json::Value) {
    let sid = { SID.lock().unwrap().clone() };
    if let Some(sid) = sid {
        let ev = serde_json::json!({
            "sid": sid,
            "seq": SEQ.fetch_add(1, Ordering::SeqCst),
            "ts": epoch_ms(),
            "surface": "native",
            "src": "desktop",
            "kind": kind,
            "p": p,
        });
        let _ = crate::record_cmd::append_events(&sid, std::slice::from_ref(&ev));
    }
}

/// (hwnd, title, process-exe-name) of the current foreground window, if any.
pub(crate) fn foreground() -> Option<(isize, String, String)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if n > 0 { String::from_utf16_lossy(&buf[..n as usize]) } else { String::new() };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        Some((hwnd, title, process_name(pid)))
    }
}

fn process_name(pid: u32) -> String {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let mut sz = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut sz); // 0 = PROCESS_NAME_WIN32
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..sz as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string()
    }
}

/// Milliseconds since the last system-wide input (mouse/keyboard) — activity, NOT content.
pub(crate) fn idle_ms() -> u64 {
    unsafe {
        let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut lii) != 0 {
            GetTickCount64().saturating_sub(lii.dwTime as u64)
        } else {
            0
        }
    }
}

const IDLE_THRESHOLD_MS: u64 = 5000;

fn poll_loop(gen: u64) {
    let mut last_focus = String::new();
    let mut last_active: Option<bool> = None;
    let mut tick: u64 = 0;
    // exit if stopped OR if a newer start() superseded this thread
    while ACTIVE.load(Ordering::SeqCst) && GEN.load(Ordering::SeqCst) == gen {
        if let Some((hwnd, title, process)) = foreground() {
            let key = format!("{hwnd}|{title}"); // same hwnd can retitle (e.g. tab switch)
            if key != last_focus {
                last_focus = key;
                emit("native.focus", serde_json::json!({ "title": title, "process": process }));
            }
        }
        // sample activity every ~2s; emit only on active<->idle transitions
        if tick % 4 == 0 {
            let idle = idle_ms();
            let active = idle < IDLE_THRESHOLD_MS;
            if last_active != Some(active) {
                last_active = Some(active);
                emit("native.activity", serde_json::json!({ "active": active, "idleMs": idle }));
            }
        }
        tick += 1;
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
