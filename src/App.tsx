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
} from "lucide-react";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { NoteSurface } from "./surfaces";
import { openView, newChat } from "./lib";
import "./App.css";

/** Summoned overlay = small floating widgets over a transparent screen.
 *  shade mode: search pill (top) + action bar (bottom). canvas mode: the infinite
 *  notes canvas fills the overlay (← back / →switch). Opening a heavy window dims the
 *  overlay and switches dismiss to Esc-only; otherwise click-outside dismisses. */
export default function App() {
  const [mode, setMode] = useState<"shade" | "canvas">("shade");
  const [windowOpen, setWindowOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [pinned, setPinned] = useState(true);

  const hide = useCallback(() => {
    getCurrentWindow().hide();
    setWindowOpen(false);
    setNotifOpen(false);
    setMode("shade");
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
        else if (mode === "canvas") setMode("shade");
        else hide();
      } else if (e.key === "ArrowRight" && mode === "shade" && !notifOpen) {
        setMode("canvas");
      } else if (e.key === "ArrowLeft" && mode === "canvas") {
        setMode("shade");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notifOpen, mode, hide]);

  function openWin(view: string) {
    openView(view).catch(() => {});
    setWindowOpen(true);
    setNotifOpen(false);
  }
  function askAI(query: string) {
    newChat("claude", query || undefined).catch(() => {});
    setWindowOpen(true);
  }
  function onLaunched() {
    hide();
  }

  function onBackdrop(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (notifOpen) {
      setNotifOpen(false);
      return;
    }
    if (windowOpen) return; // a window is open → Esc-only
    if (mode === "canvas") {
      setMode("shade");
      return;
    }
    hide();
  }

  return (
    <div className={"pf-root" + (windowOpen ? " dim" : "")} onMouseDown={onBackdrop}>
      {mode === "canvas" ? (
        <div className="pf-canvas" onMouseDown={(e) => e.stopPropagation()}>
          <button className="pf-canvas-back" onClick={() => setMode("shade")}>
            <ChevronLeft size={16} /> 返回 (←)
          </button>
          <NoteSurface />
        </div>
      ) : (
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
              <button className="pf-btn" onClick={() => setMode("canvas")} title="笔记画布 (→)">
                <PenLine size={17} />
              </button>
              <button className="pf-btn" onClick={() => openWin("project")} title="项目">
                <FolderKanban size={17} />
              </button>
              <button className="pf-btn" onClick={() => openWin("review")} title="审阅台">
                <CheckSquare size={17} />
              </button>
              <button className="pf-btn" onClick={() => openWin("terminal")} title="终端">
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
    </div>
  );
}
