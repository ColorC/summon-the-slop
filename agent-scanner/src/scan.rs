//! 扫盘 + JSONL 解析 —— 逐字对齐 Python `import_routes._scan_claude/_scan_codex` 与尾部完成感知。

use crate::derive::clip;
use crate::model::{Managed, ScannedSession, TailStatus};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 60;
const MAX_AGE_DAYS: f64 = 90.0;
const HEAD_LINES: usize = 200;
const TAIL_BYTES: u64 = 131_072;
const TAIL_MAX_LINES: usize = 160;

fn mtime_secs(path: &Path) -> Option<f64> {
    fs::metadata(path).ok().and_then(|m| {
        m.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
    })
}

fn walk_jsonl(root: &Path, out: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            walk_jsonl(&p, out);
        } else if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(p);
        }
    }
}

/// 最近 cap 个 .jsonl(>90 天的丢),按 mtime 倒序。对齐 `_recent_files`。
pub fn recent_files(root: &Path, cap: usize, now: f64) -> Vec<(f64, PathBuf)> {
    if !root.is_dir() {
        return vec![];
    }
    let cutoff = now - MAX_AGE_DAYS * 86400.0;
    let mut paths = Vec::new();
    walk_jsonl(root, &mut paths);
    let mut files: Vec<(f64, PathBuf)> = paths
        .into_iter()
        .filter_map(|p| {
            let mt = mtime_secs(&p)?;
            if mt < cutoff {
                None
            } else {
                Some((mt, p))
            }
        })
        .collect();
    files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    files.truncate(cap);
    files
}

