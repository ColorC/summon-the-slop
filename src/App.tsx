import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PenLine,
  FolderKanban,
  Target,
  CheckSquare,
  Camera,
  ScanEye,
  MonitorPlay,
  Film,
  SquareTerminal,
  Bell,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { TerminalBar } from "./regions/TerminalBar";
import { ConvBar } from "./regions/ConvBar";
import { ProjectSurface, ReviewSurface } from "./surfaces";
import { NotesWorkspace } from "./regions/NotesWorkspace";
import { DockStage, type PanelKind } from "./panels";
import GoalsSurface from "./goalsSurface";
import { pushChatIntent } from "./chatIntents";
import { sendToController, OMNI_WEB_URL } from "./controller";
import { startNoteBridge } from "./noteOps";
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

  // #7 笔记 ops 桥: 后台轮询文件命令(omni notes), 在活笔记 collection 上执行。常驻(笔记面板不开也能改)。
  useEffect(() => {
    startNoteBridge();
  }, []);

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
    // #4 隐藏 ≠ 关闭: 不动任何面板/对话(你可能只是想藏一下待会儿还用)。
    // 只有显式关页签(面板 X / 终端 tab X)才真关。
  }, []);

  const [omniWeb, setOmniWeb] = useState(false);

  const toggleOnTop = useCallback(async () => {
    const v = !onTop;
    await getCurrentWindow().setAlwaysOnTop(v);
    setOnTop(v);
  }, [onTop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (notifOpen) setNotifOpen(false);
      else hide(); // #4 不再关面板/对话, 只收通知或隐藏窗口
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notifOpen, hide]);

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

  // 录屏：hide poof, summon the snap overlay in 录制模式 (框选窗口/区域 → 关键帧+OCR). No hotkey
  // (low-frequency) — invoked from this 快捷面板. Stop via the rec bar's ■ 停止.
  const startScreenRecord = useCallback(() => {
    invoke("show_snap_record").catch(() => {});
    hide();
  }, [hide]);

  // Ctrl+Alt+N (Rust) shows main + emits open-notes → open the fullscreen 笔记 workspace.
  useEffect(() => {
    const un = listen("open-notes", () => openPanel("notes"));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [openPanel]);

  // 召唤: 双击Ctrl(payload !== true) → 干净搜索, 收起侧栏面板(记住,供三击还原);
  //        三击Ctrl(payload === true) → 还原上次的面板布局。
  const prevOpen = useRef<PanelKind[]>([]);
  useEffect(() => {
    const un = listen<boolean>("summon", (e) => {
      if (e.payload === true) {
        setOpen((o) => (o.length ? o : prevOpen.current.length ? prevOpen.current : loadPinned()));
      } else {
        setOpen((o) => { if (o.length) prevOpen.current = o; return []; });
        setNotifOpen(false);
      }
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  // 回放：open the replay window to watch a recorded session.
  const startReplay = useCallback(() => {
    invoke("show_replay").catch(() => {});
    hide();
  }, [hide]);

  function newChat(provider: string, query?: string, cwd?: string) {
    openPanel("chat");
    pushChatIntent(provider, query, cwd);
  }
  // 顶部输入框发消息 → 送给总控(可见、持续的 codex/claude 对话, 或 omni-web)。不后台。
  const askAI = (query: string) => {
    const q = (query || "").trim();
    if (!q) {
      openPanel("chat");
      return;
    }
    sendToController(q, {
      openChat: () => openPanel("chat"),
      openOmniWeb: () => setOmniWeb(true),
    });
  };
  const onLaunched = () => hide();

  function onBackdrop(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (notifOpen) setNotifOpen(false);
    else hide(); // #4 点空白也只隐藏, 不关对话
  }

  function panelContent(k: PanelKind) {
    if (k === "chat") return <TerminalBar />;
    return (
      <div className="pf-scroll">
        {k === "project" ? <ProjectSurface /> : k === "goals" ? <GoalsSurface /> : <ReviewSurface />}
      </div>
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

      {/* 总控选 omni-web 时: 嵌 omnidashboard 现成的 BOSS SIGHT 总控对话界面 */}
      {omniWeb && (
        <div className="omni-web" onMouseDown={(e) => e.stopPropagation()}>
          <button className="omni-web-x" onClick={() => setOmniWeb(false)} title="关闭">
            <X size={16} />
          </button>
          <iframe className="omni-web-frame" src={OMNI_WEB_URL} title="Omni 总控" />
        </div>
      )}

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
          <ConvBar
            onNewChat={(provider) => newChat(provider)}
            onOpenChat={() => openPanel("chat")}
            onPickKind={(k) => {
              if (k === "omni-web") setOmniWeb(true);
            }}
          />
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
            className={"pf-btn" + (isOpen("goals") ? " on" : "")}
            onClick={() => togglePanel("goals")}
            title="目标 / 任务（whatnow · 北极星/主线/支线 + 进度）"
          >
            <Target size={17} />
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
            title="终端 / 对话（PowerShell · Claude · Codex）"
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
          <button className="pf-btn" onClick={startScreenRecord} title="录屏（框选窗口 / 区域 → 定时画面快照 + OCR 文字 + 焦点，给 AI 读 · 录制条上 ■ 停止）">
            <MonitorPlay size={17} />
          </button>
          <button className="pf-btn" onClick={startReplay} title="回放（看录制的会话 · 导出 AI 时间线）">
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
