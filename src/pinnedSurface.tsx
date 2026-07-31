// 当前任务 面板 —— overlay-shell 接本地 progress-service（Rust 服务 :8230）的置顶区。
// 打开时拉取一次 /api/board，渲染 pins[]（按置顶顺序，最新在前），手动刷新按钮，不做密集轮询。

import { useCallback, useEffect, useState } from "react";

const PROGRESS_SERVICE = "http://127.0.0.1:8230";

interface Pin {
  subject_kind: "task" | "goal";
  subject_id: string;
  title?: string;
  status?: string;
  completion?: number;
  channel?: string;
  line?: string;
  done_count?: number;
  task_count?: number;
  note?: string;
  missing?: boolean;
}
interface Board { pins: Pin[] }

const STATUS: Record<string, string> = { done: "#3fb950", in_progress: "#d9b25a", paused: "#8b97a4", todo: "#79c0ff" };

function PinLine({ p }: { p: Pin }) {
  if (p.missing) {
    return (
      <div style={{ padding: "5px 0", borderTop: "1px solid #1a222b", color: "#8b97a4", fontSize: 13 }}>
        ! [{p.subject_kind}] {p.subject_id}（已失效）
      </div>
    );
  }
  const isGoal = p.subject_kind === "goal";
  const pct = isGoal
    ? (p.task_count ? Math.round(((p.done_count ?? 0) / p.task_count) * 100) : 0)
    : (p.completion ?? 0);
  return (
    <div style={{ padding: "5px 0", borderTop: "1px solid #1a222b" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: STATUS[p.status || ""] || "#8b97a4", flexShrink: 0 }} />
        <span style={{ color: "#dfe6ee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || p.subject_id}</span>
        <span style={{ color: "#6f7681", marginLeft: "auto", flexShrink: 0 }}>{pct}%</span>
      </div>
      <div style={{ height: 4, background: "#1a222b", borderRadius: 2, marginTop: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: STATUS[p.status || ""] || "#d9b25a" }} />
      </div>
    </div>
  );
}

export default function PinnedSurface() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`${PROGRESS_SERVICE}/api/board`).then((r) => r.json()).then((b) => { setBoard(b); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) return <div style={{ padding: 12, color: "#ff8a80", fontSize: 13, lineHeight: 1.6 }}>连不上 progress-service（:8230）：{err}<br />启动：<code>progressd.exe</code></div>;
  if (!board) return <div style={{ padding: 12, color: "#8b97a4", fontSize: 13 }}>加载中…</div>;

  const pins = board.pins || [];

  return (
    <div style={{ padding: "8px 10px 24px", color: "#e6edf3", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b style={{ color: "#f0e6cf" }}>当前任务</b>
        <span style={{ color: "#9a8f78", fontSize: 13 }}>{pins.length} 置顶</span>
        <button onClick={load} style={{ marginLeft: "auto", fontSize: 13, color: "#d9b25a", background: "#15120a", border: "1px solid #8a7437", borderRadius: 4, padding: "2px 7px", cursor: "pointer" }}>刷新</button>
      </div>
      {pins.length === 0 ? (
        <div style={{ color: "#8b97a4", fontSize: 13 }}>（无置顶任务）</div>
      ) : (
        pins.map((p) => <PinLine key={`${p.subject_kind}:${p.subject_id}`} p={p} />)
      )}
    </div>
  );
}
