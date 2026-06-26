// Poof — summoned overlay shell. Hold Ctrl + double-tap Alt summons a transparent panel.
mod http_rec; // AI 会话录像 (P2): localhost HTTP collector for extensions
#[cfg(windows)]
mod native_rec; // AI 会话录像 (P4): native coarse layer (foreground window + activity)
#[cfg(windows)]
mod region_rec; // 区域录制: 截图同款选区 → 关键帧+OCR+焦点+活跃,零配置
mod pty;
mod fileio; // 笔记「活文件块」的磁盘读写: 文本读/写回 + 二进制 base64(图片/PDF 预览)
mod notesstore; // 笔记落盘存储: docs/<id>.ydoc + blobs/<sha>(搬出 WebView2 IndexedDB 到浅路径)
mod notebridge; // 笔记 ops 桥(CLI ⇄ 活笔记 collection 的文件命令队列)
mod record_cmd; // AI 会话录像 (P1)
mod search;
mod tags; // 自定义文件标签(path→tags, 落 %LOCALAPPDATA%, 进搜索打分 + #tag 过滤)
mod fileid; // NTFS FileId 冗余救援键(文件移到监视目录外时, 标签靠它自愈)
#[cfg(windows)]
mod mft; // NTFS MFT/USN 全盘枚举(Everything 级范围), search 用; 非 NTFS/未提权时回退游走
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
mod diagnostic; // 全量诊断快照(Ctrl+Alt+D): 截当前所有可见 poof 界面 + 时间 + 状态 → 报告 + 复制链接
mod clipclip; // 剪贴板历史: 监听系统剪贴板, 持久化 文本/图片/HTML, 供内容管理界面浏览/恢复
#[cfg(windows)]
mod uia;

use std::io::Write;
#[cfg(windows)]
use std::sync::mpsc::channel;
#[cfg(windows)]
use tauri::Manager;

#[derive(serde::Serialize)]
struct CmdOut {
    stdout: String,
    stderr: String,
    code: i32,
}

fn log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("poof-summon.log")
}

// 串行化写入 —— 否则多线程(键盘钩子 / setup / OCR 轮询 / JS 命令)同时 append, 字节会交错成乱码。
static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn log_line(s: &str) {
    let _g = LOG_LOCK.lock();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{} {}", now_ms(), s);
    }
}

/// 全套日志: JS 侧(各 webview 窗口)把 console 报错 / 未捕获异常 / Promise 拒绝喂进来,
/// 落进和原生日志同一条时间线, 便于在崩溃(原生 0xcfffffff 这类)前后对齐排查。
#[tauri::command]
fn log_js(line: String) {
    let s: String = line.chars().take(4000).collect();
    log_line(&format!("[js] {s}"));
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

/// P4 — start/stop recording the native desktop coarse layer (foreground app + activity).
#[tauri::command]
fn native_start() -> Result<String, String> {
    #[cfg(windows)]
    {
        native_rec::start("桌面活动录制")
    }
    #[cfg(not(windows))]
    {
        Err("windows only".into())
    }
}

#[tauri::command]
fn native_stop() -> Result<(), String> {
    #[cfg(windows)]
    {
        native_rec::stop();
    }
    Ok(())
}

/// Show the 录制条 (recording bar) just OUTSIDE the recorded rect (below it, or above/bottom if
/// no room) so it's always visible but stays out of the captured frames. Tells it the start time.
#[cfg(windows)]
fn show_recbar(app: &tauri::AppHandle, l: i32, t: i32, r: i32, b: i32, start_ms: u64) {
    use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
    let Some(bar) = app.get_webview_window("recbar") else { return };
    let (mx, my, mw, mh, scale) = if let Ok(Some(m)) = bar.primary_monitor() {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, s.width as i32, s.height as i32, m.scale_factor())
    } else {
        (0, 0, 1920, 1080, 1.0)
    };
    let bw = (248.0 * scale) as i32;
    let bh = (56.0 * scale) as i32;
    let mut bx = (l + r) / 2 - bw / 2;
    bx = bx.max(mx).min(mx + mw - bw);
    let mut by = b + 8; // prefer just below the recorded region
    if by + bh > my + mh {
        by = t - bh - 8; // else just above
    }
    if by < my {
        by = my + mh - bh - 8; // else pin to screen bottom
    }
    let _ = bar.set_size(PhysicalSize::new(bw.max(1) as u32, bh.max(1) as u32));
    let _ = bar.set_position(PhysicalPosition::new(bx, by));
    let _ = bar.show();
    let _ = bar.set_always_on_top(true);
    let _ = bar.emit("rec-started", start_ms);
}
#[cfg(windows)]
fn hide_recbar(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    if let Some(bar) = app.get_webview_window("recbar") {
        let _ = bar.emit("rec-stopped", ());
        let _ = bar.hide();
    }
}

