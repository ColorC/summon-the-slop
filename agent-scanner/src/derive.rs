//! 确定性派生 —— 逐字对齐 Python `agent_registry`。无 LLM,纯规则,可高频调用。

use crate::model::{Managed, RunStatus};
use crate::names::NAMES;
use std::collections::HashSet;

/// 角色关键词 → 角色名(命中即取,顺序即优先级)。对齐 `_ROLE_RULES`。
const ROLE_RULES: &[(&[&str], &str)] = &[
    (&["qa", "测试", "跑测", "test"], "测试"),
    (&["调研", "research", "report", "选型"], "调研"),
    (&["简历", "resume", "作品集", "portfolio", "约稿", "文案", "写作"], "内容"),
    (
        &["dashboard", "驾驶舱", "poof", "omnidashboard", "waiela", "看板", "overlay"],
        "核心开发",
    ),
    (&["配表", "config", "live", "数值", "quant", "策划"], "数值"),
    (&["治理", "governance", "guardian", "注册", "registry"], "治理"),
];

/// cwd 关键词 → 项目名(digest 没给项目时的兜底)。对齐 `_PROJECT_RULES`。
const PROJECT_RULES: &[(&str, &str)] = &[
    ("poof", "omnidashboard-os"),
    ("omnidashboard", "omnidashboard-os"),
    ("waiela", "waiela"),
    ("omnicompany", "omnicompany"),
    ("quant-lab", "quant-lab"),
    ("walker", "行者无乡"),
    ("webworks", "webworks"),
    ("aiworkspace", "AIWorkSpace"),
];

/// 按 key 稳定散列取名;撞名线性探测下一个。对齐 `_stable_name`
/// (`h = (h*131 + ord(ch)) & 0xFFFFFFFF`)。
pub fn stable_name(key: &str, taken: &HashSet<String>) -> String {
    let mut h: u32 = 0;
    for ch in key.chars() {
        h = h.wrapping_mul(131).wrapping_add(ch as u32);
    }
    let n = NAMES.len() as u32;
    for i in 0..n {
        let cand = NAMES[(h.wrapping_add(i) % n) as usize];
        if !taken.contains(cand) {
            return cand.to_string();
        }
    }
    format!("{}{}", NAMES[(h % n) as usize], h % 97)
}

/// 角色派生。对齐 `_derive_role`,默认 "开发"。
pub fn derive_role(blob: &str) -> String {
    let low = blob.to_lowercase();
    for (keys, role) in ROLE_RULES {
        if keys.iter().any(|k| low.contains(k)) {
            return role.to_string();
        }
    }
    "开发".to_string()
}

/// 项目派生。对齐 `_derive_project`:digest 优先 → cwd 规则 → cwd 末段。
pub fn derive_project(digest_project: &str, cwd: &str) -> String {
    if !digest_project.is_empty() && digest_project != "无" && digest_project != "信息不足" {
        return digest_project.to_string();
    }
    let low = cwd.to_lowercase();
    for (frag, proj) in PROJECT_RULES {
        if low.contains(frag) {
            return proj.to_string();
        }
    }
    let normalized = cwd.replace('\\', "/");
    let tail = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if tail.is_empty() {
        "未知项目".to_string()
    } else {
        tail.to_string()
    }
}

/// 位置启发式。对齐 `_classify_location`。
pub fn classify_location(provider: &str, managed: Option<&Managed>) -> String {
    if let Some(m) = managed {
        let kind = m.kind.to_lowercase();
        let caller = m.caller_identity.to_lowercase();
        if kind == "controller" || caller == "controller" {
            return "omni-web".to_string();
        }
        if m.pty_id.is_some() || m.id.is_some() {
            return "poof-powershell".to_string();
        }
    }
    if provider == "codex" {
        "codex桌面".to_string()
    } else {
        "vscode".to_string()
    }
}

/// 是否在跑。对齐 `_running`:托管 alive 或 mtime 近 300s。
pub fn running(mtime: f64, managed: Option<&Managed>, now: f64) -> bool {
    if let Some(m) = managed {
        if m.alive {
            return true;
        }
    }
    mtime > 0.0 && (now - mtime) < 300.0
}

/// 运行态。对齐 `_derive_run_status`。
pub fn run_status(age_sec: f64, last_role: &str) -> RunStatus {
    if age_sec < 45.0 {
        RunStatus::Working
    } else if last_role == "assistant" {
        RunStatus::Done
    } else if last_role == "user" {
        RunStatus::Waiting
    } else {
        RunStatus::Idle
    }
}

/// 折叠空白 + 截断(无省略号)。对齐 agent_registry `_clean`。
pub fn clean(text: &str, n: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(n).collect()
}

/// 折叠空白 + 截断 + 超长加省略号。对齐 import_routes `_clip`。
pub fn clip(text: &str, limit: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() > limit {
        let head: String = chars[..limit].iter().collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_name_is_deterministic() {
        let taken = HashSet::new();
        let a = stable_name("claude_code:abc-123", &taken);
        let b = stable_name("claude_code:abc-123", &taken);
        assert_eq!(a, b);
        assert!(NAMES.contains(&a.as_str()));
    }

    #[test]
    fn stable_name_probes_on_collision() {
        let first = stable_name("claude_code:abc-123", &HashSet::new());
        let mut taken = HashSet::new();
        taken.insert(first.clone());
        let second = stable_name("claude_code:abc-123", &taken);
        assert_ne!(first, second);
    }

    #[test]
    fn project_rules_and_fallback() {
        assert_eq!(derive_project("", "E:/WindowsWorkspace/poof/src"), "omnidashboard-os");
        assert_eq!(derive_project("", "E:/WindowsWorkspace/quant-lab"), "quant-lab");
        assert_eq!(derive_project("我的项目", "E:/whatever"), "我的项目");
        assert_eq!(derive_project("信息不足", "E:/foo/bar"), "bar");
        assert_eq!(derive_project("", "E:\\a\\b\\zeta"), "zeta");
    }

    #[test]
    fn role_rules_and_default() {
        assert_eq!(derive_role("跑个 qa 测试"), "测试");
        assert_eq!(derive_role("poof 驾驶舱开发"), "核心开发");
        assert_eq!(derive_role("随便什么"), "开发");
    }

    #[test]
    fn location_and_running() {
        let m = Managed { alive: true, ..Default::default() };
        assert_eq!(classify_location("claude_code", None), "vscode");
        assert_eq!(classify_location("codex", None), "codex桌面");
        let ctrl = Managed { kind: "controller".into(), ..Default::default() };
        assert_eq!(classify_location("claude_code", Some(&ctrl)), "omni-web");
        let pty = Managed { pty_id: Some("p1".into()), ..Default::default() };
        assert_eq!(classify_location("claude_code", Some(&pty)), "poof-powershell");
        assert!(running(1000.0, Some(&m), 1_000_000.0)); // alive overrides mtime
        assert!(running(999.9, None, 1000.0)); // within 300s
        assert!(!running(100.0, None, 1000.0)); // stale
    }

    #[test]
    fn run_status_taxonomy() {
        assert_eq!(run_status(10.0, "user").as_str(), "working");
        assert_eq!(run_status(100.0, "assistant").as_str(), "done");
        assert_eq!(run_status(100.0, "user").as_str(), "waiting");
        assert_eq!(run_status(100.0, "").as_str(), "idle");
    }

    #[test]
    fn clip_and_clean() {
        assert_eq!(clean("  a   b  c ", 80), "a b c");
        assert_eq!(clip("hello world", 5), "hello…");
        assert_eq!(clip("hi", 5), "hi");
    }
}
