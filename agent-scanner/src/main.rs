//! agent-scanner 二进制 —— 扫描 + watcher/轮询重建 + 快照 + HTTP 服务。
//!
//! 环境变量:
//!   AGENT_SCANNER_ADDR        监听地址(默认 127.0.0.1:8765)
//!   AGENT_SCANNER_TOKEN       鉴权 token(缺省读 %USERPROFILE%\.overlay-shell\rec_token;再缺省=开放)
//!   AGENT_SCANNER_SNAPSHOT    快照路径(默认 %USERPROFILE%\.overlay-shell\agents-index.json)
//!   AGENT_SCANNER_INTERVAL    轮询秒数(默认 2)
//!   AGENT_SCANNER_CC_SESSIONS cc_sessions.json 路径(可选)
//!
//! release 编进 Windows GUI 子系统 → 常驻服务永不分配控制台窗口(对齐"零前台窗"硬规则);
//! debug 保留控制台便于开发/cargo test 看 stderr。

// release 二进制不要控制台窗口(否则常驻起来会弹黑框抢焦点)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agent_scanner::index::{write_snapshot, Index, Roots};
use agent_scanner::{now_secs, server, watch};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_token() -> Option<String> {
    if let Ok(t) = std::env::var("AGENT_SCANNER_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let rec = home().join(".overlay-shell").join("rec_token");
    let legacy = home().join(".poof").join("rec_token");
    std::fs::read_to_string(&rec)
        .or_else(|_| std::fs::read_to_string(legacy))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    let addr = std::env::var("AGENT_SCANNER_ADDR").unwrap_or_else(|_| "127.0.0.1:8765".to_string());
    let token = resolve_token();
    let snapshot = std::env::var("AGENT_SCANNER_SNAPSHOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".overlay-shell").join("agents-index.json"));
    if let Some(dir) = snapshot.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let interval: u64 = std::env::var("AGENT_SCANNER_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);

    let roots = Arc::new(Roots::from_home());
    let index = Arc::new(Mutex::new(Index::new()));

    // 初次构建。
    {
        let mut idx = index.lock().unwrap();
        idx.rebuild(&roots, now_secs());
        let _ = write_snapshot(&snapshot, &idx.snapshot_json());
        eprintln!("agent-scanner: initial index has {} agents", idx.residents.len());
    }

    // watcher + 轮询 重建线程。
    {
        let index = index.clone();
        let roots = roots.clone();
        let snapshot = snapshot.clone();
        std::thread::spawn(move || {
            let (tx, rx) = mpsc::channel::<()>();
            let _watcher = watch::spawn_watcher(&roots, tx); // 保活
            loop {
                // notify nudge 或超时(轮询兜底)任一触发。
                let _ = rx.recv_timeout(Duration::from_secs(interval));
                while rx.try_recv().is_ok() {} // 合并积压事件
                std::thread::sleep(Duration::from_millis(200)); // 防抖,等写入落定
                let mut idx = index.lock().unwrap();
                idx.rebuild(&roots, now_secs());
                let _ = write_snapshot(&snapshot, &idx.snapshot_json());
            }
        });
    }

    server::run_server(&addr, token, index, roots);
}
