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

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(png)
}

/// Draw a `thick`-px rectangle border on the image (used to box the selected element).
fn draw_rect(img: &mut image::RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32, color: [u8; 4], thick: i32) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let col = image::Rgba(color);
    for d in 0..thick {
        let mut xa = x0.max(0);
        while xa <= (x1.min(w - 1)) {
            for yy in [y0 + d, y1 - d] {
                if yy >= 0 && yy < h {
                    img.put_pixel(xa as u32, yy as u32, col);
                }
            }
            xa += 1;
        }
        let mut ya = y0.max(0);
        while ya <= (y1.min(h - 1)) {
            for xx in [x0 + d, x1 - d] {
                if xx >= 0 && xx < w {
                    img.put_pixel(xx as u32, ya as u32, col);
                }
            }
            ya += 1;
        }
    }
}

/// (process name, full exe path) for a pid.
fn process_info(pid: i32) -> (String, String) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return (String::new(), String::new());
    }
    unsafe {
        let h = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) {
            Ok(h) => h,
            Err(_) => return (String::new(), String::new()),
        };
        let mut buf = [0u16; 520];
        let mut size = buf.len() as u32;
        let path = if QueryFullProcessImageNameW(h, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut size).is_ok() {
            String::from_utf16_lossy(&buf[..size as usize])
        } else {
            String::new()
        };
        let _ = CloseHandle(h);
        let name = path.rsplit(['\\', '/']).next().unwrap_or("").to_string();
        (name, path)
    }
}

/// (top-level window title, class) under a screen point.
fn window_info(x: i32, y: i32) -> (String, String) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetWindowTextW, WindowFromPoint, GA_ROOT,
    };
    unsafe {
        let h0 = WindowFromPoint(POINT { x, y });
        if h0.0.is_null() {
            return (String::new(), String::new());
        }
        let h = GetAncestor(h0, GA_ROOT);
        let mut t = [0u16; 512];
        let n = GetWindowTextW(h, &mut t);
        let title = String::from_utf16_lossy(&t[..n.max(0) as usize]);
        let mut c = [0u16; 256];
        let cn = GetClassNameW(h, &mut c);
        let class = String::from_utf16_lossy(&c[..cn.max(0) as usize]);
        (title, class)
    }
}

/// Truncate to n chars with an ellipsis.
fn short(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{t}…")
    } else {
        t
    }
}

/// Make a string safe + compact for a filename.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if "\\/:*?\"<>|\r\n\t".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// A CJK-capable system font for caption rendering (Microsoft YaHei / SimSun / Segoe).
fn load_font() -> Option<ab_glyph::FontVec> {
    for p in [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "C:\\Windows\\Fonts\\msyh.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
    ] {
        if let Ok(data) = std::fs::read(p) {
            if let Ok(f) = ab_glyph::FontVec::try_from_vec_and_index(data, 0) {
                return Some(f);
            }
        }
    }
    None
}

/// Stack the screenshot on top of a dark caption panel rendering the info lines.
fn compose_caption(shot: &image::RgbaImage, lines: &[String]) -> image::RgbaImage {
    use imageproc::drawing::draw_text_mut;
    let (pad, lh) = (12i32, 26i32);
    let scale = ab_glyph::PxScale::from(18.0);
    let cap_h = pad * 2 + lh * lines.len() as i32;
    let w = shot.width().max(640);
    let h = shot.height() as i32 + cap_h;
    let mut out = image::RgbaImage::from_pixel(w, h as u32, image::Rgba([20, 18, 16, 255]));
    image::imageops::overlay(&mut out, shot, 0, 0);
    if let Some(font) = load_font() {
        let mut y = shot.height() as i32 + pad;
        for ln in lines {
            draw_text_mut(&mut out, image::Rgba([231, 233, 238, 255]), pad, y, scale, &font, ln);
            y += lh;
        }
    }
    out
}

