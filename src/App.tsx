import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  MessageSquarePlus,
  PenLine,
  FolderKanban,
  CheckSquare,
  SquareTerminal,
  Camera,
  ScanEye,
  Video,
  Film,
  Bell,
  Pin,
  PinOff,
} from "lucide-react";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { TerminalBar } from "./regions/TerminalBar";
import { ProjectSurface, ReviewSurface } from "./surfaces";
import { NotesWorkspace } from "./regions/NotesWorkspace";
import { DockStage, type PanelKind } from "./panels";
import { pushChatIntent } from "./chatIntents";
import { dispatchMessage } from "./dispatch";
import "./App.css";

const PIN_KEY = "poof-panels-pinned";
function loadPinned(): PanelKind[] {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
  } catch {
    return [];
  }
}

/** The overlay: a top search pill + a bottom action bar (always above everything), and a
 *  middle "stage" hosting draggable/resizable panels (chat / project / review / notes).
 *  Panels default-dock to the right, can be floated, remember geometry, and can be pinned
 *  to survive summons. No dimming — panels are opaque. The window is fixed-fullscreen. */
export default function App() {
  const [pinned, setPinned] = useState<PanelKind[]>(loadPinned);
  const [open, setOpen] = useState<PanelKind[]>(() => loadPinned());
  const [notifOpen, setNotifOpen] = useState(false);
  const [onTop, setOnTop] = useState(true);

  useEffect(() => {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinned));
  }, [pinned]);

  const isOpen = (k: PanelKind) => open.includes(k);
  const openPanel = useCallback(
    (k: PanelKind) => setOpen((o) => (o.includes(k) ? o : [...o, k])),
    []
  );
  const closePanel = useCallback((k: PanelKind) => setOpen((o) => o.filter((x) => x !== k)), []);
  const togglePanel = (k: PanelKind) => (isOpen(k) ? closePanel(k) : openPanel(k));
  const togglePin = (k: PanelKind) =>
    setPinned((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const hide = useCallback(() => {
    getCurrentWindow().hide();
    setNotifOpen(false);
    setOpen(loadPinned()); // keep only pinned panels across summons
  }, []);

  const toggleOnTop = useCallback(async () => {
    const v = !onTop;
    await getCurrentWindow().setAlwaysOnTop(v);
    setOnTop(v);
  }, [onTop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (notifOpen) setNotifOpen(false);
      else if (open.some((k) => !pinned.includes(k))) setOpen(pinned); // close non-pinned first
      else hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notifOpen, open, pinned, hide]);

  // 活体洞察：hide poof (Rust side) so the real desktop is exposed, then the native
  // highlight + element_from_point loop takes over until Esc.
  const startInspect = useCallback(() => {
    invoke("start_inspect").catch(() => {});
    hide();
  }, [hide]);

  // 截图：hide poof, summon the transparent snap window (freeze + annotate + copy/save/pin/OCR).
  const startSnap = useCallback(() => {
    invoke("show_snap").catch(() => {});
    hide();
  }, [hide]);

  // 录制：hide poof, open the record window (rrweb session recording → JSONL for AI).
  const startRecord = useCallback(() => {
    invoke("show_record").catch(() => {});
    hide();
  }, [hide]);

  // 回放：open the replay window to watch a recorded session.
  const startReplay = useCallback(() => {
    invoke("show_replay").catch(() => {});
    hide();
  }, [hide]);

  function newChat(provider: string, query?: string) {
    openPanel("chat");
    pushChatIntent(provider, query);
  }
  // 新对话: 空 → 直接开一个 claude 终端; 有内容 → 先过 omni 总控路由(本机 sonnet 中思考),
  // 再按 5 类执行(新起/发给已有/问)。路由是异步的, 不挡 UI。
  const askAI = (query: string) => {
    const q = (query || "").trim();
    if (!q) {
      newChat("claude");
      return;
    }
    openPanel("chat");
    void dispatchMessage(q, { newChat, openChat: () => openPanel("chat") });
  };
  const onLaunched = () => hide();

  function onBackdrop(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (notifOpen) setNotifOpen(false);
    else if (open.some((k) => !pinned.includes(k))) setOpen(pinned);
    else hide();
  }

  function panelContent(k: PanelKind) {
    if (k === "chat") return <TerminalBar />;
    return (
      <div className="pf-scroll">{k === "project" ? <ProjectSurface /> : <ReviewSurface />}</div>
    );
  }

  return (
    <div className="pf-root" onMouseDown={onBackdrop}>
      {/* middle band — real dock: panels are flush-to-edge, full-height sidebars
          (left / right) with a drag-sash on the inner seam, or floating cards.
          Notes is NOT a panel here (a CSS transform would break BlockSuite's
          pointer math); it renders as its own fixed fullscreen workspace below. */}
      <DockStage
        open={open.filter((k) => k !== "notes")}
        pinned={pinned}
        onPin={togglePin}
        onClose={closePanel}
        renderContent={panelContent}
      />

      {/* 笔记空间 — fixed fullscreen (no transform), persistent BlockSuite library */}
      {open.includes("notes") && <NotesWorkspace onClose={() => closePanel("notes")} />}

      {/* top search */}
      <div className="pf-top" onMouseDown={(e) => e.stopPropagation()}>
        <SearchBar onAskAI={askAI} onLaunched={onLaunched} />
      </div>

      {/* bottom action bar */}
      <div className="pf-bottom" onMouseDown={(e) => e.stopPropagation()}>
        {notifOpen && (
          <div className="pf-notif">
            <Notifications />
          </div>
        )}
        <div className="pf-bar">
          <button className="pf-btn accent" onClick={() => askAI("")} title="新对话 (Claude/Codex CLI)">
            <MessageSquarePlus size={17} /> 新对话
          </button>
          <span className="pf-sep" />
          <button
            className={"pf-btn" + (isOpen("notes") ? " on" : "")}
            onClick={() => togglePanel("notes")}
            title="笔记空间"
          >
            <PenLine size={17} />
          </button>
          <button
            className={"pf-btn" + (isOpen("project") ? " on" : "")}
            onClick={() => togglePanel("project")}
            title="项目"
          >
            <FolderKanban size={17} />
          </button>
          <button
            className={"pf-btn" + (isOpen("review") ? " on" : "")}
            onClick={() => togglePanel("review")}
            title="审阅台"
          >
            <CheckSquare size={17} />
          </button>
          <button
            className={"pf-btn" + (isOpen("chat") ? " on" : "")}
            onClick={() => togglePanel("chat")}
            title="终端 / 对话"
          >
            <SquareTerminal size={17} />
          </button>
          <span className="pf-sep" />
          <button className="pf-btn" onClick={startSnap} title="截图 / 标注（框选 → 标注 → 复制 / 保存 / 钉屏 / OCR · Esc 退出）">
            <Camera size={17} />
          </button>
          <button className="pf-btn" onClick={startInspect} title="圈选 / 洞察（系统级 · 指哪看哪 · 点击抓取元素 → 带信息的截图给 AI · Esc 退出）">
            <ScanEye size={17} />
          </button>
          <button className="pf-btn" onClick={startRecord} title="录制（rrweb 会话录像 → 给 AI 看的语义事件流，非视频）">
            <Video size={17} />
          </button>
          <button className="pf-btn" onClick={startReplay} title="回放（看录制的会话）">
            <Film size={17} />
          </button>
          <span className="pf-sep" />
          <button
            className={"pf-btn" + (notifOpen ? " on" : "")}
            onClick={() => setNotifOpen((o) => !o)}
            title="通知"
          >
            <Bell size={17} />
          </button>
          <button className="pf-btn" onClick={toggleOnTop} title="钉屏（始终置顶）">
            {onTop ? <Pin size={17} /> : <PinOff size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
