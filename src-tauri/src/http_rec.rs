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

fn token_path() -> std::path::PathBuf {
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

/// Shared token from %USERPROFILE%\.poof\rec_token, or generate + write one. The user pastes
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
                let g = |k: &str| v.as_ref().and_then(|v| v.get(k).and_then(|n| n.as_i64())).unwrap_or(0) as i32;
                match crate::region_rec::start(g("l"), g("t"), g("r"), g("b")) {
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
        _ => (404, "{}".into()),
    }
}

pub fn start_http_server() {
    let token = token().to_string();
    let server = match Server::http(ADDR) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("poof rec collector: bind {ADDR} failed: {e}");
            return;
        }
    };
    eprintln!("poof rec collector on http://{ADDR} (token at %USERPROFILE%\\.poof\\rec_token)");
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
