// Poof — summoned overlay shell. Double-tap Ctrl summons a transparent always-on-top panel.
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    };

    // Summon gesture = HOLD Ctrl + double-tap Alt. "Ctrl held" is read from the real-time
    // physical key state (GetAsyncKeyState) so a missed key-up can never wedge it.
    static LAST_ALT_UP: AtomicU64 = AtomicU64::new(0);
    pub static TX: OnceLock<Sender<()>> = OnceLock::new();

    const WM_KEYUP: usize = 0x0101;
    const WM_SYSKEYUP: usize = 0x0105;
    const VK_CONTROL: i32 = 0x11; // generic Ctrl (L or R)
    const VK_LMENU: u32 = 0xA4; // left Alt
    const VK_RMENU: u32 = 0xA5; // right Alt
    const VK_MENU: u32 = 0x12; // generic Alt (injected)
    const DOUBLE_MS: u64 = 450;

    #[inline]
    fn is_alt(vk: u32) -> bool {
        vk == VK_LMENU || vk == VK_RMENU || vk == VK_MENU
    }
    #[inline]
    unsafe fn ctrl_held() -> bool {
        (GetAsyncKeyState(VK_CONTROL) as u16 & 0x8000) != 0
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 && (wparam == WM_KEYUP || wparam == WM_SYSKEYUP) {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            if is_alt(kb.vkCode) {
                if ctrl_held() {
                    let now = now_ms();
                    let last = LAST_ALT_UP.swap(now, Ordering::SeqCst);
                    if last != 0 && now.saturating_sub(last) < DOUBLE_MS {
                        LAST_ALT_UP.store(0, Ordering::SeqCst);
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(());
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
            log_line("hook installed ok (hold Ctrl + double-tap Alt armed)");
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

#[allow(unused_variables)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(windows)]
            {
                let (tx, rx) = channel::<()>();
                let _ = hook::TX.set(tx);
                hook::install();
                std::thread::spawn(move || {
                    for _ in rx {
                        if let Some(w) = handle.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            if visible {
                                let _ = w.hide();
                                log_line("toggle hide");
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = handle.emit("summon", ());
                                log_line("toggle show");
                            }
                        }
                    }
                });
            }
            log_line("app started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![run_shell, ask_ai, copy_text])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
