//! 数据模型:扫描原始记录、托管态、统一 Resident。

use serde::{Deserialize, Serialize};

/// 一条扫盘得到的原始会话(派生前)。
#[derive(Debug, Clone, Default)]
pub struct ScannedSession {
    pub provider: String,
    pub session_id: String,
    pub cwd: String,
    pub mtime: f64,
    pub preview: String,
    pub file: String,
}

/// `cc_sessions.json` 里同 key 的托管记录(决定 location / running)。
#[derive(Debug, Clone, Default)]
pub struct Managed {
    pub kind: String,
    pub caller_identity: String,
    pub pty_id: Option<String>,
    pub id: Option<String>,
    pub alive: bool,
    pub active_plan: Option<String>,
}

/// transcript 尾部状态。
#[derive(Debug, Clone, Default)]
pub struct TailStatus {
    pub last_role: String,
    pub last_assistant: String,
    pub last_user: String,
}

/// 运行态 — 逐字对齐 Python `_derive_run_status`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Working,
    Done,
    Waiting,
    Idle,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Working => "working",
            RunStatus::Done => "done",
            RunStatus::Waiting => "waiting",
            RunStatus::Idle => "idle",
        }
    }
}

/// 统一常驻 agent 记录 —— 字段与 Python agent_registry 记录对齐(便于等价比对)。
/// `title`/`last_step`(LLM 摘要)留给 Python 回填,Rust 不算。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Resident {
    pub key: String,
    pub provider: String,
    pub session_id: String,
    pub cwd: String,
    pub file: String,
    pub name: String,
    pub project: String,
    pub role: String,
    pub identity: String,
    pub location: String,
    pub preview: String,
    pub current_task: String,
    pub initial_task: String,
    pub last_assistant: String,
    pub last_user: String,
    pub run_status: String,
    pub running: bool,
    pub mtime: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_plan: Option<String>,
}
