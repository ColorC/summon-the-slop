//! agent-scanner — 机器级 AI agent 会话扫描/索引/watcher。
//!
//! 扫 `~/.claude/projects` + `~/.codex/sessions`(+ `cc_sessions.json` 托管态),确定性派生
//! 身份(名字/项目/角色/位置)与运行态(working/done/waiting/idle),维护内存索引 + JSON 快照,
//! 经 localhost HTTP(tiny_http)暴露 `/agents` `/agents/since` `/sessions/<id>/tail`。
//!
//! 设计与权威见 `omnicompany/docs/plans/[2026-06-24]RUST-PYTHON-HYBRID/plan.md`。
//! 派生规则逐字对齐 Python `boss_sight/services/agent_registry.py` +
//! `ccdaemon/import_routes.py`,以便 `equiv-test` 校验语义等价后绞杀 Python 扫描层。

pub mod derive;
pub mod index;
pub mod model;
pub mod names;
pub mod scan;
pub mod server;
pub mod watch;

/// 当前 UNIX 时间(秒,f64)。
pub fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}
