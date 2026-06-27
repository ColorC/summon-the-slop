//! 取文件 / 应用的真实 Windows 图标 → PNG(base64 data URL)。
//!
//! 注册应用(开始菜单 .lnk)解析其目标的图标; 普通文件取系统关联图标(.xlsx→Excel、.pdf→阅读器…),
//! 文件夹取文件夹图标。链路: SHGetFileInfoW 拿 HICON → GetIconInfo 拆出彩色位图(+掩码)→ GetDIBits 读
//! 32bpp BGRA → 转 RGBA(必要时用掩码补 alpha)→ image 编 PNG → base64。
//!
//! 结果按 path 缓存(图标抽取有系统调用开销; 取不到也缓存成 None, 避免每次按键重复尝试)。前端对每条命中
//! 懒取一次, 拿到就换掉占位线框图。

use std::collections::HashMap;
use std::sync::Mutex;

static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// 取 `path` 的图标, 返回 `data:image/png;base64,...`(可直接塞进 <img src>); 取不到 → None。
#[tauri::command]
pub fn file_icon(path: String) -> Option<String> {
    {
        let mut g = CACHE.lock().unwrap();
        let map = g.get_or_insert_with(HashMap::new);
        if let Some(v) = map.get(&path) {
            return v.clone();
        }
    }
    #[cfg(windows)]
    let result = extract_png_b64(&path);
    #[cfg(not(windows))]
    let result: Option<String> = None;
    CACHE
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .insert(path, result.clone());
    result
}

#[cfg(windows)]
fn extract_png_b64(path: &str) -> Option<String> {
    use windows_sys::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
    // Shell API 只认反斜杠; 索引里的路径分隔符可能是 '/'(app_roots 用正斜杠拼)或混用 → 统一成 '\'。
    let path = path.replace('/', "\\");
    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        let r = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut shfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON, // 32×32, 前端缩到 ~16-18 仍清晰
        );
        if r == 0 || shfi.hIcon == 0 {
            return None;
        }
        let png = hicon_to_png(shfi.hIcon);
        DestroyIcon(shfi.hIcon);
        png.map(|bytes| {
            use base64::Engine;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            )
        })
    }
}

// HICON → PNG 字节。拆出彩色位图读 32bpp BGRA; 现代应用图标自带 alpha(直接用), 老式无 alpha 的用 AND
// 掩码补(掩码黑=不透明、白=透明)。失败任一步 → None, 且严格 DeleteObject/释放, 不漏 GDI 句柄。
#[cfg(windows)]
unsafe fn hicon_to_png(hicon: isize) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        return None;
    }
    let (color, mask) = (ii.hbmColor, ii.hbmMask);
    let cleanup = |c: isize, m: isize| unsafe {
        if c != 0 {
            DeleteObject(c);
        }
        if m != 0 {
            DeleteObject(m);
        }
    };

    let mut bm: BITMAP = std::mem::zeroed();
    if color == 0
        || GetObjectW(
            color,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut _ as *mut core::ffi::c_void,
        ) == 0
    {
        cleanup(color, mask);
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
        cleanup(color, mask);
        return None;
    }
    let px_count = (w * h) as usize;

    let header = || unsafe {
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // 负 = 自上而下
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB as u32;
        bi
    };

    let screen = GetDC(0);
    // 彩色位图 → BGRA
    let mut buf = vec![0u8; px_count * 4];
    let mut bi = header();
    let got = GetDIBits(
        screen,
        color,
        0,
        h as u32,
        buf.as_mut_ptr() as *mut core::ffi::c_void,
        &mut bi,
        DIB_RGB_COLORS,
    );
    if got == 0 {
        ReleaseDC(0, screen);
        cleanup(color, mask);
        return None;
    }

    // 现代图标的 alpha 直接可用; 若整张 alpha 全 0(老式 32bpp 无 alpha)→ 用掩码补。
    let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
    if !has_alpha && mask != 0 {
        let mut mbuf = vec![0u8; px_count * 4];
        let mut mbi = header();
        let mgot = GetDIBits(
            screen,
            mask,
            0,
            h as u32,
            mbuf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut mbi,
            DIB_RGB_COLORS,
        );
        if mgot != 0 {
            for (p, m) in buf.chunks_exact_mut(4).zip(mbuf.chunks_exact(4)) {
                // AND 掩码: 0(黑)=不透明, 非 0(白)=透明
                p[3] = if m[0] == 0 && m[1] == 0 && m[2] == 0 {
                    255
                } else {
                    0
                };
            }
        } else {
            for p in buf.chunks_exact_mut(4) {
                p[3] = 255; // 拿不到掩码 → 当不透明
            }
        }
    } else if !has_alpha {
        for p in buf.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    ReleaseDC(0, screen);
    cleanup(color, mask);

    // BGRA → RGBA
    for p in buf.chunks_exact_mut(4) {
        p.swap(0, 2);
    }

    let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// 自检: poof.exe --test-icon <path> → 抽该路径图标, 报尺寸/字节数, 存 %TEMP%\poof-icon-test.png。
#[cfg(windows)]
pub fn test_icon(path: &str) {
    match extract_png_b64(path) {
        Some(data_url) => {
            let b64 = data_url.strip_prefix("data:image/png;base64,").unwrap_or(&data_url);
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap_or_default();
            let out = std::env::temp_dir().join("poof-icon-test.png");
            let _ = std::fs::write(&out, &bytes);
            println!(
                "✓ 图标抽取成功: {} 字节 PNG → {}",
                bytes.len(),
                out.display()
            );
        }
        None => println!("✗ 取不到图标: {path}"),
    }
}