/// 区域录制 — start recording a rect (截图选区交给这里). hwnd!=0 → follow that window. Shows the bar.
#[tauri::command]
fn region_record_start(app: tauri::AppHandle, l: i32, t: i32, r: i32, b: i32, hwnd: Option<i64>) -> Result<String, String> {
    #[cfg(windows)]
    {
        let sid = region_rec::start(l, t, r, b, hwnd.unwrap_or(0))?;
        let start_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        show_recbar(&app, l, t, r, b, start_ms);
        Ok(sid)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, l, t, r, b, hwnd);
        Err("windows only".into())
    }
}

#[tauri::command]
fn region_record_stop(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        region_rec::stop();
        hide_recbar(&app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    Ok(())
}

/// Is a 区域录制 session active? The recbar polls this so it self-hides on ANY stop.
#[tauri::command]
fn region_is_recording() -> bool {
    #[cfg(windows)]
    {
        region_rec::is_recording()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Top-level windows (z-order, titled, visible) for the 录制模式 window picker.
#[cfg(windows)]
#[tauri::command]
fn list_windows() -> Vec<region_rec::WinInfo> {
    region_rec::list_windows()
}

/// #3 点对话跳窗: focus the open window matching `query`(项目名/cwd), then hide poof to reveal it.
#[tauri::command]
fn focus_window(app: tauri::AppHandle, query: String) -> bool {
    #[cfg(windows)]
    {
        let title = region_rec::focus_window(&query);
        if !title.is_empty() {
            use tauri::Manager;
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            return true;
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = (app, query);
        false
    }
}

#[cfg(windows)]
mod hook {
    use super::log_line;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    };

    /// What the hook asks the UI thread to do.
    pub enum Sig {
        Snap,  // Ctrl+Alt+A → 截图
        Notes, // Ctrl+Alt+N → 全屏笔记
        Diag,  // Ctrl+Alt+S → 全量诊断快照(纯 Rust 跑, 不依赖前端)
        CtrlTap, // one clean Ctrl tap; the rx loop times taps → 2=快捷菜单(min others) / 3=+all floats
    }

    static SNAP_DOWN: AtomicBool = AtomicBool::new(false); // de-dupe Ctrl+Alt+A auto-repeat
    static NOTES_DOWN: AtomicBool = AtomicBool::new(false); // de-dupe Ctrl+Alt+N auto-repeat
    static DIAG_DOWN: AtomicBool = AtomicBool::new(false); // de-dupe Ctrl+Alt+S auto-repeat
    // clean-Ctrl-tap state: a "tap" = Ctrl down→up with NO other key pressed in between.
    static CTRL_HELD: AtomicBool = AtomicBool::new(false);
    static DIRTY: AtomicBool = AtomicBool::new(false); // another key was pressed during this Ctrl hold
    pub static TX: OnceLock<Sender<Sig>> = OnceLock::new();

    const WM_KEYDOWN: usize = 0x0100;
    const WM_KEYUP: usize = 0x0101;
    const WM_SYSKEYDOWN: usize = 0x0104;
    const WM_SYSKEYUP: usize = 0x0105;
    const VK_CONTROL: i32 = 0x11; // generic Ctrl, for GetAsyncKeyState
    const VK_MENU_STATE: i32 = 0x12; // generic Alt, for GetAsyncKeyState
    const VK_LCONTROL: u32 = 0xA2;
    const VK_RCONTROL: u32 = 0xA3;
    const VK_A: u32 = 0x41;
    const VK_N: u32 = 0x4E;
    const VK_S: u32 = 0x53; // Ctrl+Alt+S → 诊断快照(避开 Windows 放大镜占用的 Ctrl+Alt+D)

    #[inline]
    fn is_ctrl(vk: u32) -> bool {
        vk == VK_LCONTROL || vk == VK_RCONTROL
    }
    #[inline]
    unsafe fn held(vk: i32) -> bool {
        (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            let vk = kb.vkCode;
            let down = wparam == WM_KEYDOWN || wparam == WM_SYSKEYDOWN;
            let up = wparam == WM_KEYUP || wparam == WM_SYSKEYUP;

            // Ctrl+Alt+A → 截图. Swallow the 'A' so it isn't typed.
            if down && vk == VK_A && held(VK_CONTROL) && held(VK_MENU_STATE) {
                if !SNAP_DOWN.swap(true, Ordering::SeqCst) {
                    if let Some(tx) = TX.get() { let _ = tx.send(Sig::Snap); }
                }
                return 1;
            }
            if up && vk == VK_A { SNAP_DOWN.store(false, Ordering::SeqCst); }

            // Ctrl+Alt+N → 全屏笔记. Swallow the 'N'.
            if down && vk == VK_N && held(VK_CONTROL) && held(VK_MENU_STATE) {
                if !NOTES_DOWN.swap(true, Ordering::SeqCst) {
                    if let Some(tx) = TX.get() { let _ = tx.send(Sig::Notes); }
                }
                return 1;
            }
            if up && vk == VK_N { NOTES_DOWN.store(false, Ordering::SeqCst); }

            // Ctrl+Alt+S → 全量诊断快照. Swallow the 'S'.
            // ⚠ 钩子回调里绝不做文件 I/O/加锁等慢操作 —— 低级键盘钩子超时(LowLevelHooksTimeout)会被系统
            // 直接跳过这次按键。只发个信号(channel send 不阻塞), 重活都在别的线程。
            if down && vk == VK_S && held(VK_CONTROL) && held(VK_MENU_STATE) {
                if !DIAG_DOWN.swap(true, Ordering::SeqCst) {
                    if let Some(tx) = TX.get() { let _ = tx.send(Sig::Diag); }
                }
                return 1;
            }
            if up && vk == VK_S { DIAG_DOWN.store(false, Ordering::SeqCst); }

            // clean Ctrl-tap detection (double/triple-tap Ctrl = 召出快捷菜单). A Ctrl press is only
            // a "tap" if no other key was pressed while it was held — so Ctrl+C, Ctrl+Alt+A etc. don't count.
            if down {
                if is_ctrl(vk) {
                    if !CTRL_HELD.swap(true, Ordering::SeqCst) { DIRTY.store(false, Ordering::SeqCst); }
                } else {
                    DIRTY.store(true, Ordering::SeqCst);
                }
            } else if up && is_ctrl(vk) {
                CTRL_HELD.store(false, Ordering::SeqCst);
                if !DIRTY.load(Ordering::SeqCst) {
                    if let Some(tx) = TX.get() { let _ = tx.send(Sig::CtrlTap); }
                }
            }
        }
        CallNextHookEx(0, code, wparam, lparam)
    }

    pub fn install() {
        std::thread::spawn(|| unsafe {
            // 钩子线程拉到最高优先级: poof 悬浮层开着时 webview(BlockSuite 等)可能吃满 CPU, 把这个
            // 同进程的钩子线程饿着 → 回调超过 LowLevelHooksTimeout 被系统跳过 = "开着就没反应"。
            // 这个线程只做 GetMessage + 极快的回调, 高优先级很安全。
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
            let hmod = GetModuleHandleW(core::ptr::null());
            let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
            if h == 0 {
                log_line("ERROR SetWindowsHookExW failed (EDR may block low-level keyboard hook)");
                return;
            }
            log_line("hook installed ok (2xCtrl 菜单 · 3xCtrl 菜单+悬浮窗 · Ctrl+Alt+A 截图 · Ctrl+Alt+N 笔记 · Ctrl+Alt+S 诊断快照)");
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

/// Copy text to the clipboard (the "复制" dispatch). Uses arboard (Unicode-safe).
/// 旧实现走 `cmd /C clip`, 把 UTF-8 中文按系统 GBK 解 → 乱码(测试 → 娴嬭瘯). arboard 用
/// CF_UNICODETEXT, 中文路径不丢。
#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
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
/// Make a window invisible to screen capture (DXGI/WGC) while still visible on the monitor.
/// Needs Win10 2004+ (this box is 19045). Used for the 截图 overlay + the 录制条.
#[cfg(windows)]
fn exclude_from_capture(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity;
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
    if let Ok(h) = window.hwnd() {
        unsafe {
            SetWindowDisplayAffinity(h.0 as isize, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

// 连续弹提示时用代号防止"上一条的收起定时器把下一条提早收掉"。
static TOAST_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 小提示窗: 底部居中弹一条文字约 1.8s 再收起, 不抢焦点、无声。诊断完成等场景用 —— 哪怕 poof
/// 主界面藏着也能看见(独立小窗, 不依赖 main 可见)。所有窗口操作都回主线程做: Tauri 的 show()/emit
/// 从后台线程调不生效(录制条能用就因为它在主线程)。show() 让 Tauri 认定可见 → emit 才送得到 webview。
#[cfg(windows)]
pub(crate) fn show_toast(app: &tauri::AppHandle, text: &str) {
    use std::sync::atomic::Ordering;
    let gen = TOAST_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let text = text.to_string();
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::{Manager, PhysicalPosition, PhysicalSize};
        let Some(win) = app_for_main.get_webview_window("toast") else {
            return;
        };
        let (mx, my, mw, mh, scale) = if let Ok(Some(m)) = win.primary_monitor() {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width as i32, s.height as i32, m.scale_factor())
        } else {
            (0, 0, 1920, 1080, 1.0)
        };
        let tw = (340.0 * scale) as i32;
        let th = (52.0 * scale) as i32;
        let tx = mx + (mw - tw) / 2;
        let ty = my + mh - th - (110.0 * scale) as i32; // 离屏幕底边约 110px
        let _ = win.set_size(PhysicalSize::new(tw.max(1) as u32, th.max(1) as u32));
        let _ = win.set_position(PhysicalPosition::new(tx, ty));
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        // 文字直接 eval 调 webview 里的 __showToast(事件系统送不到这个独立小窗, eval 最稳)。
        let arg = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".into());
        let _ = win.eval(&format!("window.__showToast && window.__showToast({arg})"));
        // 自动收起
        let app2 = app_for_main.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1850));
            if TOAST_GEN.load(Ordering::SeqCst) == gen {
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    if let Some(w) = app3.get_webview_window("toast") {
                        let _ = w.hide();
                    }
                });
            }
        });
    });
}
#[cfg(not(windows))]
pub(crate) fn show_toast(_app: &tauri::AppHandle, _text: &str) {}

/// The "floating" windows = everything except the main overlay + the transient capture tools.
#[cfg(windows)]
fn float_windows(app: &tauri::AppHandle) -> Vec<tauri::WebviewWindow> {
    use tauri::Manager;
    app.webview_windows()
        .into_iter()
        .filter(|(l, _)| !matches!(l.as_str(), "main" | "snap" | "recbar"))
        .map(|(_, w)| w)
        .collect()
}

/// 把主悬浮层重新贴合到它当前所在的显示器(尺寸+位置)。窗口尺寸只在启动时设过一次,
/// 用户改分辨率/缩放后会过时 —— 每次召出前调一次, 保证覆盖整屏、动作栏不溢出、整体居中。
#[cfg(windows)]
fn fit_main(main: &tauri::WebviewWindow) {
    let mon = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten());
    if let Some(mon) = mon {
        let sz = mon.size();
        let pos = mon.position();
        let _ = main.set_size(tauri::PhysicalSize::new(sz.width, sz.height));
        let _ = main.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
    }
}

/// 双击 Ctrl → show 快捷菜单+搜索 (main overlay), minimizing the other floating windows. 三击 Ctrl
/// (restore_floats=true) → show main AND bring back every floating window.
#[cfg(windows)]
fn summon_main(app: &tauri::AppHandle, restore_floats: bool) {
    use tauri::{Emitter, Manager};
    let Some(main) = app.get_webview_window("main") else { return };
    if main.is_visible().unwrap_or(false) && !restore_floats {
        let _ = main.hide(); // double-tap while it's already up → tuck it away
        return;
    }
    let _ = main.unminimize();
    fit_main(&main); // 改分辨率/缩放后窗口尺寸会过时, 召出前重新贴合
    let _ = main.show();
    let _ = main.set_always_on_top(true);
    let _ = main.set_focus();
    // payload = full?  双击Ctrl(false) → 干净搜索(收起侧栏面板);三击Ctrl(true) → 还原面板
    let _ = app.emit("summon", restore_floats);
    // ONLY touch floats that are actually open. A hidden/never-shown window must be left hidden —
    // calling minimize() on it would surface it (the 录屏 demo window kept popping up this way).
    for w in float_windows(app) {
        let visible = w.is_visible().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        if restore_floats {
            if visible && minimized {
                let _ = w.unminimize();
                let _ = w.show();
            }
        } else if visible && !minimized {
            let _ = w.minimize();
        }
    }
}

/// Ctrl+Alt+N → show the main overlay and open the fullscreen 笔记 workspace.
#[cfg(windows)]
fn open_notes(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        fit_main(&main);
        let _ = main.show();
        let _ = main.set_always_on_top(true);
        let _ = main.set_focus();
        let _ = app.emit("summon", true); // notes 召出不收起面板
        let _ = app.emit("open-notes", ());
    }
}

