//! Live inspector — the dynamic counterpart to the static screenshot. No frozen frame:
//! the real screen stays live, a bare Win32 hollow-frame highlight follows the cursor,
//! and each move asks the OS for just the one element under the pointer
//! (element_from_point, ~30ms) instead of walking the whole tree. A small Win32 HUD
//! shows basic info on hover; a click grabs the element (region image + structured text
//! to the clipboard, OCR fallback for non-accessible content). Esc exits.
//!
//! Everything is bare Win32 (no WebView2): a webview exposes its own UIA provider that
//! element_from_point returns even through click-through/holes, which would defeat the
//! whole "see the element under me" premise.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    FillRect, GetStockObject, InvalidateRect, SelectObject, SetBkMode, SetTextColor, SetWindowRgn,
    DEFAULT_GUI_FONT, DT_LEFT, DT_NOPREFIX, DT_WORDBREAK, PAINTSTRUCT, RGN_DIFF, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos,
    PeekMessageW, RegisterClassW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow,
    TranslateMessage, HWND_TOPMOST, LWA_ALPHA, MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SW_HIDE, WM_DESTROY, WM_PAINT, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const BORDER: i32 = 3;
const FRAME_COLOR: u32 = 0x00FF_A34A; // COLORREF 0x00BBGGRR == #4AA3FF
const HUD_W: i32 = 460;
const HUD_H: i32 = 84;

static INSPECT_ON: AtomicBool = AtomicBool::new(false);
static HUD_TEXT: Mutex<String> = Mutex::new(String::new());

fn ilog(m: &str) {
    use std::io::Write;
    if std::env::var("WAIELA_DEBUG").is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("waiela-inspect3.txt"))
    {
        let _ = writeln!(f, "{m}");
    }
}

pub fn is_running() -> bool {
    INSPECT_ON.load(Ordering::SeqCst)
}

pub enum Cmd {
    Highlight { l: i32, t: i32, r: i32, b: i32 },
    Hud { text: String, x: i32, y: i32 },
    Hide,
    Quit,
}

fn set_frame_rgn(hwnd: HWND, w: i32, h: i32, border: i32) {
    unsafe {
        let outer = CreateRectRgn(0, 0, w, h);
        let inner = CreateRectRgn(border, border, w - border, h - border);
        let _ = CombineRgn(Some(outer), Some(outer), Some(inner), RGN_DIFF);
        let _ = SetWindowRgn(hwnd, Some(outer), true);
    }
}

