//! P2 localhost HTTP collector — receives rrweb event batches from the Chrome / VSCode
//! extensions (which cannot use Tauri IPC) and writes them into the SAME session store as
//! record_cmd. STATELESS: every request carries its own sid, so there is no shared mutable
//! state with the Tauri side (only a OnceLock token) — no Arc/Mutex sharing, no deadlock.
//! Loopback-bound (127.0.0.1) + bearer-token gated. Runs on its own thread (blocking accept).
use std::io::Read;
use std::sync::OnceLock;

use tiny_http::{Header, Method, Response, Server};

const ADDR: &str = "127.0.0.1:8732";
static TOKEN: OnceLock<String> = OnceLock::new();

// 统一捕获 · 通用 DOM 解析: 浏览器扩展持续上报"光标下元素"(JSON), 存最新一条 + 时间戳。
// 给 poof 统一捕获/诊断读 —— 不靠埋点也能知道任意网页上你指的是哪个元素。
static LATEST_ELEMENT: std::sync::Mutex<Option<(u128, String)>> = std::sync::Mutex::new(None);

/// 最近一次扩展上报的光标下元素(JSON), 仅当在 within_ms 毫秒内(过期视为无)。
pub fn latest_element(within_ms: u128) -> Option<String> {
    let g = LATEST_ELEMENT.lock().ok()?;
    let (ts, json) = g.as_ref()?;
    let age_ms = now_ns().saturating_sub(*ts) / 1_000_000;
    if age_ms <= within_ms { Some(json.clone()) } else { None }
}

fn token_path() -> std::path::PathBuf {
    std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join(".overlay-shell")
        .join("rec_token")
}
fn legacy_token_path() -> std::path::PathBuf {
    std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join(".poof")
        .join("rec_token")
}
fn now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Shared token from %USERPROFILE%\.overlay-shell\rec_token, or generate + write one. The user pastes
/// it into the extension popup once (extensions can't read disk). Loopback binding is the
/// real boundary; the token just keeps other LOCAL processes from posting blindly.
fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        let p = token_path();
        if let Ok(t) = std::fs::read_to_string(&p) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
        let legacy = legacy_token_path();
        if let Ok(t) = std::fs::read_to_string(&legacy) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&p, &t);
                return t;
            }
        }
        let tok = format!("{:016x}{:016x}", now_ns(), now_ns().wrapping_mul(0x9E37_79B9_7F4A_7C15));
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, &tok);
        tok
    })
}

// JSON content type only — deliberately NO `Access-Control-Allow-Origin`. Our only clients are
// the MV3 extension service worker (host_permissions → not a CORS request, no preflight) and the
// VSCode extension host (Node, no CORS at all). Omitting ACAO means a browser PAGE that somehow
// holds the token still cannot POST: its application/json preflight gets no ACAO → blocked. Token
// + loopback bind remain the auth boundary; this just removes a pointless cross-origin opening.
fn json_resp(resp: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    let h = |k: &str, v: &str| Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    resp.with_header(h("Content-Type", "application/json"))
}

#[derive(serde::Deserialize)]
struct SearchRequest {
    query: String,
    limit: Option<usize>,
}

fn parse_search_request(body: &str) -> Result<(String, usize), String> {
    let request: SearchRequest = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok((request.query.trim().to_string(), request.limit.unwrap_or(40).clamp(1, 100)))
}

