// 笔记 ops 桥 — 文件命令队列。外部 CLI(给 codex 总控用)够不着 webview 的 IndexedDB 笔记,
// 所以走文件:CLI 写 req-<id>.json, poof(前端轮询)读出、在活的 BlockSuite collection 上做
// 定向 op(search/add/delete/update/center…不整 doc 替换→不损坏笔记), 写回 res-<id>.json。
use std::fs;
use std::path::PathBuf;

fn bridge_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    let d = PathBuf::from(base).join("overlay-shell").join("notes-bridge");
    let _ = fs::create_dir_all(&d);
    d
}

/// 前端轮询: 取出所有待处理 req(并删除原文件), 返回 [(id, json_body)]。
#[tauri::command]
pub fn nb_pending() -> Vec<(String, String)> {
    let dir = bridge_dir();
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("req-") && name.ends_with(".json") {
                if let Ok(body) = fs::read_to_string(e.path()) {
                    let id = name
                        .trim_start_matches("req-")
                        .trim_end_matches(".json")
                        .to_string();
                    out.push((id, body));
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
    out
}

/// 前端把某 req 的结果写回(CLI 在轮询 res-<id>.json)。
#[tauri::command]
pub fn nb_respond(id: String, body: String) -> Result<(), String> {
    let p = bridge_dir().join(format!("res-{id}.json"));
    fs::write(p, body).map_err(|e| e.to_string())
}
