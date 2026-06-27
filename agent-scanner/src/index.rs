//! 内存索引 + seq cursor + 原子 JSON 快照。

use crate::derive::{classify_location, clean, derive_project, derive_role, run_status, running, stable_name};
use crate::model::Resident;
use crate::scan::{load_cc_sessions, scan_claude, scan_codex, tail_status};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 扫描根集。
pub struct Roots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
    pub cc_sessions: Option<PathBuf>,
}

impl Roots {
    /// 从用户主目录推断默认根(`%USERPROFILE%`/`HOME`)。
    /// `AGENT_SCANNER_CLAUDE_ROOT` / `AGENT_SCANNER_CODEX_ROOT` 可覆盖(便于测试 / 非默认布局)。
    pub fn from_home() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        let claude_projects = std::env::var("AGENT_SCANNER_CLAUDE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".claude").join("projects"));
        let codex_sessions = std::env::var("AGENT_SCANNER_CODEX_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".codex").join("sessions"));
        Roots {
            claude_projects,
            codex_sessions,
            cc_sessions: std::env::var("AGENT_SCANNER_CC_SESSIONS").ok().map(PathBuf::from),
        }
    }
}

/// agent 索引:key→Resident,加稳定名映射与单调 seq。
pub struct Index {
    pub seq: u64,
    pub residents: HashMap<String, Resident>,
    names: HashMap<String, String>,
}

impl Default for Index {
    fn default() -> Self {
        Self::new()
    }
}

impl Index {
    pub fn new() -> Self {
        Index { seq: 0, residents: HashMap::new(), names: HashMap::new() }
    }

    /// 全量重建。确定性,无 LLM。任何与上次的差异都 bump seq。
    pub fn rebuild(&mut self, roots: &Roots, now: f64) {
        let mut scanned = scan_claude(&roots.claude_projects, now);
        scanned.extend(scan_codex(&roots.codex_sessions, now));
        let managed = load_cc_sessions(roots.cc_sessions.as_deref());

        let mut taken: HashSet<String> = self.names.values().cloned().collect();
        let mut next: HashMap<String, Resident> = HashMap::new();

        for s in &scanned {
            if s.session_id.is_empty() {
                continue;
            }
            let key = format!("{}:{}", s.provider, s.session_id);
            let m = managed.get(&key);

            // 名字一经分配不变。
            let name = match self.names.get(&key) {
                Some(n) => n.clone(),
                None => {
                    let n = stable_name(&key, &taken);
                    taken.insert(n.clone());
                    n
                }
            };
            self.names.insert(key.clone(), name.clone());

            // Rust 不持 digest → project/role 走 digest-less 兜底(Python 有 digest 时覆盖)。
            let project = derive_project("", &s.cwd);
            let blob = format!("{} {} {}", project, s.cwd, s.preview);
            let role = derive_role(&blob);
            let location = classify_location(&s.provider, m);
            let identity = format!("{project}-{role}-{name}");

            let ts = tail_status(&s.provider, Path::new(&s.file));
            let age = (now - s.mtime).max(0.0);
            let rstatus = run_status(age, &ts.last_role);

            let initial = clean(&s.preview, 140);
            let current_raw = if !ts.last_assistant.is_empty() {
                ts.last_assistant.clone()
            } else {
                initial.clone()
            };
            let current_task = {
                let c = clean(&current_raw, 160);
                if c.is_empty() {
                    "进行中…".to_string()
                } else {
                    c
                }
            };

            next.insert(
                key.clone(),
                Resident {
                    key,
                    provider: s.provider.clone(),
                    session_id: s.session_id.clone(),
                    cwd: s.cwd.clone(),
                    file: s.file.clone(),
                    name,
                    project,
                    role,
                    identity,
                    location,
                    preview: s.preview.clone(),
                    current_task,
                    initial_task: if initial.is_empty() { "(无)".to_string() } else { initial },
                    last_assistant: ts.last_assistant,
                    last_user: ts.last_user,
                    run_status: rstatus.as_str().to_string(),
                    running: running(s.mtime, m, now),
                    mtime: s.mtime,
                    pty_id: m.and_then(|x| x.pty_id.clone().or_else(|| x.id.clone())),
                    active_plan: m.and_then(|x| x.active_plan.clone()),
                },
            );
        }

        if next != self.residents {
            self.seq += 1;
            self.residents = next;
        }
    }

    /// 排序后的快照(在跑在前,再按 mtime 倒序)。
    pub fn sorted(&self) -> Vec<&Resident> {
        let mut agents: Vec<&Resident> = self.residents.values().collect();
        agents.sort_by(|a, b| {
            let ra = u8::from(!a.running);
            let rb = u8::from(!b.running);
            ra.cmp(&rb)
                .then(b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal))
        });
        agents
    }

    pub fn snapshot_json(&self) -> Value {
        let agents = self.sorted();
        serde_json::json!({ "seq": self.seq, "count": agents.len(), "agents": agents })
    }

    pub fn find(&self, id: &str) -> Option<&Resident> {
        self.residents
            .values()
            .find(|r| r.session_id == id || r.key == id)
    }
}

/// 原子写快照(临时文件 + rename)。对齐 poof notesstore 房风格。
pub fn write_snapshot(path: &Path, json: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(json).unwrap_or_default())?;
    std::fs::rename(&tmp, path)
}