fn handle(method: &Method, url: &str, body: &str) -> (u16, String) {
    if method != &Method::Post {
        return (404, "{}".into());
    }
    let path = url.split('?').next().unwrap_or(url);
    match path {
        "/rec/start" => {
            let v = serde_json::from_str::<serde_json::Value>(body).ok();
            let title = v.as_ref().and_then(|v| v.get("title").and_then(|t| t.as_str())).unwrap_or("网页录制").to_string();
            let surface = v.as_ref().and_then(|v| v.get("surface").and_then(|s| s.as_str())).unwrap_or("chrome").to_string();
            match crate::record_cmd::init_session(&title, &surface) {
                Ok(sid) => (200, format!("{{\"sid\":\"{sid}\"}}")),
                Err(e) => (500, format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default())),
            }
        }
        "/rec/event" => {
            let v: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "{}".into()),
            };
            let sid = v.get("sid").and_then(|s| s.as_str()).unwrap_or("");
            let batch = v.get("batch").and_then(|b| b.as_array()).cloned().unwrap_or_default();
            // lazy-create uses the surface of the first event (crash-safety: event before /rec/start)
            let surface = batch.first().and_then(|e| e.get("surface").and_then(|s| s.as_str())).unwrap_or("chrome");
            let _ = crate::record_cmd::ensure_session(sid, surface);
            match crate::record_cmd::append_events(sid, &batch) {
                Ok(_) => (200, "{}".into()),
                Err(e) => (400, format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default())),
            }
        }
        "/rec/stop" => {
            let sid = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("sid").and_then(|s| s.as_str()).map(String::from))
                .unwrap_or_default();
            crate::record_cmd::stamp_stop(&sid);
            (200, "{}".into())
        }
        // P4 control plane — start/stop the native (desktop) coarse-layer recorder in-process.
        // Loopback + token gated; lets a local controller (dashboard/CLI) drive desktop recording.
        "/native/start" => {
            #[cfg(windows)]
            {
                let title = serde_json::from_str::<serde_json::Value>(body)
                    .ok()
                    .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(String::from))
                    .unwrap_or_else(|| "桌面活动录制".into());
                match crate::native_rec::start(&title) {
                    Ok(sid) => (200, format!("{{\"sid\":\"{sid}\"}}")),
                    Err(e) => (500, format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default())),
                }
            }
            #[cfg(not(windows))]
            {
                (500, "{\"error\":\"windows only\"}".into())
            }
        }
        "/native/stop" => {
            #[cfg(windows)]
            crate::native_rec::stop();
            (200, "{}".into())
        }
        // 区域录制控制面 — start/stop recording a physical-pixel rect {l,t,r,b}.
        "/region/start" => {
            #[cfg(windows)]
            {
                let v = serde_json::from_str::<serde_json::Value>(body).ok();
                let g = |k: &str| v.as_ref().and_then(|v| v.get(k).and_then(|n| n.as_i64())).unwrap_or(0);
                match crate::region_rec::start(g("l") as i32, g("t") as i32, g("r") as i32, g("b") as i32, g("hwnd")) {
                    Ok(sid) => (200, format!("{{\"sid\":\"{sid}\"}}")),
                    Err(e) => (500, format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default())),
                }
            }
            #[cfg(not(windows))]
            {
                (500, "{\"error\":\"windows only\"}".into())
            }
        }
        "/region/stop" => {
            #[cfg(windows)]
            crate::region_rec::stop();
            (200, "{}".into())
        }
        "/windows" => {
            #[cfg(windows)]
            {
                let ws = crate::region_rec::list_windows();
                (200, serde_json::to_string(&ws).unwrap_or_else(|_| "[]".into()))
            }
            #[cfg(not(windows))]
            {
                (200, "[]".into())
            }
        }
        // 远程剪切板同步(dashboard 桌面壳/网页): 只回最新一条, 且只有文本才带内容。刻意不做
        // 历史浏览与按 id 抓取 —— 剪贴板历史里几乎必然有密码/token。HTTP 仍受 loopback +
        // bearer token 保护; 浏览器通过 Dashboard 同源桥访问, 不直接持有 token。
        "/clipboard/latest" => match crate::clipclip::latest_summary() {
            Some(v) => (200, v.to_string()),
            None => (200, "null".into()),
        },
        // Dashboard 的远程文件搜索只复用现有索引，不另建第二份文件数据库。HTTP 仍受
        // loopback + bearer token 保护；浏览器通过 Dashboard 同源桥访问，不直接持有 token。
        "/search" => match parse_search_request(body) {
            Ok((query, limit)) => {
                let hits = if query.is_empty() {
                    Vec::new()
                } else {
                    crate::search::search(query, limit)
                };
                match serde_json::to_string(&hits) {
                    Ok(json) => (200, json),
                    Err(e) => (500, format!("{{\"error\":{}}}", serde_json::to_string(&e.to_string()).unwrap_or_default())),
                }
            }
            Err(e) => (400, format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default())),
        },
        // usn_tail.rs(常驻提权子进程)把 NTFS USN Journal 拉到的增量变更批量推过来 —— 全盘实时新鲜度
        // 的关键管道: 子进程持有卷句柄(提权)+ 常驻 FRN 表, 本进程只管把 {op,path/old/new,dir} 落进
        // ARENA(search::apply_usn_batch, 和 watch_roots 的 notify 事件走同一条 insert_path/remove_path/
        // rename_path)。同一用户下的子进程能读到这份 token(不受提权等级影响), 鉴权边界不变。
        "/usn/batch" => match serde_json::from_str::<Vec<crate::search::UsnOp>>(body) {
            Ok(ops) => {
                crate::search::apply_usn_batch(ops);
                (200, "{}".into())
            }
            Err(e) => (400, format!("{{\"error\":{}}}", serde_json::to_string(&e.to_string()).unwrap_or_default())),
        },
        // 统一捕获 · 通用 DOM 元素上报: 扩展(经 SW)把光标下元素 JSON 喂进来, 存最新一条。
        "/element" => {
            if !body.trim().is_empty() {
                if let Ok(mut g) = LATEST_ELEMENT.lock() {
                    *g = Some((now_ns(), body.to_string()));
                }
            }
            (200, "{}".into())
        }
        _ => (404, "{}".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_search_request;

    #[test]
    fn search_request_trims_query_and_clamps_limit() {
        assert_eq!(
            parse_search_request(r#"{"query":"  E:\\WindowsWorkspace  ","limit":999}"#).unwrap(),
            ("E:\\WindowsWorkspace".to_string(), 100)
        );
        assert_eq!(
            parse_search_request(r#"{"query":"notes","limit":0}"#).unwrap(),
            ("notes".to_string(), 1)
        );
    }

    #[test]
    fn search_request_uses_default_limit_and_rejects_invalid_json() {
        assert_eq!(
            parse_search_request(r#"{"query":"overlay"}"#).unwrap(),
            ("overlay".to_string(), 40)
        );
        assert!(parse_search_request(r#"{"limit":20}"#).is_err());
    }
}

pub fn start_http_server() {
    let token = token().to_string();
    let server = match Server::http(ADDR) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("overlay-shell rec collector: bind {ADDR} failed: {e}");
            return;
        }
    };
    eprintln!("overlay-shell rec collector on http://{ADDR} (token at %USERPROFILE%\\.overlay-shell\\rec_token)");
    for mut req in server.incoming_requests() {
        // A browser page preflight (OPTIONS) gets 200 but NO Access-Control-Allow-Origin, so the
        // page's actual cross-origin POST is blocked. The extension SW never preflights (it isn't
        // a CORS request), so this does not affect the real client.
        if req.method() == &Method::Options {
            let _ = req.respond(json_resp(Response::from_string("")));
            continue;
        }
        // bearer-token gate (field name case-insensitive; accept "Bearer X" or bare "X")
        let ok = req.headers().iter().any(|h| {
            h.field.as_str().as_str().eq_ignore_ascii_case("authorization")
                && h.value.as_str().trim().trim_start_matches("Bearer ").trim() == token
        });
        if !ok {
            let _ = req.respond(json_resp(Response::from_string("{}").with_status_code(401)));
            continue;
        }
        let method = req.method().clone();
        let url = req.url().to_string();
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let (code, out) = handle(&method, &url, &body);
        let _ = req.respond(json_resp(Response::from_string(out).with_status_code(code)));
    }
}
