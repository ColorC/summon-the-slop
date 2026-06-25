//! 剪贴板历史 —— 后台监听系统剪贴板(序列号轮询), 把每次变更的内容(文本 / 图片 / HTML)持久化到
//! ~/.poof/clipboard/(index.jsonl + <id>.txt/.png/.html), 供"快选内容管理界面"浏览/预览/恢复/删除。
//! 捕获所有剪贴板内容(不止 poof 自己复制的)。文本/图片走 arboard; HTML 走 Win32 CF_HTML。
use base64::Engine;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn clip_dir() -> PathBuf {
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join(".poof")
        .join("clipboard")
}
fn index_path() -> PathBuf {
    clip_dir().join("index.jsonl")
}

const MAX_ENTRIES: usize = 600; // 历史上限, 超了删最旧

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ClipEntry {
    pub id: String,
    pub ts_ms: u64,
    pub kind: String, // "text" | "image" | "html"
    pub preview: String,
    #[serde(default)]
    pub text_file: Option<String>,
    #[serde(default)]
    pub png_file: Option<String>,
    #[serde(default)]
    pub html_file: Option<String>,
    #[serde(default)]
    pub w: u32,
    #[serde(default)]
    pub h: u32,
}

fn read_index() -> Vec<ClipEntry> {
    let raw = std::fs::read_to_string(index_path()).unwrap_or_default();
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<ClipEntry>(l).ok())
        .collect()
}

fn rewrite_index(entries: &[ClipEntry]) -> Result<(), String> {
    std::fs::create_dir_all(clip_dir()).map_err(|e| e.to_string())?;
    let mut s = String::new();
    for e in entries {
        if let Ok(j) = serde_json::to_string(e) {
            s.push_str(&j);
            s.push('\n');
        }
    }
    std::fs::write(index_path(), s).map_err(|e| e.to_string())
}

fn append_entry(e: &ClipEntry) -> Result<(), String> {
    std::fs::create_dir_all(clip_dir()).map_err(|e| e.to_string())?;
    let j = serde_json::to_string(e).map_err(|x| x.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(index_path())
        .map_err(|x| x.to_string())?;
    writeln!(f, "{j}").map_err(|x| x.to_string())?;
    // 超上限 → 重写(删最旧 + 其内容文件)
    let all = read_index();
    if all.len() > MAX_ENTRIES {
        let drop = all.len() - MAX_ENTRIES;
        for old in &all[..drop] {
            remove_files(old);
        }
        let _ = rewrite_index(&all[drop..]);
    }
    Ok(())
}

fn remove_files(e: &ClipEntry) {
    for f in [&e.text_file, &e.png_file, &e.html_file].into_iter().flatten() {
        let _ = std::fs::remove_file(clip_dir().join(f));
    }
}

// ---- Win32 CF_HTML 读取(arboard 不支持取 HTML) ----
#[cfg(windows)]
fn read_clipboard_html() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    unsafe {
        let name: Vec<u16> = "HTML Format\0".encode_utf16().collect();
        let fmt = RegisterClipboardFormatW(name.as_ptr());
        if fmt == 0 {
            return None;
        }
        if OpenClipboard(0) == 0 {
            return None;
        }
        let h = GetClipboardData(fmt);
        let out = if h == 0 {
            None
        } else {
            let hg = h as *mut core::ffi::c_void; // HANDLE(isize) → HGLOBAL(*mut c_void)
            let p = GlobalLock(hg) as *const u8;
            if p.is_null() {
                None
            } else {
                let size = GlobalSize(hg) as usize;
                let bytes = std::slice::from_raw_parts(p, size);
                let s = String::from_utf8_lossy(bytes).into_owned();
                GlobalUnlock(hg);
                Some(extract_html_fragment(&s))
            }
        };
        CloseClipboard();
        out
    }
}
#[cfg(not(windows))]
fn read_clipboard_html() -> Option<String> {
    None
}

// CF_HTML 带头(Version/StartHTML/EndHTML/StartFragment/EndFragment 偏移)→ 取真正的 html 片段。
fn extract_html_fragment(raw: &str) -> String {
    if let (Some(a), Some(b)) = (raw.find("<!--StartFragment-->"), raw.find("<!--EndFragment-->")) {
        return raw[a + "<!--StartFragment-->".len()..b].trim().to_string();
    }
    if let Some(a) = raw.find("<html") {
        return raw[a..].to_string();
    }
    if let Some(a) = raw.find('<') {
        return raw[a..].to_string();
    }
    raw.to_string()
}

// ---- 监听 ----
static LAST_HASH: Mutex<u64> = Mutex::new(0);

fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = (h << 5).wrapping_add(h).wrapping_add(b as u64);
    }
    h
}
fn hash_bytes(b: &[u8]) -> u64 {
    let mut h: u64 = 5381;
    for &x in b.iter().step_by(7) {
        // 抽样, 大图也快
        h = (h << 5).wrapping_add(h).wrapping_add(x as u64);
    }
    h ^ (b.len() as u64)
}

