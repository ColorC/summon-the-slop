// 笔记里「活文件块」的磁盘读写。纯 std::fs(不派生子进程 → EDR 不拦)。
//  · read_file_text  : 文本类(md/json/yaml/csv/代码/html)读进来当可编辑块
//  · write_file_text : 在笔记里改了 → 防抖写回源文件(用户要的"改了保存源文件也变")
//  · read_file_b64   : 图片/PDF 等二进制读成 base64 → 塞进 blob 仓做内嵌预览(只读)
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;

const MAX_TEXT: u64 = 4 * 1024 * 1024; // 4MB: 再大就不该当文本块编辑了
const MAX_BIN: u64 = 32 * 1024 * 1024; // 32MB: 内嵌预览的上限, 超了让前端给个"文件卡+点开"

fn file_too_big(path: &str, cap: u64) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat 失败: {e}"))?;
    if meta.len() > cap {
        return Err(format!("文件过大({} 字节 > {cap})", meta.len()));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ts_ms: u64,
    pub size: u64,
    pub ext: String,
}

/// 列一个目录(给内容管理界面浏览 omni/poof 的快照/捕获目录)。新的在前。不递归。
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&path) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for ent in rd.flatten() {
        let p = ent.path();
        let md = ent.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let ts_ms = md
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        out.push(DirEntry {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            ts_ms,
            size,
            ext,
        });
    }
    out.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(out)
}

/// 读文本(宽容解码: 非法 UTF-8 字节用替换符, 不报错 —— 让用户至少能看到内容)。
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    file_too_big(&path, MAX_TEXT)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    // 去掉 UTF-8 BOM, 否则写回时会越攒越多
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// 写回源文件。先写同目录临时文件再 rename(NTFS 上原子), 中途崩了也不会把源文件截半。
#[tauri::command]
pub fn write_file_text(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    let dir = p.parent().ok_or_else(|| "路径无父目录".to_string())?;
    let tmp = dir.join(format!(
        ".{}.overlay-shell.tmp",
        p.file_name().and_then(|s| s.to_str()).unwrap_or("note")
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写临时文件失败: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换源文件失败: {e}")
    })?;
    Ok(())
}

/// 读二进制为 base64(图片/PDF 内嵌预览用)。返回 base64 字符串, 前端拼成 data:/Blob。
#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    file_too_big(&path, MAX_BIN)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    Ok(STANDARD.encode(bytes))
}
