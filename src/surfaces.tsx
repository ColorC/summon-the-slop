import { useEffect, useState } from "react";
import { NoteSpace } from "./regions/NoteSpace";
import { runShell, askAi, copyText } from "./lib";

// ---------- shared helpers ----------

function useShellJson<T = any>(cmd: string) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    runShell(cmd)
      .then((o) => {
        if (!alive) return;
        if (o.code !== 0 && !o.stdout.trim()) {
          setErr(o.stderr || `exit ${o.code}`);
        } else {
          try {
            setData(JSON.parse(o.stdout));
          } catch {
            setErr("解析 JSON 失败: " + o.stdout.slice(0, 200));
          }
        }
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cmd]);
  return { data, err, loading };
}

interface Project {
  id: string;
  name: string;
  group: string;
  desc?: string;
  tags?: string[];
}

// ---------- 项目 Project ----------

export function ProjectSurface() {
  const { data, err, loading } = useShellJson<{ projects: Project[] }>(
    "omni project list --json"
  );
  if (loading) return <div className="muted">加载 omni 项目…</div>;
  if (err) return <div className="error">omni project list 失败: {err}</div>;
  const projects = data?.projects ?? [];
  return (
    <div className="cards">
      {projects.map((p) => (
        <div className="card" key={p.id}>
          <div className="card-title">{p.name}</div>
          <div className="card-meta">
            <span className="chip">{p.group}</span>
            {(p.tags ?? []).slice(0, 3).map((t) => (
              <span className="chip ghost" key={t}>
                {t}
              </span>
            ))}
          </div>
          {p.desc && <div className="card-desc">{p.desc}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------- 检索 Find (Listary 类) ----------

export function FindSurface() {
  const { data } = useShellJson<{ projects: Project[] }>(
    "omni project list --json"
  );
  const [q, setQ] = useState("");
  const projects = data?.projects ?? [];
  const hits = q.trim()
    ? projects.filter((p) =>
        (p.name + " " + p.id + " " + (p.desc ?? "") + " " + (p.tags ?? []).join(" "))
          .toLowerCase()
          .includes(q.toLowerCase())
      )
    : projects;
  return (
    <div className="find">
      <input
        autoFocus
        className="find-input"
        placeholder="检索我的一切（项目 / 之后接 waiela find 本地·对话·飞书）…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="find-results">
        {hits.map((p) => (
          <div className="find-row" key={p.id}>
            <span className="find-name">{p.name}</span>
            <span className="chip">{p.group}</span>
            <span className="find-desc">{p.desc}</span>
          </div>
        ))}
        {hits.length === 0 && <div className="muted">无匹配</div>}
      </div>
    </div>
  );
}

// ---------- 聊天 Talk (你自己的 AI) ----------

export function TalkSurface() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setAnswer("（思考中，claude -p …）");
    try {
      setAnswer(await askAi(prompt));
    } catch (e) {
      setAnswer("AI 调用失败: " + String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="talk">
      <div className="talk-input">
        <textarea
          autoFocus
          placeholder="问你自己的 AI（Claude Code headless，Ctrl+Enter 发送）…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <button onClick={send} disabled={busy}>
          {busy ? "…" : "发送"}
        </button>
      </div>
      {answer && (
        <div className="talk-answer">
          <div className="answer-body">{answer}</div>
          <div className="dispatch">
            <button onClick={() => copyText(answer)}>复制</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 审阅台 Review ----------

export function ReviewSurface() {
  const { data, err, loading } = useShellJson<any>(
    "omni project show omnidashboard-os --json"
  );
  if (loading) return <div className="muted">加载审阅项…</div>;
  if (err) return <div className="error">{err}</div>;
  const latest: string[] = data?.latest ?? [];
  const links: { label: string; url: string }[] = data?.links ?? [];
  return (
    <div className="review">
      <div className="review-h">omnidashboard-os · 最近 / 待审</div>
      {latest.map((l, i) => (
        <div className="review-item" key={i}>
          📌 {l}
        </div>
      ))}
      {links.length > 0 && (
        <>
          <div className="review-h">链接</div>
          {links.map((l, i) => (
            <div className="review-item" key={i}>
              🔗 {l.label} — <span className="muted">{l.url}</span>
            </div>
          ))}
        </>
      )}
      {latest.length === 0 && <div className="muted">无最近条目</div>}
    </div>
  );
}

// ---------- 速记 / 画布 Note (P4: BlockSuite/Excalidraw) ----------

export function NoteSurface() {
  // 笔记空间 = BlockSuite 无限画布 + 主体长 Markdown 文档（obsidian 能力，无 license 提示）。
  return <NoteSpace />;
}

// ---------- registry ----------

export interface Surface {
  id: string;
  label: string;
  icon: string;
  Component: React.FC;
}

export const SURFACES: Surface[] = [
  { id: "find", label: "检索", icon: "🔍", Component: FindSurface },
  { id: "talk", label: "聊天", icon: "💬", Component: TalkSurface },
  { id: "project", label: "项目", icon: "🗂️", Component: ProjectSurface },
  { id: "review", label: "审阅台", icon: "✅", Component: ReviewSurface },
  { id: "note", label: "速记", icon: "✍️", Component: NoteSurface },
];
