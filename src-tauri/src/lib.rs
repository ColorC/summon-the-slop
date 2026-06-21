// Poof — summoned overlay shell. Hold Ctrl + double-tap Alt summons a transparent panel.
mod pty;
mod search;
mod snapshot;
// live-inspector 洞察 capability (ported from waiela)
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod inspect;
#[cfg(windows)]
mod ocr;
#[cfg(windows)]
mod snap_cmd;
#[cfg(windows)]
mod uia;

use std::io::Write;
#[cfg(windows)]
use std::sync::mpsc::channel;
#[cfg(windows)]
use tauri::{Emitter, Manager};

#[derive(serde::Serialize)]
struct CmdOut {
    stdout: String,
    stderr: String,
    code: i32,
}

fn log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("poof-summon.log")
}

fn log_line(s: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{} {}", now_ms(), s);
    }
}

#[cfg(windows)]
fn now_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}
#[cfg(not(windows))]
fn now_ms() -> u64 {
    0
}

/// Run a shell command (cmd /C ...) with NO console window. Used by surfaces to call
/// `omni project list --json`, `waiela find`, `codex exec`, `claude -p`, etc.
#[tauri::command]
async fn run_shell(cmd: String) -> Result<CmdOut, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("cmd")
            .args(["/C", &cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(CmdOut {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(-1),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
        Err("windows only".into())
    }
}

#[cfg(windows)]
mod hook {
    use super::{log_line, now_ms};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    };

    /// What the hook asks the UI thread to do.
    pub enum Sig {
        Summon, // hold Ctrl + double-tap Alt → toggle the overlay
        Snap,   // Ctrl+Alt+A → jump straight into 截图
    }

    // Summon gesture = HOLD Ctrl + double-tap Alt. "held" is read from the real-time
    // physical key state (GetAsyncKeyState) so a missed key-up can never wedge it.
    static LAST_ALT_UP: AtomicU64 = AtomicU64::new(0);
    static SNAP_DOWN: AtomicBool = AtomicBool::new(false); // de-dupe Ctrl+Alt+A auto-repeat
    pub static TX: OnceLock<Sender<Sig>> = OnceLock::new();

    const WM_KEYDOWN: usize = 0x0100;
    const WM_KEYUP: usize = 0x0101;
    const WM_SYSKEYDOWN: usize = 0x0104;
    const WM_SYSKEYUP: usize = 0x0105;
    const VK_CONTROL: i32 = 0x11; // generic Ctrl (L or R)
    const VK_MENU_STATE: i32 = 0x12; // generic Alt, for GetAsyncKeyState
    const VK_LMENU: u32 = 0xA4; // left Alt
    const VK_RMENU: u32 = 0xA5; // right Alt
    const VK_MENU: u32 = 0x12; // generic Alt (injected)
    const VK_A: u32 = 0x41;
    const DOUBLE_MS: u64 = 450;

    #[inline]
    fn is_alt(vk: u32) -> bool {
        vk == VK_LMENU || vk == VK_RMENU || vk == VK_MENU
    }
    #[inline]
    unsafe fn held(vk: i32) -> bool {
        (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            // Ctrl+Alt+A → 截图. Swallow the 'A' (return 1) so it isn't typed into apps.
            if (wparam == WM_KEYDOWN || wparam == WM_SYSKEYDOWN) && kb.vkCode == VK_A {
                if held(VK_CONTROL) && held(VK_MENU_STATE) {
                    if !SNAP_DOWN.swap(true, Ordering::SeqCst) {
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(Sig::Snap);
                        }
                    }
                    return 1;
                }
            }
            if (wparam == WM_KEYUP || wparam == WM_SYSKEYUP) && kb.vkCode == VK_A {
                SNAP_DOWN.store(false, Ordering::SeqCst);
            }
            // hold Ctrl + double-tap Alt → toggle the overlay
            if (wparam == WM_KEYUP || wparam == WM_SYSKEYUP) && is_alt(kb.vkCode) {
                if held(VK_CONTROL) {
                    let now = now_ms();
                    let last = LAST_ALT_UP.swap(now, Ordering::SeqCst);
                    if last != 0 && now.saturating_sub(last) < DOUBLE_MS {
                        LAST_ALT_UP.store(0, Ordering::SeqCst);
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(Sig::Summon);
                        }
                    }
                } else {
                    LAST_ALT_UP.store(0, Ordering::SeqCst);
                }
            }
        }
        CallNextHookEx(0, code, wparam, lparam)
    }

    pub fn install() {
        std::thread::spawn(|| unsafe {
            let hmod = GetModuleHandleW(core::ptr::null());
            let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
            if h == 0 {
                log_line("ERROR SetWindowsHookExW failed (EDR may block low-level keyboard hook)");
                return;
            }
            log_line("hook installed ok (Ctrl+2xAlt summon · Ctrl+Alt+A 截图)");
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, 0, 0, 0) != 0 {}
        });
    }
}

