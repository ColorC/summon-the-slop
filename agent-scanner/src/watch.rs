//! 文件 watcher —— notify 监扫描根,任何变更 nudge 一次 rebuild。
//! 原生事件不可靠时(网络盘/这些 app 写法),main 的 2s 轮询兜底(对齐 chokidar usePolling)。

use crate::index::Roots;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc::Sender;

/// 监 claude/codex 两根;任何事件向 `tx` 发一个 nudge。返回 watcher(须保活)。
/// notify 起不来就返回 None,完全靠轮询。
pub fn spawn_watcher(roots: &Roots, tx: Sender<()>) -> Option<RecommendedWatcher> {
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("agent-scanner: watcher init failed ({e}); falling back to polling");
            return None;
        }
    };
    for root in [&roots.claude_projects, &roots.codex_sessions] {
        if root.is_dir() {
            if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
                eprintln!("agent-scanner: watch {} failed: {e}", root.display());
            }
        }
    }
    Some(watcher)
}