fn read_text_lossy(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// content(string 或 blocks)→ 首个文本。对齐 `_first_text`。
fn first_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            for blk in arr {
                if let Some(obj) = blk.as_object() {
                    let typ = obj.get("type").and_then(|v| v.as_str());
                    if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                        if typ.is_none() || typ == Some("text") {
                            return t.to_string();
                        }
                    }
                    if let Some(c) = obj.get("content").and_then(|v| v.as_str()) {
                        return c.to_string();
                    }
                } else if let Some(s) = blk.as_str() {
                    return s.to_string();
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// 看起来是内部注入(< / [OMNI] / Caveat:)。对齐 `_looks_internal`。
fn looks_internal(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('<') || t.starts_with("[OMNI]") || t.starts_with("Caveat:")
}

/// 在文件名里找 8-4-4-4-12 UUID(替代 Python `_UUID_RE`)。
fn find_uuid(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let seg = [8usize, 4, 4, 4, 12];
    let mut i = 0;
    while i + 36 <= bytes.len() {
        let mut pos = i;
        let mut ok = true;
        for (k, &len) in seg.iter().enumerate() {
            for _ in 0..len {
                if pos >= bytes.len() || !bytes[pos].is_ascii_hexdigit() {
                    ok = false;
                    break;
                }
                pos += 1;
            }
            if !ok {
                break;
            }
            if k < 4 {
                if pos >= bytes.len() || bytes[pos] != b'-' {
                    ok = false;
                    break;
                }
                pos += 1;
            }
        }
        if ok {
            return Some(name[i..i + 36].to_string());
        }
        i += 1;
    }
    None
}

/// 扫 claude:`~/.claude/projects`。session_id = 文件 stem,跳 subagents/。
pub fn scan_claude(projects_root: &Path, now: f64) -> Vec<ScannedSession> {
    let mut out = Vec::new();
    for (mtime, f) in recent_files(projects_root, MAX_FILES, now) {
        // 跳 subagents/ transcript(否则覆盖父会话)。
        if f.components().any(|c| c.as_os_str() == "subagents") {
            continue;
        }
        let mut cwd = String::new();
        let mut preview = String::new();
        if let Some(text) = read_text_lossy(&f) {
            for (i, line) in text.lines().enumerate() {
                if i > HEAD_LINES {
                    break;
                }
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let obj: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if cwd.is_empty() {
                    if let Some(c) = obj.get("cwd").and_then(|v| v.as_str()) {
                        cwd = c.to_string();
                    }
                }
                if preview.is_empty() {
                    let msg = obj.get("message");
                    let role = msg.and_then(|m| m.get("role")).and_then(|v| v.as_str());
                    let typ = obj.get("type").and_then(|v| v.as_str());
                    if role == Some("user") || typ == Some("user") {
                        let txt = first_text(msg.and_then(|m| m.get("content")));
                        if !txt.is_empty() && !looks_internal(&txt) {
                            preview = txt;
                        }
                    }
                }
                if !cwd.is_empty() && !preview.is_empty() {
                    break;
                }
            }
        }
        let session_id = f.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        out.push(ScannedSession {
            provider: "claude_code".to_string(),
            session_id,
            cwd,
            mtime,
            preview: clip(&preview, 160),
            file: f.to_string_lossy().into_owned(),
        });
    }
    out
}

fn codex_user_text(obj: &Value) -> String {
    let payload = match obj.get("payload").and_then(|v| v.as_object()) {
        Some(p) => p,
        None => return String::new(),
    };
    let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let role = payload.get("role").and_then(|v| v.as_str());
    if role == Some("user") || ptype.contains("user") {
        for k in ["content", "text", "message", "input"] {
            let txt = first_text(payload.get(k));
            if !txt.is_empty() {
                return txt;
            }
        }
    }
    String::new()
}

/// 扫 codex:`~/.codex/sessions`。session_meta.payload.id,退化文件名 UUID。
pub fn scan_codex(sessions_root: &Path, now: f64) -> Vec<ScannedSession> {
    let mut out = Vec::new();
    for (mtime, f) in recent_files(sessions_root, MAX_FILES, now) {
        let mut sid = String::new();
        let mut cwd = String::new();
        let mut preview = String::new();
        if let Some(text) = read_text_lossy(&f) {
            for (i, line) in text.lines().enumerate() {
                if i > HEAD_LINES {
                    break;
                }
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let obj: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if obj.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
                    if let Some(p) = obj.get("payload").and_then(|v| v.as_object()) {
                        if sid.is_empty() {
                            sid = p
                                .get("id")
                                .or_else(|| p.get("conversation_id"))
                                .or_else(|| p.get("session_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                        }
                        if cwd.is_empty() {
                            cwd = p
                                .get("cwd")
                                .or_else(|| p.get("working_directory"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                        }
                    }
                }
                if preview.is_empty() {
                    let txt = codex_user_text(&obj);
                    if !txt.is_empty() && !looks_internal(&txt) {
                        preview = txt;
                    }
                }
                if !sid.is_empty() && !cwd.is_empty() && !preview.is_empty() {
                    break;
                }
            }
        }
        if sid.is_empty() {
            let fname = f.file_name().and_then(|s| s.to_str()).unwrap_or("");
            sid = find_uuid(fname)
                .unwrap_or_else(|| f.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string());
        }
        out.push(ScannedSession {
            provider: "codex".to_string(),
            session_id: sid,
            cwd,
            mtime,
            preview: clip(&preview, 160),
            file: f.to_string_lossy().into_owned(),
        });
    }
    out
}

/// 读文件尾部最多 max_bytes,返回最后 max_lines 个非空行。对齐 `_tail_lines`。
pub fn tail_lines(path: &Path, max_bytes: u64, max_lines: usize) -> Vec<String> {
    let size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return vec![],
    };
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let mut data = Vec::new();
    if size > max_bytes {
        if file.seek(SeekFrom::Start(size - max_bytes)).is_err() {
            return vec![];
        }
        let mut reader = BufReader::new(file);
        let mut discard = Vec::new();
        let _ = reader.read_until(b'\n', &mut discard); // 丢被截断的半行
        if reader.read_to_end(&mut data).is_err() {
            return vec![];
        }
    } else if file.read_to_end(&mut data).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&data);
    let lines: Vec<String> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].to_vec()
}

fn claude_msg_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for blk in arr {
                if let Some(obj) = blk.as_object() {
                    let typ = obj.get("type").and_then(|v| v.as_str());
                    if matches!(typ, Some("thinking") | Some("tool_use") | Some("tool_result")) {
                        continue;
                    }
                    if (typ.is_none() || typ == Some("text"))
                        && obj.get("text").and_then(|v| v.as_str()).is_some()
                    {
                        parts.push(obj.get("text").and_then(|v| v.as_str()).unwrap().to_string());
                    } else if let Some(c) = obj.get("content").and_then(|v| v.as_str()) {
                        parts.push(c.to_string());
                    }
                } else if let Some(s) = blk.as_str() {
                    parts.push(s.to_string());
                }
            }
            parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

/// 只从真实用户输入提取 prompt(跳 tool_result/tool_use 回灌)。对齐 `_claude_user_prompt`。
fn claude_user_prompt(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(arr)) => {
            if arr.iter().any(|b| {
                b.as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|t| t == "tool_result" || t == "tool_use")
                    .unwrap_or(false)
            }) {
                return String::new();
            }
            for b in arr {
                if let Some(o) = b.as_object() {
                    if o.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = o.get("text").and_then(|v| v.as_str()) {
                            if !t.trim().is_empty() {
                                return t.trim().to_string();
                            }
                        }
                    }
                } else if let Some(s) = b.as_str() {
                    if !s.trim().is_empty() {
                        return s.trim().to_string();
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn claude_tail_status(lines: &[String]) -> TailStatus {
    let mut st = TailStatus::default();
    for ln in lines.iter().rev() {
        let obj: Value = match serde_json::from_str(ln) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg = obj.get("message");
        let role = msg
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            .or_else(|| obj.get("type").and_then(|v| v.as_str()))
            .unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        if st.last_role.is_empty() {
            st.last_role = role.to_string();
        }
        if role == "assistant" && st.last_assistant.is_empty() {
            let txt = claude_msg_text(msg.and_then(|m| m.get("content")));
            if !txt.trim().is_empty() {
                st.last_assistant = txt;
            }
        }
        if role == "user" && st.last_user.is_empty() {
            let txt = claude_user_prompt(msg.and_then(|m| m.get("content")));
            if !txt.is_empty() && !looks_internal(&txt) {
                st.last_user = txt;
            }
        }
        if !st.last_role.is_empty() && !st.last_assistant.is_empty() && !st.last_user.is_empty() {
            break;
        }
    }
    st.last_assistant = clip(&st.last_assistant, 200);
    st.last_user = clip(&st.last_user, 200);
    st
}

fn codex_msg_text(content: Option<&Value>) -> String {
    // 取 input_text / output_text / text 块(对齐 `_codex_msg_text` 的常见形)。
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for blk in arr {
                if let Some(o) = blk.as_object() {
                    if let Some(t) = o.get("text").and_then(|v| v.as_str()) {
                        parts.push(t.to_string());
                    }
                } else if let Some(s) = blk.as_str() {
                    parts.push(s.to_string());
                }
            }
            parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

fn codex_tail_status(lines: &[String]) -> TailStatus {
    let mut st = TailStatus::default();
    for ln in lines.iter().rev() {
        let obj: Value = match serde_json::from_str(ln) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match obj.get("payload").and_then(|v| v.as_object()) {
            Some(p) => p,
            None => continue,
        };
        let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let role = payload.get("role").and_then(|v| v.as_str());
        if role == Some("assistant") || ptype.contains("agent") || ptype.contains("output") {
            let mut txt = codex_msg_text(payload.get("content"));
            if txt.is_empty() {
                txt = first_text(payload.get("text"));
            }
            if !txt.trim().is_empty() {
                if st.last_role.is_empty() {
                    st.last_role = "assistant".to_string();
                }
                if st.last_assistant.is_empty() {
                    st.last_assistant = txt;
                }
            }
        } else if role == Some("user") {
            if st.last_role.is_empty() {
                st.last_role = "user".to_string();
            }
            if st.last_user.is_empty() {
                let mut txt = codex_msg_text(payload.get("content"));
                if txt.is_empty() {
                    txt = first_text(payload.get("text"));
                }
                if !txt.trim().is_empty() && !looks_internal(&txt) {
                    st.last_user = txt;
                }
            }
        }
        if !st.last_role.is_empty() && !st.last_assistant.is_empty() && !st.last_user.is_empty() {
            break;
        }
    }
    st.last_assistant = clip(&st.last_assistant, 200);
    st.last_user = clip(&st.last_user, 200);
    st
}

/// transcript 尾部状态(provider 路由)。对齐 `_tail_status`。
pub fn tail_status(provider: &str, path: &Path) -> TailStatus {
    let lines = tail_lines(path, TAIL_BYTES, TAIL_MAX_LINES);
    if lines.is_empty() {
        return TailStatus::default();
    }
    if provider == "codex" {
        codex_tail_status(&lines)
    } else {
        claude_tail_status(&lines)
    }
}

/// 给 `/sessions/<id>/tail`:规范化最后 n 条 {role,text}。
pub fn tail_text(provider: &str, path: &Path, n: usize) -> Vec<Value> {
    let lines = tail_lines(path, TAIL_BYTES, n.max(1) * 4);
    let mut msgs = Vec::new();
    for ln in &lines {
        let obj: Value = match serde_json::from_str(ln) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (role, text) = if provider == "codex" {
            let payload = obj.get("payload");
            let role = payload.and_then(|p| p.get("role")).and_then(|v| v.as_str()).unwrap_or("");
            (role.to_string(), codex_msg_text(payload.and_then(|p| p.get("content"))))
        } else {
            let msg = obj.get("message");
            let role = msg
                .and_then(|m| m.get("role"))
                .and_then(|v| v.as_str())
                .or_else(|| obj.get("type").and_then(|v| v.as_str()))
                .unwrap_or("");
            (role.to_string(), claude_msg_text(msg.and_then(|m| m.get("content"))))
        };
        if (role == "user" || role == "assistant") && !text.trim().is_empty() {
            msgs.push(serde_json::json!({ "role": role, "text": clip(&text, 4000) }));
        }
    }
    let start = msgs.len().saturating_sub(n);
    msgs[start..].to_vec()
}

/// 读 `cc_sessions.json` → key→Managed。对齐 `_load_cc_sessions`。
pub fn load_cc_sessions(path: Option<&Path>) -> HashMap<String, Managed> {
    let mut out = HashMap::new();
    let p = match path {
        Some(p) => p,
        None => return out,
    };
    let raw: Value = match fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => v,
        None => return out,
    };
    let sessions = raw.get("sessions").cloned().unwrap_or(raw);
    let list: Vec<Value> = match sessions {
        Value::Array(a) => a,
        Value::Object(o) => o.into_iter().map(|(_, v)| v).collect(),
        _ => vec![],
    };
    for s in list {
        if let Some(o) = s.as_object() {
            let provider = o.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let sid = o
                .get("claude_session_id")
                .and_then(|v| v.as_str())
                .or_else(|| o.get("id").and_then(|v| v.as_str()))
                .unwrap_or("");
            let key = format!("{provider}:{sid}");
            out.insert(
                key,
                Managed {
                    kind: o.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    caller_identity: o
                        .get("caller_identity")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    pty_id: o.get("pty_id").and_then(|v| v.as_str()).map(String::from),
                    id: o.get("id").and_then(|v| v.as_str()).map(String::from),
                    alive: o.get("alive").and_then(|v| v.as_bool()).unwrap_or(false),
                    active_plan: o.get("active_plan").and_then(|v| v.as_str()).map(String::from),
                },
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_uuid_works() {
        assert_eq!(
            find_uuid("rollout-2026-06-24-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string())
        );
        assert_eq!(find_uuid("no-uuid-here.jsonl"), None);
    }

    #[test]
    fn first_text_blocks() {
        let v: Value = serde_json::json!([{"type":"text","text":"hi"}]);
        assert_eq!(first_text(Some(&v)), "hi");
        let v2: Value = serde_json::json!("plain");
        assert_eq!(first_text(Some(&v2)), "plain");
    }

    #[test]
    fn looks_internal_detects() {
        assert!(looks_internal("<system>"));
        assert!(looks_internal("  [OMNI] x"));
        assert!(!looks_internal("hello"));
    }
}
