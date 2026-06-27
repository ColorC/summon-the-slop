//! 集成测试:用临时 fixture 目录跑 scan + Index 全链路。

use agent_scanner::index::{Index, Roots};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn tmp_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("agent-scanner-test-{}-{}", std::process::id(), n));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &PathBuf, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn roots(base: &PathBuf) -> Roots {
    Roots {
        claude_projects: base.join(".claude").join("projects"),
        codex_sessions: base.join(".codex").join("sessions"),
        cc_sessions: None,
    }
}

#[test]
fn scans_claude_session_and_derives_identity() {
    let base = tmp_dir();
    let sid = "11111111-2222-3333-4444-555555555555";
    let jsonl = base
        .join(".claude")
        .join("projects")
        .join("E--WindowsWorkspace-poof")
        .join(format!("{sid}.jsonl"));
    let lines = [
        r#"{"type":"user","cwd":"E:\\WindowsWorkspace\\poof","message":{"role":"user","content":"帮我做 poof 的扫描器"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的，我来做"}]}}"#,
    ]
    .join("\n");
    write(&jsonl, &lines);

    // now 取文件 mtime + 1000s,确保 age 为正且 >300(→ done、非 running)。
    let mt = fs::metadata(&jsonl).unwrap().modified().unwrap();
    let now = mt.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() + 1000.0;
    let mut idx = Index::new();
    idx.rebuild(&roots(&base), now);

    let key = format!("claude_code:{sid}");
    let r = idx.residents.get(&key).expect("session indexed");
    assert_eq!(r.provider, "claude_code");
    assert_eq!(r.session_id, sid);
    assert_eq!(r.cwd, "E:\\WindowsWorkspace\\poof");
    assert_eq!(r.project, "omnidashboard-os"); // cwd 含 poof
    assert_eq!(r.role, "核心开发"); // blob 含 poof
    assert_eq!(r.location, "vscode");
    assert_eq!(r.identity, format!("omnidashboard-os-核心开发-{}", r.name));
    assert!(r.preview.contains("扫描器"));
    // 末条是 assistant 且 mtime 久远 → done
    assert_eq!(r.run_status, "done");
    assert!(!r.running); // mtime 远早于 now
}

#[test]
fn name_is_stable_across_rebuilds() {
    let base = tmp_dir();
    let sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let jsonl = base
        .join(".claude")
        .join("projects")
        .join("proj")
        .join(format!("{sid}.jsonl"));
    write(&jsonl, r#"{"type":"user","cwd":"E:/tmp/proj","message":{"role":"user","content":"hi"}}"#);

    let mut idx = Index::new();
    idx.rebuild(&roots(&base), 1_000_000_000.0);
    let name1 = idx.residents.get(&format!("claude_code:{sid}")).unwrap().name.clone();
    let seq1 = idx.seq;
    idx.rebuild(&roots(&base), 1_000_000_001.0);
    let name2 = idx.residents.get(&format!("claude_code:{sid}")).unwrap().name.clone();
    assert_eq!(name1, name2, "name must be stable");
    // 内容未变 → seq 不再 bump(mtime 同)
    assert_eq!(seq1, idx.seq, "no content change → seq stable");
}

#[test]
fn skips_subagent_transcripts() {
    let base = tmp_dir();
    let parent_sid = "pppppppp-1111-2222-3333-444444444444";
    let parent = base
        .join(".claude")
        .join("projects")
        .join("proj")
        .join(format!("{parent_sid}.jsonl"));
    write(&parent, r#"{"type":"user","cwd":"E:/proj","message":{"role":"user","content":"main"}}"#);
    // 子 agent transcript:同 sid 但在 subagents/ 下,必须被跳过。
    let sub = base
        .join(".claude")
        .join("projects")
        .join("proj")
        .join("subagents")
        .join(format!("{parent_sid}.jsonl"));
    write(&sub, r#"{"type":"user","cwd":"E:/proj","message":{"role":"user","content":"sub"}}"#);

    let mut idx = Index::new();
    idx.rebuild(&roots(&base), 1_000_000_000.0);
    let r = idx.residents.get(&format!("claude_code:{parent_sid}")).unwrap();
    assert!(r.preview.contains("main"), "parent preview must win, not sub");
}

#[test]
fn scans_codex_session_from_meta() {
    let base = tmp_dir();
    let jsonl = base
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("06")
        .join("24")
        .join("rollout-2026-06-24T10-00-00-99999999-8888-7777-6666-555555555555.jsonl");
    let lines = [
        r#"{"type":"session_meta","payload":{"id":"codexsid-123","cwd":"E:/WindowsWorkspace/quant-lab"}}"#,
        r#"{"type":"event_msg","payload":{"type":"user_message","role":"user","content":"跑个回测"}}"#,
    ]
    .join("\n");
    write(&jsonl, &lines);

    let mut idx = Index::new();
    idx.rebuild(&roots(&base), 1_000_000_000.0);
    let r = idx.residents.get("codex:codexsid-123").expect("codex indexed");
    assert_eq!(r.provider, "codex");
    assert_eq!(r.cwd, "E:/WindowsWorkspace/quant-lab");
    assert_eq!(r.project, "quant-lab");
    assert_eq!(r.location, "codex桌面");
}

#[test]
fn running_when_fresh_mtime() {
    let base = tmp_dir();
    let sid = "ffffffff-0000-1111-2222-333333333333";
    let jsonl = base.join(".claude").join("projects").join("p").join(format!("{sid}.jsonl"));
    write(&jsonl, r#"{"type":"user","cwd":"E:/p","message":{"role":"user","content":"go"}}"#);
    // now == 文件 mtime 附近 → running=true、working
    let mt = fs::metadata(&jsonl).unwrap().modified().unwrap();
    let now = mt.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() + 5.0;

    let mut idx = Index::new();
    idx.rebuild(&roots(&base), now);
    let r = idx.residents.get(&format!("claude_code:{sid}")).unwrap();
    assert!(r.running, "fresh mtime → running");
    assert_eq!(r.run_status, "working", "age<45s → working");
}

#[test]
fn snapshot_json_shape() {
    let base = tmp_dir();
    let sid = "12121212-3434-5656-7878-909090909090";
    let jsonl = base.join(".claude").join("projects").join("p").join(format!("{sid}.jsonl"));
    write(&jsonl, r#"{"type":"user","cwd":"E:/p","message":{"role":"user","content":"x"}}"#);

    let mut idx = Index::new();
    idx.rebuild(&roots(&base), 1_000_000_000.0);
    let snap = idx.snapshot_json();
    assert_eq!(snap["count"], 1);
    assert!(snap["agents"].is_array());
    assert_eq!(snap["agents"][0]["session_id"], sid);
}
