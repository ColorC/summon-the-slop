// 笔记落盘存储(工作流一): 把笔记从 WebView2 不透明 IndexedDB 搬到磁盘浅路径 ——
// 可见、可备份、可被外部 CLI 直接读。根目录 = 环境变量 `OVERLAY_NOTE_STORE_ROOT`,
// 缺省 `%LOCALAPPDATA%\overlay-shell\note-store\`(与 index/tags 同处, 不进 %TEMP% 以免被清)。
//  · docs/<id>.ydoc   每个 Yjs doc(工作区根 + 每条笔记)一份合并后的二进制快照
//  · blobs/<sha>      图片/PDF 的字节(原来是 MemoryBlobSource, 关 poof 就丢 → 现在落盘)
// 纯 std::fs(不派生子进程, EDR 不拦)。二进制走 base64 过 IPC。原子写(临时文件 + rename)。
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};

pub(crate) fn root() -> PathBuf {
    if let Ok(p) = std::env::var("OVERLAY_NOTE_STORE_ROOT") {
        let t = p.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("overlay-shell")
        .join("note-store")
}
fn docs_dir() -> PathBuf {
    root().join("docs")
}
fn blobs_dir() -> PathBuf {
    root().join("blobs")
}

// 文件名安全: id/key 只允许字母数字 . _ - = , 杜绝路径穿越(/ \ : .. 等)。
// ⚠ 必须含 '=': blob 的 sha key 是 BlobEngine 的 base64(+→- /→_ 但**保留 = 补位**, 见
// @blocksuite/global crypto.js), 形如 "A5BY...Ec-4E=" 44 字符结尾带 = —— 漏掉 = 会让所有图片/附件
// 在 notes_blob_put 时抛错(且冒泡到插图操作本身报错)。= 不构成路径分隔/穿越, 文件名合法。
fn safe(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 200
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '='))
    {
        return Err(format!("非法存储键: {name}"));
    }
    Ok(name)
}

fn ensure_dirs() -> Result<(), String> {
    std::fs::create_dir_all(docs_dir()).map_err(|e| format!("建 docs 目录失败: {e}"))?;
    std::fs::create_dir_all(blobs_dir()).map_err(|e| format!("建 blobs 目录失败: {e}"))?;
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "无父目录".to_string())?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("x")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换失败: {e}")
    })
}

fn read_b64(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(STANDARD.encode(b))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取失败: {e}")),
    }
}

fn list_keys(dir: &Path, strip_ext: Option<&str>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("列目录失败: {e}")),
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // 跳过临时文件
        }
        match strip_ext {
            Some(ext) if name.ends_with(ext) => out.push(name[..name.len() - ext.len()].to_string()),
            Some(_) => {}
            None => out.push(name),
        }
    }
    Ok(out)
}

/// 返回存储根路径(并确保 docs/ blobs/ 已建)。前端展示"数据在哪"用。
#[tauri::command]
pub fn notes_root() -> Result<String, String> {
    ensure_dirs()?;
    Ok(root().to_string_lossy().into_owned())
}

#[tauri::command]
pub fn notes_doc_get(id: String) -> Result<Option<String>, String> {
    let id = safe(&id)?;
    read_b64(&docs_dir().join(format!("{id}.ydoc")))
}

#[tauri::command]
pub fn notes_doc_put(id: String, b64: String) -> Result<(), String> {
    ensure_dirs()?;
    let id = safe(&id)?;
    let bytes = STANDARD.decode(b64).map_err(|e| format!("base64 解码失败: {e}"))?;
    atomic_write(&docs_dir().join(format!("{id}.ydoc")), &bytes)
}

#[tauri::command]
pub fn notes_doc_del(id: String) -> Result<(), String> {
    let id = safe(&id)?;
    let _ = std::fs::remove_file(docs_dir().join(format!("{id}.ydoc")));
    Ok(())
}

