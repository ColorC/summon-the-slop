import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  MessageSquarePlus,
  PenLine,
  FolderKanban,
  CheckSquare,
  SquareTerminal,
  Bell,
  Pin,
  PinOff,
  ChevronLeft,
  X,
} from "lucide-react";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { TerminalBar } from "./regions/TerminalBar";
import { NoteSurface, ProjectSurface, ReviewSurface } from "./surfaces";
import "./App.css";

type Panel = "home" | "canvas" | "project" | "review";

/** The whole experience lives INSIDE the summoned overlay (no separate OS windows):
 *  search pill (top) + action bar (bottom); a center panel for canvas/project/review;
 *  a right side panel for the AI terminal ("侧边对话"). Transparent, no dim until a
 *  panel/chat opens (then the rest dims; Esc steps back). */
export default function App() {
  const [panel, setPanel] = useState<Panel>("home");
  const [chatOpen, setChatOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [pinned, setPinned] = useState(true);

  const hide = useCallback(() => {
    getCurrentWindow().hide();
    setNotifOpen(false);
    setPanel("home");
    setChatOpen(false);
  }, []);
  const togglePin = useCallback(async () => {
    const v = !pinned;
    await getCurrentWindow().setAlwaysOnTop(v);
    setPinned(v);
  }, [pinned]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (notifOpen) setNotifOpen(false);
        else if (chatOpen) setChatOpen(false);
        else if (panel !== "home") setPanel("home");
        else hide();
      } else if (e.key === "ArrowRight" && panel === "home" && !chatOpen && !notifOpen) {
        setPanel("canvas");
      } else if (e.key === "ArrowLeft" && panel === "canvas") {
        setPanel("home");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notifOpen, chatOpen, panel, hide]);

  function newChat(provider: string, query?: string) {
    setChatOpen(true);
    window.dispatchEvent(new CustomEvent("poof-new-chat", { detail: { provider, query } }));
  }
  function askAI(query: string) {
    newChat("claude", query || undefined);
  }
  function onLaunched() {
    hide();
  }

  function onBackdrop(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (notifOpen) setNotifOpen(false);
    else if (chatOpen) setChatOpen(false);
    else if (panel !== "home") setPanel("home");
    else hide();
  }

  const dim = chatOpen || panel !== "home";

  return (
    <div className={"pf-root" + (dim ? " dim" : "")} onMouseDown={onBackdrop}>
      {/* center: canvas (fullscreen, transparent) */}
      {panel === "canvas" && (
        <div className="pf-center canvas" onMouseDown={(e) => e.stopPropagation()}>
          <button className="pf-back" onClick={() => setPanel("home")}>
            <ChevronLeft size={16} /> 返回 (←)
          </button>
          <NoteSurface />
        </div>
      )}
      {/* center: project / review (card) */}
      {(panel === "project" || panel === "review") && (
        <div className="pf-center card" onMouseDown={(e) => e.stopPropagation()}>
          <div className="pf-card-head">
            <span>{panel === "project" ? "项目" : "审阅台"}</span>
            <button className="pf-icon-btn" onClick={() => setPanel("home")}>
              <X size={16} />
            </button>
          </div>
          <div className="pf-card-body">
            {panel === "project" ? <ProjectSurface /> : <ReviewSurface />}
          </div>
        </div>
      )}

      {/* top search + bottom bar (hidden in canvas mode) */}
      {panel !== "canvas" && (
        <>
          <div className="pf-top" onMouseDown={(e) => e.stopPropagation()}>
            <SearchBar onAskAI={askAI} onLaunched={onLaunched} />
          </div>
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
              <button className="pf-btn" onClick={() => setPanel("canvas")} title="笔记画布 (→)">
                <PenLine size={17} />
              </button>
              <button className="pf-btn" onClick={() => setPanel("project")} title="项目">
                <FolderKanban size={17} />
              </button>
              <button className="pf-btn" onClick={() => setPanel("review")} title="审阅台">
                <CheckSquare size={17} />
              </button>
              <button
                className={"pf-btn" + (chatOpen ? " on" : "")}
                onClick={() => setChatOpen((o) => !o)}
                title="终端 / 对话"
              >
                <SquareTerminal size={17} />
              </button>
              <span className="pf-sep" />
              <button
                className={"pf-btn" + (notifOpen ? " on" : "")}
                onClick={() => setNotifOpen((o) => !o)}
                title="通知"
              >
                <Bell size={17} />
              </button>
              <button className="pf-btn" onClick={togglePin} title="钉屏">
                {pinned ? <Pin size={17} /> : <PinOff size={17} />}
              </button>
            </div>
          </div>
        </>
      )}

      {/* right side panel: AI terminal — always mounted to keep PTY sessions alive */}
      <div className={"pf-chat" + (chatOpen ? " open" : "")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="pf-chat-head">
          <span>对话 / 终端</span>
          <button className="pf-icon-btn" onClick={() => setChatOpen(false)}>
            <X size={16} />
          </button>
        </div>
        <TerminalBar />
      </div>
    </div>
  );
}