unsafe extern "system" fn frame_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_PAINT {
        ilog("frame paint");
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let brush = CreateSolidBrush(COLORREF(FRAME_COLOR));
        FillRect(hdc, &rc, brush);
        let _ = DeleteObject(brush.into());
        let _ = EndPaint(hwnd, &ps);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

unsafe extern "system" fn hud_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_PAINT {
        ilog("hud paint start");
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let bg = CreateSolidBrush(COLORREF(0x0014_1210)); // dark panel
        FillRect(hdc, &rc, bg);
        let _ = DeleteObject(bg.into());
        let text = HUD_TEXT.lock().map(|s| s.clone()).unwrap_or_default();
        if !text.is_empty() {
            let font = GetStockObject(DEFAULT_GUI_FONT);
            SelectObject(hdc, font);
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, COLORREF(0x00E7_E9EE));
            let mut wtext: Vec<u16> = text.encode_utf16().collect();
            let mut tr = RECT { left: rc.left + 12, top: rc.top + 8, right: rc.right - 12, bottom: rc.bottom - 8 };
            DrawTextW(hdc, &mut wtext, &mut tr, DT_LEFT | DT_WORDBREAK | DT_NOPREFIX);
        }
        let _ = EndPaint(hwnd, &ps);
        ilog("hud paint end");
        return LRESULT(0);
    }
    if msg == WM_DESTROY {
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn make_window(class: PCWSTR, proc: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT) -> HWND {
    unsafe {
        let hinst = GetModuleHandleW(None).expect("module");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: hinst.into(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            10,
            10,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .expect("create window");
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        hwnd
    }
}

fn window_thread(rx: Receiver<Cmd>) {
    unsafe {
        let frame = make_window(w!("waiela_frame"), frame_proc);
        let hud = make_window(w!("waiela_hud"), hud_proc);
        let _ = std::fs::write(
            std::env::temp_dir().join("waiela-inspect3.txt"),
            format!("frame=0x{:x} hud=0x{:x}\n", frame.0 as isize, hud.0 as isize),
        );
        let mut msg = MSG::default();
        let mut frame_vis = false;
        let mut hud_vis = false;
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            match rx.try_recv() {
                Ok(Cmd::Highlight { l, t, r, b }) => {
                    ilog(&format!("cmd highlight {l},{t},{r},{b}"));
                    let (ww, hh) = ((r - l).max(1), (b - t).max(1));
                    set_frame_rgn(frame, ww, hh, BORDER);
                    let flags = if frame_vis { SWP_NOACTIVATE | SWP_NOZORDER } else { SWP_NOACTIVATE | SWP_SHOWWINDOW };
                    let _ = SetWindowPos(frame, Some(HWND_TOPMOST), l, t, ww, hh, flags);
                    let _ = InvalidateRect(Some(frame), None, true);
                    frame_vis = true;
                }
                Ok(Cmd::Hud { text, mut x, mut y }) => {
                    ilog(&format!("cmd hud @{x},{y}"));
                    if let Ok(mut g) = HUD_TEXT.lock() {
                        *g = text;
                    }
                    // keep on-screen
                    if x + HUD_W > 1920 {
                        x -= HUD_W + 32;
                    }
                    if y + HUD_H > 1080 {
                        y -= HUD_H + 40;
                    }
                    let flags = if hud_vis { SWP_NOACTIVATE | SWP_NOZORDER } else { SWP_NOACTIVATE | SWP_SHOWWINDOW };
                    let _ = SetWindowPos(hud, Some(HWND_TOPMOST), x.max(0), y.max(0), HUD_W, HUD_H, flags);
                    let _ = InvalidateRect(Some(hud), None, true);
                    hud_vis = true;
                }
                Ok(Cmd::Hide) => {
                    let _ = ShowWindow(frame, SW_HIDE);
                    let _ = ShowWindow(hud, SW_HIDE);
                    frame_vis = false;
                    hud_vis = false;
                }
                Ok(Cmd::Quit) | Err(TryRecvError::Disconnected) => {
                    let _ = DestroyWindow(frame);
                    let _ = DestroyWindow(hud);
                    break;
                }
                Err(TryRecvError::Empty) => {}
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    }
}

fn spawn_windows() -> Sender<Cmd> {
    let (tx, rx) = channel::<Cmd>();
    std::thread::spawn(move || window_thread(rx));
    tx
}

fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// Capture the element's region, build structured text, copy both to the clipboard, save
/// the region PNG, and OCR the region when the element exposes no name/value.
fn grab(e: &crate::uia::ElementInfo) -> Result<(), String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;

    let (rgba, w, h, mx, my, _scale) = crate::capture::capture_primary_raw()?;
    let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("frame build failed")?;
    let l = (e.rect[0] - mx).clamp(0, w as i32);
    let t = (e.rect[1] - my).clamp(0, h as i32);
    let r = (e.rect[2] - mx).clamp(0, w as i32);
    let b = (e.rect[3] - my).clamp(0, h as i32);
    let (cw, ch) = ((r - l).max(1) as u32, (b - t).max(1) as u32);
    let sub = image::imageops::crop_imm(&img, l as u32, t as u32, cw, ch).to_image();

    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
        .write_image(sub.as_raw(), cw, ch, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;

    let name = if e.name.is_empty() { "(无名)" } else { &e.name };
    let mut text = format!("{}: {}\n", e.control_type, name);
    if !e.value.is_empty() {
        text.push_str(&format!("值: {}\n", e.value));
    }
    if !e.automation_id.is_empty() {
        text.push_str(&format!("AutomationId: {}\n", e.automation_id));
    }
    if !e.class_name.is_empty() {
        text.push_str(&format!("类名: {}\n", e.class_name));
    }
    text.push_str(&format!(
        "范围: {},{} {}x{}\npid: {}\n",
        e.rect[0], e.rect[1], e.rect[2] - e.rect[0], e.rect[3] - e.rect[1], e.pid
    ));
    if e.name.is_empty() && e.value.is_empty() {
        if let Ok(t) = crate::ocr::ocr_png(&png) {
            let t = t.trim();
            if !t.is_empty() {
                text.push_str(&format!("OCR:\n{}\n", t));
            }
        }
    }

    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text);
    }
    let dir = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("waiela");
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let _ = std::fs::write(dir.join(format!("grab-el-{ts}.png")), &png);
    Ok(())
}

/// Enter live-inspect: highlight + HUD follow the cursor, click grabs, Esc exits.
/// Runs its own loop on the calling thread; guarded so only one session runs at a time.
pub fn run_inspect(own_pid: i32) {
    if INSPECT_ON.swap(true, Ordering::SeqCst) {
        return;
    }
    let tx = spawn_windows();
    let auto = match crate::uia::make_automation() {
        Ok(a) => a,
        Err(_) => {
            let _ = tx.send(Cmd::Quit);
            INSPECT_ON.store(false, Ordering::SeqCst);
            return;
        }
    };
    let _ = tx.send(Cmd::Hud {
        text: "活体洞察：移动鼠标看元素 · 单击抓取(图+结构化信息→剪贴板) · Esc 退出".into(),
        x: 40,
        y: 40,
    });
    std::thread::sleep(Duration::from_millis(700));

    let mut last_rect = [i32::MIN; 4];
    let mut prev_lbtn = key_down(VK_LBUTTON.0 as i32); // don't fire on the click that may have summoned
    let mut flash_until = Instant::now();
    loop {
        if key_down(VK_ESCAPE.0 as i32) {
            break;
        }
        let mut pt = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        let lbtn = key_down(VK_LBUTTON.0 as i32);

        if let Ok(e) = crate::uia::element_at_with(&auto, pt.x, pt.y) {
            if e.pid != own_pid {
                if e.rect != last_rect {
                    last_rect = e.rect;
                    let _ = tx.send(Cmd::Highlight { l: e.rect[0], t: e.rect[1], r: e.rect[2], b: e.rect[3] });
                }
                if lbtn && !prev_lbtn {
                    let label = e.control_type.clone();
                    match grab(&e) {
                        Ok(()) => {
                            let _ = tx.send(Cmd::Hud {
                                text: format!("✓ 已抓取 {label}：图 + 结构化信息已复制到剪贴板（粘贴给 AI）", ),
                                x: pt.x + 16,
                                y: pt.y + 22,
                            });
                        }
                        Err(err) => {
                            let _ = tx.send(Cmd::Hud { text: format!("抓取失败：{err}"), x: pt.x + 16, y: pt.y + 22 });
                        }
                    }
                    flash_until = Instant::now() + Duration::from_millis(1400);
                } else if Instant::now() >= flash_until {
                    let nm = if e.name.is_empty() { "(无名)" } else { &e.name };
                    let info = format!(
                        "{}  {}\n范围 {}x{}    pid {}",
                        e.control_type,
                        nm,
                        e.rect[2] - e.rect[0],
                        e.rect[3] - e.rect[1],
                        e.pid
                    );
                    let _ = tx.send(Cmd::Hud { text: info, x: pt.x + 16, y: pt.y + 22 });
                }
            }
        }
        prev_lbtn = lbtn;
        std::thread::sleep(Duration::from_millis(25));
    }

    let _ = tx.send(Cmd::Quit);
    INSPECT_ON.store(false, Ordering::SeqCst);
}
