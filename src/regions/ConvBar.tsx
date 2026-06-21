// 底部栏: 总控 AI 选型 + 活跃对话注册列表(新对话也在列表里, 不再是独立按钮)。
import { useEffect, useState } from "react";
import { MessagesSquare, Plus, RefreshCw, ChevronDown } from "lucide-react";
import { runShell } from "../lib";
import { listPanes, focusPane, type PoofPane } from "../poofPanes";
import {
  getControllerKind,
  setControllerKind,
  type ControllerKind,
} from "../controller";

interface AgentRec {
  key?: string;
  identity?: string;
  location?: string;
  current_task?: string;
  pty_id?: string;
  running?: boolean;
}

const KIND_LABEL: Record<ControllerKind, string> = {
  codex: "Codex CLI",
  claude: "Claude CLI",
  "omni-web": "Omni 总控(web)",
};

export function ConvBar({
  onNewChat,
  onOpenChat,
  onPickKind,
}: {
  onNewChat: (provider: string) => void;
  onOpenChat: () => void;
  onPickKind: (k: ControllerKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kindMenu, setKindMenu] = useState(false);
  const [kind, setKind] = useState<ControllerKind>(getControllerKind());
  const [agents, setAgents] = useState<AgentRec[]>([]);
  const [panes, setPanes] = useState<PoofPane[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setPanes(listPanes());
    setLoading(true);
    try {
      const out = await runShell("omni agents list --running --json");
      const last = (out.stdout || "").trim();
      setAgents(JSON.parse(last || "[]"));
    } catch {
      /* dashboard/omni may be down — still show poof panes */
    }
    setLoading(false);
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  function pickKind(k: ControllerKind) {
    setKind(k);
    setControllerKind(k);
    onPickKind(k);
    setKindMenu(false);
  }

  // poof 本地窗格(含总控)用 pty_id 去重 omni 注册表里的同一条
  const panePtyIds = new Set(panes.map((p) => p.id));
  const externals = agents.filter((a) => !a.pty_id || !panePtyIds.has(a.pty_id));

  async function jumpExternal(a: AgentRec) {
    if (a.location) {
      await runShell(`omni dispatch activate --location "${a.location}" --json`).catch(() => {});
    }
    setOpen(false);
  }

  return (
    <div className="conv-wrap">
      {/* 总控 AI 选型 */}
      <div className="conv-kind">
        <button className="conv-kind-btn" onClick={() => setKindMenu((v) => !v)} title="总控用哪个 AI">
          总控 · {KIND_LABEL[kind]}
          <ChevronDown size={13} />
        </button>
        {kindMenu && (
          <div className="conv-kind-menu">
            {(["codex", "claude", "omni-web"] as ControllerKind[]).map((k) => (
              <button key={k} className={k === kind ? "on" : ""} onClick={() => pickKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 活跃对话注册列表 */}
      <button className={"conv-list-btn" + (open ? " on" : "")} onClick={() => setOpen((v) => !v)} title="活跃对话">
        <MessagesSquare size={16} /> 对话
        <span className="conv-count">{panes.length + externals.length || ""}</span>
      </button>

      {open && (
        <div className="conv-pop">
          <div className="conv-pop-head">
            <span>活跃对话</span>
            <button className="conv-refresh" onClick={() => void refresh()} title="刷新">
              <RefreshCw size={13} className={loading ? "spin" : ""} />
            </button>
          </div>

          {/* 新对话(在列表里, 不在底部栏按钮) */}
          <div className="conv-new-row">
            <span className="conv-new-label"><Plus size={13} /> 新对话</span>
            <button onClick={() => { onNewChat("claude"); setOpen(false); }}>Claude</button>
            <button onClick={() => { onNewChat("codex"); setOpen(false); }}>Codex</button>
            <button onClick={() => { onNewChat("ps"); setOpen(false); }}>PS</button>
          </div>

          <div className="conv-rows">
            {panes.length === 0 && externals.length === 0 && (
              <div className="conv-empty">还没有在跑的对话。</div>
            )}
            {/* poof 里的对话(含总控) */}
            {panes.map((p) => (
              <button
                key={p.id}
                className="conv-row"
                onClick={() => { focusPane(p.id); onOpenChat(); setOpen(false); }}
              >
                <span className="conv-dot poof" />
                <span className="conv-row-main">
                  <span className="conv-row-id">{p.id === "" ? p.provider : `${p.provider}`} · poof</span>
                  <span className="conv-row-task">{p.label}</span>
                </span>
              </button>
            ))}
            {/* 本机其它在跑对话(注册表) */}
            {externals.map((a) => (
              <button key={a.key} className="conv-row" onClick={() => void jumpExternal(a)}>
                <span className="conv-dot ext" />
                <span className="conv-row-main">
                  <span className="conv-row-id">{a.identity || a.key} · {a.location}</span>
                  <span className="conv-row-task">{a.current_task}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