// 截图收起了 main → 关 snap 时放回来(poof 已抓进冻结帧, 收起只为让 snap 稳定成为唯一覆盖层)。
#[cfg(windows)]
static RESTORE_MAIN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn summon_snap(app: &tauri::AppHandle, record: bool) {
    // 「先抓帧、后显示覆盖层」: GDI 抓帧放后台线程(主线程抓 GDI 要 ~200ms 会卡; GDI 在裸线程是线程安全的,
    // --test-snap-pipeline 实测不崩不死锁)。抓帧此刻 main 仍可见 → poof 自己被抓进画面(用户要的"含自己")。
    // 抓完回主线程 present: 收起 main(它已进冻结帧)→ snap 成为【唯一】覆盖层 → 必可见。这修掉了
    // "开着 poof 时按快捷键 snap 被压在 main 之后 = 没反应"(降级 main 不够, z 序不稳; 收起才彻底)。
    log_line(&format!("[snap] summon_snap enter record={record}"));
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = crate::snap_cmd::prime_capture(); // GDI 抓帧(off-main, main 可见 → 含 poof)
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || present_snap_overlay(&app2, record));
    });
}

#[cfg(windows)]
fn present_snap_overlay(app: &tauri::AppHandle, record: bool) {
    use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
    let Some(snap) = app.get_webview_window("snap") else {
        log_line("[snap] NO 'snap' window — abort");
        return;
    };
    if let Ok(Some(m)) = snap.primary_monitor() {
        let p = m.position();
        let s = m.size();
        let _ = snap.set_position(PhysicalPosition::new(p.x, p.y));
        let _ = snap.set_size(PhysicalSize::new(s.width, s.height));
    }
    // 收起 main(截图与录制都收): snap 成唯一覆盖层 = 必可见。截图关闭时恢复 main; 录制不恢复。
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            if !record {
                RESTORE_MAIN.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let _ = main.hide();
        }
    }
    let r = snap.show();
    let _ = snap.set_always_on_top(true);
    let _ = snap.set_focus();
    let _ = snap.emit("snap-summon", record);
    log_line(&format!("[snap] present: snap.show()={:?}, emitted snap-summon", r.is_ok()));
}
#[cfg(windows)]
#[tauri::command]
fn show_snap(app: tauri::AppHandle) -> Result<(), String> {
    summon_snap(&app, false);
    Ok(())
}
/// 录屏入口(低频,不设热键,走快捷面板按钮): summon the snap overlay in 录制模式.
#[cfg(windows)]
#[tauri::command]
fn show_snap_record(app: tauri::AppHandle) -> Result<(), String> {
    summon_snap(&app, true);
    Ok(())
}
#[cfg(not(windows))]
#[tauri::command]
fn show_snap_record() -> Result<(), String> {
    Err("windows only".into())
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
fn close_snap(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    let _ = window.hide();
    // 截图收起过 main → 放回来(poof 回到原样)。录制不恢复(录制中桌面保持干净)。
    if RESTORE_MAIN.swap(false, std::sync::atomic::Ordering::SeqCst) {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_always_on_top(true);
            let _ = main.set_focus();
        }
    }
    Ok(())
}
#[cfg(not(windows))]
#[tauri::command]
fn show_snap() -> Result<(), String> {
    Err("windows only".into())
}

