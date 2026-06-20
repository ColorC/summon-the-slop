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
  Bell,
  Pin,
  PinOff,
} from "lucide-react";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { TerminalBar } from "./regions/TerminalBar";
import { ProjectSurface, ReviewSurface } from "./surfaces";
import { NotesWorkspace } from "./regions/NotesWorkspace";
import { PanelFrame, type PanelKind } from "./panels";
import { pushChatIntent } from "./chatIntents";
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

  function newChat(provider: string, query?: string) {
    openPanel("chat");
    pushChatIntent(provider, query);
  }
  const askAI = (query: string) => newChat("claude", query || undefined);
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
      {/* middle stage — draggable panels live here, between the two bars.
          Notes is NOT a draggable panel (a CSS transform would break BlockSuite's
          pointer math); it renders as its own fixed fullscreen workspace below. */}
      <div className="pf-stage" onMouseDown={(e) => e.stopPropagation()}>
        {open
          .filter((k) => k !== "notes")
          .map((k) => (
            <PanelFrame
              key={k}
              kind={k}
              pinned={pinned.includes(k)}
              onPin={() => togglePin(k)}
              onClose={() => closePanel(k)}
            >
              {panelContent(k)}
            </PanelFrame>
          ))}
      </div>

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