/// Ask the user's own AI (Claude Code headless) — prompt piped via stdin to avoid quoting.
#[tauri::command]
async fn ask_ai(prompt: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "claude", "-p"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(prompt.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let s = String::from_utf8_lossy(&out.stdout).into_owned();
        if s.trim().is_empty() {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        } else {
            Ok(s)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = prompt;
        Err("windows only".into())
    }
}

/// Copy text to the Windows clipboard (the "复制" dispatch).
#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(text.as_bytes());
        }
        child.wait().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("windows only".into())
    }
}

/// Open a heavy surface (canvas / terminal / project / review / talk) as its OWN
/// normal window — the overlay shade stays lightweight; heavy stuff lives in
/// separate windows ("拖出来当普通窗口"). Built from an async command (not add_child)
/// to avoid the Windows main-thread deadlock.
#[tauri::command]
async fn open_view(app: tauri::AppHandle, view: String) -> Result<(), String> {
    use tauri::Manager;
    let safe: String = view.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let label = format!("view-{safe}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = tauri::WebviewUrl::App(format!("index.html#/{safe}").into());
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("poof · {safe}"))
        .inner_size(1120.0, 780.0)
        .always_on_top(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Native Windows file Properties dialog — the most-used standard right-click item.
/// (The full IContextMenu menu is a separate focused effort; this is the v1 native action.)
#[cfg(windows)]
#[tauri::command]
fn shell_props(path: String) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let verb: Vec<u16> = "properties\0".encode_utf16().collect();
    let file: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe {
        ShellExecuteW(
            0,
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };
    if r as isize <= 32 {
        Err(format!("ShellExecuteW(properties) failed: {}", r as isize))
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
#[tauri::command]
fn shell_props(path: String) -> Result<(), String> {
    let _ = path;
    Err("windows only".into())
}

/// Enter live-inspect (the 抓取/洞察 axis): hide poof's overlay so the real desktop is
/// exposed, then run the bare-Win32 highlight + element_from_point loop. Click grabs the
/// element (region image + structured text → clipboard, OCR fallback); Esc exits.
#[cfg(windows)]
#[tauri::command]
fn start_inspect(window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.hide();
    if !inspect::is_running() {
        std::thread::spawn(|| inspect::run_inspect(std::process::id() as i32));
    }
    Ok(())
}
#[cfg(not(windows))]
#[tauri::command]
fn start_inspect() -> Result<(), String> {
    Err("windows only".into())
}

/// Enter 截图 (screenshot/annotate). ORDER MATTERS: we show + focus the transparent snap
/// window FIRST, while poof's main overlay still owns the foreground (so Windows lets us
/// activate it), and only THEN hide main. If we hid main first, poof would lose foreground
/// and the snap window would show without keyboard focus — Esc wouldn't reach it and the
/// user would be trapped (only Alt+F4 closes an unfocused window). The snap content is
/// transparent at this point, so the capture (kicked by snap-summon) stays clean.
#[cfg(windows)]
fn summon_snap(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
    let Some(snap) = app.get_webview_window("snap") else { return };
    if let Ok(Some(m)) = snap.primary_monitor() {
        let p = m.position();
        let s = m.size();
        let _ = snap.set_position(PhysicalPosition::new(p.x, p.y));
        let _ = snap.set_size(PhysicalSize::new(s.width, s.height));
    }
    let _ = snap.show();
    let _ = snap.set_focus();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    let _ = snap.emit("snap-summon", ());
}
#[cfg(windows)]
#[tauri::command]
fn show_snap(app: tauri::AppHandle) -> Result<(), String> {
    summon_snap(&app);
    Ok(())
}
#[cfg(windows)]
#[tauri::command]
fn present_snap(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}
#[cfg(windows)]
#[tauri::command]
fn close_snap(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}
#[cfg(not(windows))]
#[tauri::command]
fn show_snap() -> Result<(), String> {
    Err("windows only".into())
}

// pending AI chats (provider, optional query) handed to the terminal window
static CHAT_INTENTS: std::sync::Mutex<Vec<(String, Option<String>)>> =
    std::sync::Mutex::new(Vec::new());

/// Start a new AI chat: ensure the terminal window is open/focused and queue an
/// intent (which CLI + optional query) that the terminal window drains.
#[tauri::command]
async fn new_chat(app: tauri::AppHandle, provider: String, query: Option<String>) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    CHAT_INTENTS.lock().unwrap().push((provider, query));
    let label = "view-terminal";
    if app.get_webview_window(label).is_none() {
        let url = tauri::WebviewUrl::App("index.html#/terminal".into());
        tauri::WebviewWindowBuilder::new(&app, label, url)
            .title("poof · 终端")
            .inner_size(1120.0, 780.0)
            .always_on_top(true)
            .build()
            .map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("poof:new-chat", ());
    }
    Ok(())
}

#[tauri::command]
fn take_chat_intents() -> Vec<(String, Option<String>)> {
    std::mem::take(&mut *CHAT_INTENTS.lock().unwrap())
}

#[allow(unused_variables)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be first: a second launch never starts a 2nd poof — it
        // just summons the existing one. Enforces the "never two poofs" rule at the process level.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = tauri::Emitter::emit(app, "summon", ());
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(windows)]
            {
                // Fullscreen overlay: cover the whole monitor (taskbar included).
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(Some(mon)) = w.current_monitor() {
                        let sz = mon.size();
                        let _ = w.set_size(tauri::PhysicalSize::new(sz.width, sz.height));
                        let _ = w.set_position(tauri::PhysicalPosition::new(0, 0));
                    }
                }
                let (tx, rx) = channel::<hook::Sig>();
                let _ = hook::TX.set(tx);
                hook::install();
                std::thread::spawn(move || {
                    for sig in rx {
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || match sig {
                            hook::Sig::Snap => summon_snap(&h),
                            hook::Sig::Summon => {
                                if let Some(w) = h.get_webview_window("main") {
                                    let visible = w.is_visible().unwrap_or(false);
                                    if visible {
                                        let _ = w.hide();
                                        log_line("toggle hide");
                                    } else {
                                        let _ = w.unminimize();
                                        let _ = w.show();
                                        let _ = w.set_always_on_top(true);
                                        let _ = w.set_focus();
                                        let _ = h.emit("summon", ());
                                        log_line("toggle show");
                                    }
                                }
                            }
                        });
                    }
                });
            }
            log_line("app started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_shell,
            ask_ai,
            copy_text,
            open_view,
            new_chat,
            take_chat_intents,
            shell_props,
            start_inspect,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            search::search,
            search::search_reindex,
            search::open_path,
            search::reveal_path,
            snapshot::snapshot_region,
            show_snap,
            present_snap,
            close_snap,
            snap_cmd::capture_screen,
            snap_cmd::copy_image,
            snap_cmd::copy_image_file,
            snap_cmd::save_image,
            snap_cmd::list_shots,
            snap_cmd::read_image_b64,
            snap_cmd::delete_shot,
            snap_cmd::reveal_shot,
            snap_cmd::pin_image,
            snap_cmd::ocr_region
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Headless backend tests — runtime-verify the 抓取/截图/洞察 backend without any UI
// (no summon gesture, no second poof). Run: cargo test --lib.
#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn capture_returns_a_full_frame() {
        let (rgba, w, h, _x, _y, _s) = crate::capture::capture_primary_raw().expect("capture");
        assert!(w > 0 && h > 0, "bad dims {w}x{h}");
        assert_eq!(rgba.len(), (w as usize) * (h as usize) * 4, "rgba size mismatch");
    }

    #[test]
    fn save_image_writes_a_png() {
        // 1x1 PNG
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let path = crate::snap_cmd::save_image(b64.to_string()).expect("save_image");
        let p = std::path::Path::new(&path);
        assert!(p.exists(), "file not written: {path}");
        assert_eq!(p.extension().and_then(|e| e.to_str()), Some("png"));
        let bytes = std::fs::read(p).unwrap();
        assert_eq!(&bytes[1..4], b"PNG", "not a PNG");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn ocr_reads_rendered_text() {
        use ab_glyph::{FontVec, PxScale};
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use image::ImageEncoder;
        use imageproc::drawing::draw_text_mut;
        let data = std::fs::read("C:\\Windows\\Fonts\\msyh.ttc").expect("font");
        let font = FontVec::try_from_vec_and_index(data, 0).expect("parse font");
        let mut img = image::RgbaImage::from_pixel(420, 90, image::Rgba([255, 255, 255, 255]));
        draw_text_mut(&mut img, image::Rgba([0, 0, 0, 255]), 10, 22, PxScale::from(40.0), &font, "Hello OCR 12345");
        let mut png = Vec::new();
        PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
            .write_image(img.as_raw(), 420, 90, image::ExtendedColorType::Rgba8)
            .unwrap();
        let text = crate::ocr::ocr_png(&png).expect("ocr_png");
        let low = text.to_lowercase();
        assert!(low.contains("hello") || text.contains("12345"), "ocr returned: {text:?}");
    }

    #[test]
    fn shot_history_roundtrip() {
        // 1x1 PNG → save into the shots folder, find it in the history list, render a
        // thumbnail data-URL, then delete it. Exercises the whole persistent-list backend.
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let p = crate::snap_cmd::save_image(b64.to_string()).expect("save_image");
        let shots = crate::snap_cmd::list_shots().expect("list_shots");
        assert!(shots.iter().any(|s| s.path == p), "saved shot missing from history");
        let thumb = crate::snap_cmd::read_image_b64(p.clone()).expect("read_image_b64");
        assert!(thumb.starts_with("data:image/png;base64,"), "thumbnail isn't a png data-url");
        // the path guard must reject anything outside the shots folder
        assert!(
            crate::snap_cmd::read_image_b64("C:\\Windows\\System32\\drivers\\etc\\hosts".into()).is_err(),
            "ensure_in_shots failed to reject an outside path"
        );
        crate::snap_cmd::delete_shot(p.clone()).expect("delete_shot");
        let after = crate::snap_cmd::list_shots().expect("list_shots after delete");
        assert!(!after.iter().any(|s| s.path == p), "shot was not deleted");
    }

    #[test]
    fn elements_in_rect_finds_real_elements() {
        // Over the FULL primary monitor a real desktop always has UI (taskbar, window
        // controls, etc.), so this asserts elements_in_rect actually RETURNS named
        // elements — a behavior check, not just a no-panic smoke test.
        let (_rgba, w, h, _x, _y, _s) = crate::capture::capture_primary_raw().expect("capture");
        let els = crate::uia::elements_in_rect(0, 0, w as i32, h as i32, 50).expect("elements_in_rect");
        assert!(!els.is_empty(), "expected >=1 named element over the full screen, got 0");
    }
}