/// Open 回放 (replay) window; "replay-summon" tells replay.ts to refresh the session list.
#[cfg(windows)]
#[tauri::command]
fn show_replay(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if let Some(w) = app.get_webview_window("replay") {
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        let _ = w.emit("replay-summon", ());
    }
    Ok(())
}
#[cfg(not(windows))]
#[tauri::command]
fn show_replay() -> Result<(), String> {
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
    // 截图自检: poof.exe --test-capture → 抓一帧报亮度/存 PNG 后退出(验证抓帧不黑屏, 不用按热键)。
    #[cfg(windows)]
    if std::env::args().any(|a| a == "--test-capture") {
        snap_cmd::test_capture();
        std::process::exit(0);
    }
    // 截图管线自检: poof.exe --test-snap-pipeline → 后台线程抓帧(死锁根因)计时+验非黑后退出。
    #[cfg(windows)]
    if std::env::args().any(|a| a == "--test-snap-pipeline") {
        snap_cmd::test_snap_pipeline();
        std::process::exit(0);
    }
    // 性能基准: poof.exe --bench-search → 逐字拼音搜索计时后退出(在单实例/Builder 之前, 不被单实例拦)。
    if std::env::args().any(|a| a == "--bench-search") {
        search::bench_search();
        std::process::exit(0);
    }
    // 全套日志: 把 panic(含位置 + 回溯)落进同一条时间线 —— 后台线程(OCR/轮询/键盘钩子)
    // 的 panic 平时会被 unwind 静默吞掉, 这里强制记下来。原生崩溃(访问越界)抓不到, 但配合
    // JS 侧 log_js + tauri dev 的 poof-dev.log, 三路日志足以定位绝大多数崩溃。
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log_line(&format!("[PANIC] {info}\n{bt}"));
        prev_hook(info);
    }));
    // single-instance enforces "never two poofs" — but ONLY in release. Under `tauri dev` the watcher
    // rebuilds and relaunches poof on every code change; with single-instance active, the freshly-built
    // instance sees the still-dying old instance's lock, defers to it, and exits — the watcher reads that
    // as "app exited" and tears the whole dev session down (no more auto-rebuild). Gating it to release
    // lets the dev relaunch always win; the daily summon is the global hotkey, not a 2nd exe launch, so
    // debug loses nothing. (Companion to the GUI-subsystem fix in main.rs: together they stop the dev
    // session dying — no console window to close, and no lock to defeat the relaunch.)
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(windows)]
                fit_main(&w);
                let _ = w.show();
                let _ = w.set_focus();
                let _ = tauri::Emitter::emit(app, "summon", ());
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(record_cmd::RecState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // warm the file-search index: load persisted instantly, then refresh in bg
            std::thread::spawn(|| search::warm_start());
            // warm the file-tag store (path→tags) so the first keystroke already weights tags
            std::thread::spawn(|| tags::warm());
            // P2: localhost HTTP collector for the 录像 extensions (own thread, blocking accept).
            std::thread::spawn(|| http_rec::start_http_server());
            // 剪贴板历史: 后台监听系统剪贴板, 把每次变更持久化(供快选内容管理界面)。
            clipclip::start_monitor();
            #[cfg(windows)]
            {
                // Fullscreen overlay: cover the whole monitor (taskbar included).
                if let Some(w) = app.get_webview_window("main") {
                    fit_main(&w);
                }
                // Exclude only the 录屏 rec bar from capture (it's visible during recording and must
                // not appear in the recorded frames). The snap overlay is NO LONGER excluded: an
                // excluded fullscreen window made the GDI/xcap grab come back BLACK; its toolbar is
                // hidden by snap.ts clearForCapture before the grab, so it's fully transparent then.
                for label in ["recbar"] {
                    if let Some(w) = app.get_webview_window(label) {
                        exclude_from_capture(&w);
                    }
                }
                // 小提示窗: 启动就 show 一次(让 Tauri 认定它"可见", 否则 emit 的事件送不到 webview),
                // 但停在屏幕外 = 看不见。之后只靠"移进屏幕 / 移出屏幕"来显示和收起, 不再 show/hide ——
                // 既不抢焦点, emit 也始终送得到。鼠标穿透一次设好。
                if let Some(w) = app.get_webview_window("toast") {
                    let _ = w.set_ignore_cursor_events(true); // 鼠标穿透, 一次设好
                }
                // replay: a close (titlebar X / Alt+F4) HIDES instead of destroying, so it stays
                // re-summonable.
                if let Some(w) = app.get_webview_window("replay") {
                    let wc = w.clone();
                    w.on_window_event(move |e| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                            api.prevent_close();
                            let _ = wc.hide();
                        }
                    });
                }
                let (tx, rx) = channel::<hook::Sig>();
                let _ = hook::TX.set(tx);
                hook::install();
                // Ctrl-tap accumulator: count clean Ctrl taps, then after a short quiet window decide
                // 2=快捷菜单(min other floats) / 3=快捷菜单+所有悬浮窗. Snap/Notes fire immediately.
                std::thread::spawn(move || {
                    use std::sync::mpsc::RecvTimeoutError;
                    let mut taps: u32 = 0;
                    loop {
                        match rx.recv_timeout(std::time::Duration::from_millis(340)) {
                            Ok(hook::Sig::Snap) => { log_line("[snap] rx Sig::Snap → summon_snap"); let h = handle.clone(); let _ = handle.run_on_main_thread(move || summon_snap(&h, false)); }
                            Ok(hook::Sig::Notes) => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || open_notes(&h)); }
                            Ok(hook::Sig::Diag) => {
                                // 纯 Rust 截图写报告(后台线程, 不依赖前端 → poof 隐藏/卡死也能出快照)。
                                // 完成后由 capture_diag 自己弹小提示窗(不抢焦点、无声)。
                                log_line("[acc] Sig::Diag received → do_diagnostic");
                                let h = handle.clone();
                                std::thread::spawn(move || {
                                    let _ = diagnostic::do_diagnostic(&h);
                                });
                            }
                            Ok(hook::Sig::CtrlTap) => {
                                taps += 1;
                                if taps >= 3 {
                                    taps = 0;
                                    let h = handle.clone();
                                    let _ = handle.run_on_main_thread(move || summon_main(&h, true));
                                }
                            }
                            Err(RecvTimeoutError::Timeout) => {
                                if taps == 2 {
                                    let h = handle.clone();
                                    let _ = handle.run_on_main_thread(move || summon_main(&h, false));
                                }
                                taps = 0;
                            }
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                });
            }
            log_line("app started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_js,
            run_shell,
            ask_ai,
            copy_text,
            notebridge::nb_pending,
            notebridge::nb_respond,
            open_view,
            new_chat,
            take_chat_intents,
            shell_props,
            start_inspect,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fileio::read_file_text,
            fileio::write_file_text,
            fileio::read_file_b64,
            notesstore::notes_root,
            notesstore::notes_doc_get,
            notesstore::notes_doc_put,
            notesstore::notes_doc_del,
            notesstore::notes_doc_keys,
            notesstore::notes_blob_get,
            notesstore::notes_blob_put,
            notesstore::notes_blob_del,
            notesstore::notes_blob_keys,
            notesstore::notes_md_put,
            notesstore::notes_md_del,
            notesstore::notes_index_put,
            notesstore::notes_version_put,
            notesstore::notes_version_all,
            notesstore::notes_version_del_one,
            notesstore::notes_version_del_all,
            search::search,
            search::search_reindex,
            search::open_path,
            search::reveal_path,
            search::set_override,
            search::get_override,
            search::list_overrides,
            search::toggle_important_folder,
            search::is_important_folder,
            search::recent_top,
            tags::tag_add,
            tags::tag_remove,
            tags::tags_for,
            tags::tag_defs,
            tags::tag_files,
            tags::tag_set_def,
            tags::tag_rename,
            tags::tag_delete,
            tags::tag_orphans,
            tags::tag_reassign,
            tags::tag_rescue,
            snapshot::snapshot_region,
            show_snap,
            present_snap,
            close_snap,
            snap_cmd::capture_screen,
            snap_cmd::take_capture,
            snap_cmd::copy_image,
            snap_cmd::copy_image_file,
            snap_cmd::save_image,
            snap_cmd::list_shots,
            snap_cmd::read_image_b64,
            snap_cmd::delete_shot,
            snap_cmd::reveal_shot,
            snap_cmd::pin_image,
            snap_cmd::ocr_region,
            snap_cmd::save_markdown,
            snap_cmd::resolve_points_at,
            show_replay,
            record_cmd::record_start,
            record_cmd::record_event,
            record_cmd::record_stop,
            record_cmd::list_sessions,
            record_cmd::read_session,
            native_start,
            native_stop,
            region_record_start,
            region_record_stop,
            region_is_recording,
            list_windows,
            focus_window,
            show_snap_record,
            diagnostic::diagnostic_snapshot,
            diagnostic::list_diagnostics,
            diagnostic::delete_diagnostic,
            clipclip::clip_list,
            clipclip::clip_get,
            clipclip::clip_thumb,
            clipclip::clip_restore,
            clipclip::clip_delete,
            clipclip::clip_clear,
            fileio::list_dir
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