/// On grab: build ONE self-contained PNG — a higher-level context screenshot with the
/// selected element boxed in blue, plus a caption panel rendering the key info (element /
/// process / window / UIA path / OCR). The filename says what was grabbed (kept short).
/// Clipboard gets that short title + the path, so you hand the single image to an AI.
fn grab(auto: &uiautomation::UIAutomation, x: i32, y: i32, e: &crate::uia::ElementInfo) -> Result<String, String> {
    let (rgba, sw, sh, mx, my, _scale) = crate::capture::capture_primary_raw()?;
    let full = image::RgbaImage::from_raw(sw, sh, rgba).ok_or("frame build failed")?;

    let (el, et, er, eb) = (e.rect[0], e.rect[1], e.rect[2], e.rect[3]);
    let (ew, eh) = (er - el, eb - et);
    // context margin around the element, clamped to the monitor
    let mxn = (ew / 2).clamp(60, 360);
    let myn = (eh / 2).clamp(60, 280);
    let rl = (el - mxn - mx).clamp(0, sw as i32);
    let rt = (et - myn - my).clamp(0, sh as i32);
    let rr = (er + mxn - mx).clamp(0, sw as i32);
    let rb = (eb + myn - my).clamp(0, sh as i32);
    let (cw, ch) = ((rr - rl).max(1) as u32, (rb - rt).max(1) as u32);
    let mut crop = image::imageops::crop_imm(&full, rl as u32, rt as u32, cw, ch).to_image();
    // blue box around the exact element within the context crop
    draw_rect(&mut crop, el - mx - rl, et - my - rt, er - mx - rl, eb - my - rt, [74, 163, 255, 255], 3);

    // gather context
    let (proc_name, proc_path) = process_info(e.pid);
    let (win_title, _win_class) = window_info(x, y);
    let chain = crate::uia::ancestry(auto, x, y);

    // OCR the exact element region when it exposes no readable name/value
    let mut ocr_text = String::new();
    if e.name.trim().is_empty() && e.value.trim().is_empty() {
        let cl = (el - mx).clamp(0, sw as i32);
        let ct = (et - my).clamp(0, sh as i32);
        let ecw = (er - el).clamp(1, sw as i32 - cl) as u32;
        let ech = (eb - et).clamp(1, sh as i32 - ct) as u32;
        let esub = image::imageops::crop_imm(&full, cl as u32, ct as u32, ecw, ech).to_image();
        if let Ok(epng) = encode_png(&esub) {
            if let Ok(t) = crate::ocr::ocr_png(&epng) {
                ocr_text = t.trim().to_string();
            }
        }
    }

    // compact caption lines (truncated so nothing runs long)
    let nm = e.name.trim();
    let path_str: String = chain
        .iter()
        .map(|(c, n)| if n.trim().is_empty() { c.clone() } else { format!("{c}「{}」", short(n.trim(), 10)) })
        .collect::<Vec<_>>()
        .join(" ▸ ");
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("[{}] {}", e.control_type, if nm.is_empty() { "(无名)".to_string() } else { short(nm, 40) }));
    if !e.value.trim().is_empty() {
        lines.push(format!("值: {}", short(e.value.trim(), 52)));
    }
    lines.push(format!("进程: {} (pid {})", if proc_name.is_empty() { "?".to_string() } else { proc_name.clone() }, e.pid));
    if !win_title.is_empty() {
        lines.push(format!("窗口: {}", short(&win_title, 46)));
    }
    if !path_str.is_empty() {
        lines.push(format!("路径: {}", short(&path_str, 72)));
    }
    if !proc_path.is_empty() {
        lines.push(format!("exe: {}", short(&proc_path, 64)));
    }
    if !ocr_text.is_empty() {
        lines.push(format!("OCR: {}", short(&ocr_text.replace('\n', " "), 72)));
    }

    // one captioned PNG, descriptively + concisely named
    let out = compose_caption(&crop, &lines);
    let name_tag = if nm.is_empty() { String::new() } else { format!("-{}", sanitize(&short(nm, 10))) };
    let proc_tag = if proc_name.is_empty() { String::new() } else { format!("-{}", sanitize(proc_name.trim_end_matches(".exe"))) };
    let fname = format!("{}{}{}-{:06}.png", sanitize(&e.control_type), name_tag, proc_tag, (now_nanos() % 1_000_000) as u32);
    let dir = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("Pictures")
        .join("waiela");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&fname);
    std::fs::write(&path, encode_png(&out)?).map_err(|e| e.to_string())?;

    let label = format!("{} {}", e.control_type, if nm.is_empty() { "(无名)".to_string() } else { short(nm, 16) });
    let clip = format!("选中 {label}（图含全部信息，AI 可直接读）：\n{}", path.display());
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(clip);
    }
    Ok(label)
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
                    match grab(&auto, pt.x, pt.y, &e) {
                        Ok(title) => {
                            let _ = tx.send(Cmd::Hud {
                                text: format!("✓ 已抓取「{title}」：文档+截图已生成，链接已复制到剪贴板（粘贴给 AI）"),
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
