// 目标 / 任务 面板 —— poof 接本地目标管理系统 whatnow（Rust 服务 :8230，仿 Leantime）。
// 用户 2026-06-23 /goal R1：本地目标管理系统要和 omnidashboard 和 poof 集成。
// 紧凑视图：北极星主线/支线 → 计划（完成度条）+ 当前专注 + 外部收件箱计数。点"拉取"同步 meego/multica。

import { useCallback, useEffect, useState } from "react";

const WHATNOW = "http://127.0.0.1:8230";

interface Task { id: string; title: string; status: string; completion: number; line: string; channel: string; latest_progress?: string | null }
interface Goal { id: string; title: string; kind: string; line: string; objective: string; tasks: Task[] }
interface Cluster { id: string; title: string; goals: Goal[] }
interface Board { clusters: Cluster[]; loose_tasks: Task[]; focus: { task_id: string; title?: string | null }[]; counts: { goals: number; tasks: number } }

const STATUS: Record<string, string> = { done: "#3fb950", in_progress: "#d9b25a", paused: "#8b97a4", todo: "#79c0ff" };

function TaskLine({ t }: { t: Task }) {
  return (
    <div style={{ padding: "3px 0", borderTop: "1px solid #1a222b" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: STATUS[t.status] || "#8b97a4", flexShrink: 0 }} />
        <span style={{ color: "#dfe6ee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
        <span style={{ color: "#6f7681", marginLeft: "auto", flexShrink: 0 }}>{t.completion}%</span>
      </div>
      <div style={{ height: 4, background: "#1a222b", borderRadius: 2, marginTop: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, t.completion))}%`, background: STATUS[t.status] || "#d9b25a" }} />
      </div>
    </div>
  );
}

export default function GoalsSurface() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch(`${WHATNOW}/api/board`).then((r) => r.json()).then((b) => { setBoard(b); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setMsg("同步中…");
    await Promise.allSettled([fetch(`${WHATNOW}/api/sync/meego`, { method: "POST" }), fetch(`${WHATNOW}/api/sync/multica`, { method: "POST" })]);
    setMsg(""); load();
  };

  if (err) return <div style={{ padding: 12, color: "#ff8a80", fontSize: 13, lineHeight: 1.6 }}>连不上 whatnow（:8230）：{err}<br />启动：<code>whatnowd.exe</code></div>;
  if (!board) return <div style={{ padding: 12, color: "#8b97a4", fontSize: 13 }}>加载目标…</div>;

  return (
    <div style={{ padding: "8px 10px 24px", color: "#e6edf3", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b style={{ color: "#f0e6cf" }}>目标 / 任务</b>
        <span style={{ color: "#9a8f78", fontSize: 13 }}>{board.counts.goals} 目标 / {board.counts.tasks} 计划</span>
        <button onClick={sync} style={{ marginLeft: "auto", fontSize: 13, color: "#d9b25a", background: "#15120a", border: "1px solid #8a7437", borderRadius: 4, padding: "2px 7px", cursor: "pointer" }}>拉取 {msg}</button>
      </div>
      {board.focus.length > 0 && (
        <div style={{ marginBottom: 6, color: "#d9b25a", fontSize: 13 }}>★ 专注：{board.focus.map((f) => f.title || f.task_id).join(" · ")}</div>
      )}
      {board.clusters.map((c) => (
        <div key={c.id} style={{ marginBottom: 8 }}>
          <div style={{ color: "#d9b25a", fontWeight: 700, fontSize: 13, margin: "6px 0 2px" }}>{c.title}</div>
          {c.goals.map((g) => (
            <div key={g.id} style={{ borderLeft: `3px solid ${g.line === "main" ? "#d9b25a" : "#3a4654"}`, paddingLeft: 7, margin: "4px 0" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: g.line === "main" ? "#1a140a" : "#0c0f13", background: g.line === "main" ? "#d9b25a" : "#aab4bf", borderRadius: 3, padding: "0 4px" }}>{g.line === "main" ? "主线" : "支线"}</span>
                <span style={{ color: "#fff", fontWeight: 600 }}>{g.title}</span>
                <span style={{ color: "#6f7681", marginLeft: "auto", fontSize: 13 }}>{g.tasks.length}</span>
              </div>
              {g.tasks.slice(0, 6).map((t) => <TaskLine key={t.id} t={t} />)}
            </div>
          ))}
        </div>
      ))}
      {board.loose_tasks.length > 0 && (
        <div style={{ marginTop: 8, color: "#79c0ff", fontSize: 13 }}>外部收件箱（meego/multica，统一身份去重后）：{board.loose_tasks.length} 条待归入主线/支线</div>
      )}
    </div>
  );
}