fn capture_now() {
    // 图片优先(截图工具常给位图), 否则文本(+可选 HTML)
    let mut cb = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Ok(img) = cb.get_image() {
        let bytes = img.bytes.to_vec();
        let h = hash_bytes(&bytes);
        {
            let mut last = LAST_HASH.lock().unwrap();
            if *last == h {
                return;
            }
            *last = h;
        }
        // RGBA → PNG
        let (w, hgt) = (img.width as u32, img.height as u32);
        if let Some(buf) = image::RgbaImage::from_raw(w, hgt, bytes) {
            let _ = std::fs::create_dir_all(clip_dir());
            let id = now_ns().to_string();
            let fname = format!("{id}.png");
            if buf.save(clip_dir().join(&fname)).is_ok() {
                let _ = append_entry(&ClipEntry {
                    id,
                    ts_ms: now_ms(),
                    kind: "image".into(),
                    preview: format!("图片 {w}×{hgt}"),
                    text_file: None,
                    png_file: Some(fname),
                    html_file: None,
                    w,
                    h: hgt,
                });
            }
        }
        return;
    }
    if let Ok(text) = cb.get_text() {
        if text.is_empty() {
            return;
        }
        let h = hash_str(&text);
        {
            let mut last = LAST_HASH.lock().unwrap();
            if *last == h {
                return;
            }
            *last = h;
        }
        let _ = std::fs::create_dir_all(clip_dir());
        let id = now_ns().to_string();
        let tfile = format!("{id}.txt");
        let _ = std::fs::write(clip_dir().join(&tfile), text.as_bytes());
        // 同时有 HTML 的话(从浏览器/富文本复制) → 存一份, 预览可渲染
        let html = read_clipboard_html();
        let hfile = html.as_ref().map(|html| {
            let f = format!("{id}.html");
            let _ = std::fs::write(clip_dir().join(&f), html.as_bytes());
            f
        });
        let preview: String = text.chars().take(200).collect();
        let _ = append_entry(&ClipEntry {
            id,
            ts_ms: now_ms(),
            kind: if hfile.is_some() { "html".into() } else { "text".into() },
            preview: preview.replace('\n', " "),
            text_file: Some(tfile),
            png_file: None,
            html_file: hfile,
            w: 0,
            h: 0,
        });
    }
}

#[cfg(windows)]
fn clipboard_seq() -> u32 {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    unsafe { GetClipboardSequenceNumber() }
}
#[cfg(not(windows))]
fn clipboard_seq() -> u32 {
    0
}

/// 启动监听线程(setup 调一次)。序列号变了才抓内容, 便宜。
pub fn start_monitor() {
    std::thread::spawn(|| {
        let mut last_seq = clipboard_seq();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(650));
            let seq = clipboard_seq();
            if seq != last_seq {
                last_seq = seq;
                // 让出一拍, 等复制方写完
                std::thread::sleep(std::time::Duration::from_millis(60));
                capture_now();
            }
        }
    });
}

// ---- 命令 ----
#[tauri::command]
pub fn clip_list(limit: usize) -> Result<Vec<ClipEntry>, String> {
    let mut all = read_index();
    all.reverse(); // 新的在前
    if limit > 0 && all.len() > limit {
        all.truncate(limit);
    }
    Ok(all)
}

#[derive(serde::Serialize)]
pub struct ClipFull {
    pub kind: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub image_b64: Option<String>,
    pub w: u32,
    pub h: u32,
}

fn find(id: &str) -> Option<ClipEntry> {
    read_index().into_iter().find(|e| e.id == id)
}

#[tauri::command]
pub fn clip_get(id: String) -> Result<ClipFull, String> {
    let e = find(&id).ok_or("没找到这条")?;
    let text = e
        .text_file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(clip_dir().join(f)).ok());
    let html = e
        .html_file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(clip_dir().join(f)).ok());
    let image_b64 = e.png_file.as_ref().and_then(|f| {
        std::fs::read(clip_dir().join(f)).ok().map(|b| {
            format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&b))
        })
    });
    Ok(ClipFull { kind: e.kind, text, html, image_b64, w: e.w, h: e.h })
}

/// 图片缩略图(网格用)。
#[tauri::command]
pub fn clip_thumb(id: String) -> Result<String, String> {
    let e = find(&id).ok_or("没找到这条")?;
    let f = e.png_file.ok_or("不是图片")?;
    let img = image::open(clip_dir().join(f)).map_err(|x| x.to_string())?;
    let thumb = img.thumbnail(360, 360);
    let mut png = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|x| x.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

/// 恢复到系统剪贴板。
#[tauri::command]
pub fn clip_restore(id: String) -> Result<(), String> {
    let e = find(&id).ok_or("没找到这条")?;
    let mut cb = arboard::Clipboard::new().map_err(|x| x.to_string())?;
    if let Some(f) = &e.png_file {
        let img = image::open(clip_dir().join(f)).map_err(|x| x.to_string())?.to_rgba8();
        let (w, h) = img.dimensions();
        let data = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(img.into_raw()),
        };
        // 恢复操作本身会触发监听; 先把 hash 设成它, 避免重复记一条
        cb.set_image(data).map_err(|x| x.to_string())
    } else if let Some(f) = &e.text_file {
        let t = std::fs::read_to_string(clip_dir().join(f)).map_err(|x| x.to_string())?;
        cb.set_text(t).map_err(|x| x.to_string())
    } else {
        Err("这条没有可恢复内容".into())
    }
}

#[tauri::command]
pub fn clip_delete(id: String) -> Result<(), String> {
    let all = read_index();
    let mut kept = Vec::with_capacity(all.len());
    for e in all {
        if e.id == id {
            remove_files(&e);
        } else {
            kept.push(e);
        }
    }
    rewrite_index(&kept)
}

#[tauri::command]
pub fn clip_clear() -> Result<(), String> {
    for e in read_index() {
        remove_files(&e);
    }
    let _ = std::fs::remove_file(index_path());
    Ok(())
}
