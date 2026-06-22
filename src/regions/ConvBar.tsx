// 底部栏: 总控 AI 选型 + 活跃对话注册列表(新对话在列表里)。
// #2 运行位置用 icon 不写文字; #3 名字前置加框; #4 悬浮某对话 → 侧边不挡的浮窗显示最近内容。
import { useEffect, useRef, useState } from "react";
import {
  MessagesSquare, Plus, RefreshCw, ChevronDown,
  Code2, Globe, SquareTerminal, Bot, Circle,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { runShell } from "../lib";
import { listPanes, focusPane, type PoofPane } from "../poofPanes";
import { getControllerKind, setControllerKind, type ControllerKind } from "../controller";

interface AgentRec {
  key?: string;
  identity?: string;
  name?: string;
  project?: string;
  role?: string;
  location?: string;
  current_task?: string;
  pty_id?: string;
  cwd?: string; // 工作目录, 跳窗按它的文件夹名匹配 VSCode 窗口
  mtime?: number; // transcript 最后活跃时间(排序用)
  running?: boolean;
}

const KIND_LABEL: Record<ControllerKind, string> = {
  codex: "Codex CLI",
  claude: "Claude CLI",
  "omni-web": "Omni 总控(web)",
};

// #2 位置 → icon
function LocIcon({ loc }: { loc?: string }) {
  const l = loc || "";
  if (l.includes("vscode")) return <Code2 size={14} />;
  if (l.includes("codex")) return <Bot size={14} />;
  if (l.includes("chrome") || l.includes("web")) return <Globe size={14} />;
  if (l.includes("poof") || l.includes("powershell")) return <SquareTerminal size={14} />;
  return <Circle size={11} />;
}

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
  const [limit, setLimit] = useState(20); // 和 Omnicompany 一致: 先 20, 拉到底再加载
  const [hover, setHover] = useState<{ key: string; top: number } | null>(null);
  const [preview, setPreview] = useState<string>("");
  const tailCache = useRef<Map<string, string>>(new Map());
  const hoverTimer = useRef<number | undefined>(undefined);

  async function refresh() {
    setPanes(listPanes());
    setLoading(true);
    try {
      // 列本机所有对话(不止在跑的), omni 已按 (在跑, 最后活跃) 排好序, 取前 limit 条
      const out = await runShell(`omni agents list --json --limit ${limit}`);
      const list: AgentRec[] = JSON.parse((out.stdout || "").trim() || "[]");
      list.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
      setAgents(list);
    } catch {
      /* omni/dashboard down — still show poof panes */
    }
    setLoading(false);
  }
  useEffect(() => {
    if (open) void refresh();
    else { setHover(null); setPreview(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, limit]);

  // 拉到底 → 多加载一批(只要这批已满 limit, 说明可能还有更多)
  function onRowsScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (!loading && agents.length >= limit && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
      setLimit((l) => l + 20);
    }
  }

  function pickKind(k: ControllerKind) {
    setKind(k);
    setControllerKind(k);
    onPickKind(k);
    setKindMenu(false);
  }

  // #4 悬浮 → 取该对话最近内容(防抖 + 缓存), 显示在右侧不挡列表的浮窗
  function onRowHover(e: React.MouseEvent, key?: string) {
    if (!key) return;
    const top = (e.currentTarget as HTMLElement).offsetTop;
    setHover({ key, top });
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    const cached = tailCache.current.get(key);
    if (cached !== undefined) { setPreview(cached); return; }
    setPreview("加载中…");
    hoverTimer.current = window.setTimeout(async () => {
      let txt = "(暂无内容)";
      try {
        const out = await runShell(`omni agents tail --key "${key}" --n 6`);
        txt = (out.stdout || "").trim() || "(暂无内容)";
      } catch { /* ignore */ }
      tailCache.current.set(key, txt);
      setPreview(txt);
    }, 250);
  }

  const panePtyIds = new Set(panes.map((p) => p.id));
  const externals = agents.filter((a) => !a.pty_id || !panePtyIds.has(a.pty_id));

  async function jumpExternal(a: AgentRec) {
    // #3 直接在 poof 这边按工作目录/项目名匹配到那个窗口并切到前台(再藏起 poof)
    const q = a.cwd || a.project || a.name || "";
    let ok = false;
    try { ok = await invoke<boolean>("focus_window", { query: q }); } catch { /* */ }
    if (!ok && a.location) {
      await runShell(`omni dispatch activate --location "${a.location}" --json`).catch(() => {});
    }
    setOpen(false);
  }

  return (
    <div className="conv-wrap">
      <div className="conv-kind">
        <button className="conv-kind-btn" onClick={() => setKindMenu((v) => !v)} title="总控用哪个 AI">
          总控 · {KIND_LABEL[kind]} <ChevronDown size={13} />
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

          <div className="conv-new-row">
            <span className="conv-new-label"><Plus size={13} /> 新对话</span>
            <button onClick={() => { onNewChat("claude"); setOpen(false); }}>Claude</button>
            <button onClick={() => { onNewChat("codex"); setOpen(false); }}>Codex</button>
            <button onClick={() => { onNewChat("ps"); setOpen(false); }}>PS</button>
          </div>

          <div className="conv-rows" onScroll={onRowsScroll} onMouseLeave={() => setHover(null)}>
            {panes.length === 0 && externals.length === 0 && (
              <div className="conv-empty">还没有在跑的对话。</div>
            )}
            {panes.map((p) => (
              <button
                key={p.id}
                className="conv-row"
                onClick={() => { focusPane(p.id); onOpenChat(); setOpen(false); }}
              >
                <span className="conv-name poof">{p.provider}</span>
                <span className="conv-loc"><SquareTerminal size={14} /></span>
                <span className="conv-row-task">{p.label}</span>
              </button>
            ))}
            {externals.map((a) => (
              <button
                key={a.key}
                className="conv-row"
                onClick={() => void jumpExternal(a)}
                onMouseEnter={(e) => onRowHover(e, a.key)}
              >
                <span className="conv-name">{a.name || a.identity}</span>
                <span className="conv-loc" title={a.location}><LocIcon loc={a.location} /></span>
                <span className="conv-row-task">{a.project ? `${a.project}·${a.role} — ` : ""}{a.current_task}</span>
              </button>
            ))}
          </div>

          {/* #4 不挡列表的右侧浮窗: 该对话最近内容 */}
          {hover && (
            <div className="conv-preview" style={{ top: Math.max(8, hover.top - 4) }}>
              {preview}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