#[tauri::command]
pub fn notes_doc_keys() -> Result<Vec<String>, String> {
    list_keys(&docs_dir(), Some(".ydoc"))
}

#[tauri::command]
pub fn notes_blob_get(key: String) -> Result<Option<String>, String> {
    let key = safe(&key)?;
    read_b64(&blobs_dir().join(key))
}

#[tauri::command]
pub fn notes_blob_put(key: String, b64: String) -> Result<(), String> {
    ensure_dirs()?;
    let key = safe(&key)?;
    let bytes = STANDARD.decode(b64).map_err(|e| format!("base64 解码失败: {e}"))?;
    atomic_write(&blobs_dir().join(key), &bytes)
}

#[tauri::command]
pub fn notes_blob_del(key: String) -> Result<(), String> {
    let key = safe(&key)?;
    let _ = std::fs::remove_file(blobs_dir().join(key));
    Ok(())
}

#[tauri::command]
pub fn notes_blob_keys() -> Result<Vec<String>, String> {
    list_keys(&blobs_dir(), None)
}

// ---- 导出物: <id>.md(给 omni/人 读)+ index.json(id→标题/时间/标签 检索面)----
// .md 与 .ydoc 同目录同名(docs/<id>.md); index.json 在根。都是纯文本, 原子写。
#[tauri::command]
pub fn notes_md_put(id: String, content: String) -> Result<(), String> {
    ensure_dirs()?;
    let id = safe(&id)?;
    atomic_write(&docs_dir().join(format!("{id}.md")), content.as_bytes())
}

#[tauri::command]
pub fn notes_md_del(id: String) -> Result<(), String> {
    let id = safe(&id)?;
    let _ = std::fs::remove_file(docs_dir().join(format!("{id}.md")));
    Ok(())
}

#[tauri::command]
pub fn notes_index_put(json: String) -> Result<(), String> {
    ensure_dirs()?;
    atomic_write(&root().join("index.json"), json.as_bytes())
}

// ---- 版本历史: versions/<docId>/<ts>.json(每版一份 {label, b64 全量快照})----
// 搬出原来的自建 IndexedDB(poof-note-versions)。ts(毫秒时间戳, 纯数字)和 docId(guid)都过 safe()。
fn versions_dir(doc_id: &str) -> PathBuf {
    root().join("versions").join(doc_id)
}

#[derive(serde::Serialize)]
pub struct VersionEntry {
    pub ts: String,
    pub json: String,
}

#[tauri::command]
pub fn notes_version_put(doc_id: String, ts: String, json: String) -> Result<(), String> {
    let doc_id = safe(&doc_id)?;
    let ts = safe(&ts)?;
    let dir = versions_dir(doc_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 versions 目录失败: {e}"))?;
    atomic_write(&dir.join(format!("{ts}.json")), json.as_bytes())
}

/// 一把读全某 doc 的所有版本(避免逐个 IPC)。返回 [{ts, json}]。
#[tauri::command]
pub fn notes_version_all(doc_id: String) -> Result<Vec<VersionEntry>, String> {
    let doc_id = safe(&doc_id)?;
    let dir = versions_dir(doc_id);
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("列 versions 失败: {e}")),
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let ts = name[..name.len() - 5].to_string();
        if let Ok(json) = std::fs::read_to_string(ent.path()) {
            out.push(VersionEntry { ts, json });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn notes_version_del_one(doc_id: String, ts: String) -> Result<(), String> {
    let doc_id = safe(&doc_id)?;
    let ts = safe(&ts)?;
    let _ = std::fs::remove_file(versions_dir(doc_id).join(format!("{ts}.json")));
    Ok(())
}

#[tauri::command]
pub fn notes_version_del_all(doc_id: String) -> Result<(), String> {
    let doc_id = safe(&doc_id)?;
    let _ = std::fs::remove_dir_all(versions_dir(doc_id));
    Ok(())
}
