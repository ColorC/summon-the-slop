//! tiny_http 路由 —— `/agents` `/agents/since` `/sessions/<id>/tail` `/health`。
//! token 鉴权(X-Token 头或 ?token=)+ CORS。对齐 poof http_rec.rs 范式(同步循环)。

use crate::index::{Index, Roots};
use crate::scan::tail_text;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server};

fn cors(resp: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut r = resp;
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, OPTIONS"),
        ("Access-Control-Allow-Headers", "X-Token, Content-Type"),
        ("Content-Type", "application/json; charset=utf-8"),
    ] {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            r.add_header(h);
        }
    }
    r
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split('?').nth(1)?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            return it.next().map(|s| s.to_string());
        }
    }
    None
}

fn route(path: &str, url: &str, index: &Arc<Mutex<Index>>) -> (u16, String) {
    if path == "/health" {
        return (200, "{\"ok\":true}".to_string());
    }
    if path == "/agents" {
        let idx = index.lock().unwrap();
        return (200, idx.snapshot_json().to_string());
    }
    if path == "/agents/since" {
        let since = query_param(url, "seq").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let idx = index.lock().unwrap();
        if idx.seq > since {
            return (200, idx.snapshot_json().to_string());
        }
        return (200, serde_json::json!({ "seq": idx.seq, "agents": [], "unchanged": true }).to_string());
    }
    if let Some(rest) = path.strip_prefix("/sessions/") {
        if let Some(id) = rest.strip_suffix("/tail") {
            let n = query_param(url, "lines").and_then(|v| v.parse::<usize>().ok()).unwrap_or(60);
            let idx = index.lock().unwrap();
            if let Some(r) = idx.find(id) {
                let lines = tail_text(&r.provider, Path::new(&r.file), n);
                return (
                    200,
                    serde_json::json!({ "session_id": r.session_id, "provider": r.provider, "lines": lines }).to_string(),
                );
            }
            return (404, "{\"error\":\"not found\"}".to_string());
        }
    }
    (404, "{\"error\":\"not found\"}".to_string())
}

/// 起 HTTP 服务(阻塞当前线程)。`_roots` 暂留作未来按需扫描用。
pub fn run_server(addr: &str, token: Option<String>, index: Arc<Mutex<Index>>, _roots: Arc<Roots>) {
    let server = match Server::http(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("agent-scanner: bind {addr} failed: {e}");
            return;
        }
    };
    eprintln!("agent-scanner http on http://{addr}");
    for req in server.incoming_requests() {
        if req.method() == &Method::Options {
            let _ = req.respond(cors(Response::from_string("")));
            continue;
        }
        if let Some(tok) = &token {
            let header_ok = req
                .headers()
                .iter()
                .any(|h| h.field.equiv("X-Token") && h.value.as_str() == tok);
            let query_ok = query_param(&req.url().to_string(), "token").as_deref() == Some(tok);
            if !header_ok && !query_ok {
                let _ = req.respond(cors(
                    Response::from_string("{\"error\":\"unauthorized\"}").with_status_code(401),
                ));
                continue;
            }
        }
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();
        let (code, body) = route(&path, &url, &index);
        let _ = req.respond(cors(Response::from_string(body).with_status_code(code)));
    }
}
