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
  ClipboardList,
  Stethoscope,
} from "lucide-react";
import { ContentManager } from "./content/ContentManager";
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
import { getCollection } from "./regions/notesCollection";
import { allBindings } from "./regions/boundRegistry";
import "./App.css";

// 全量诊断快照: 收集 poof 当前关键状态(笔记/绑定源/localStorage/JS堆/位置), 交给 Rust 写进报告。
function gatherDiagState(): any {
  const out: any = { time: new Date().toString(), location: location.href, ua: navigator.userAgent };
  try {
    const mem = (performance as any).memory;
    if (mem)
      out.jsHeapMB = {
        used: Math.round(mem.usedJSHeapSize / 1e6),
        total: Math.round(mem.totalJSHeapSize / 1e6),
        limit: Math.round(mem.jsHeapSizeLimit / 1e6),
      };
  } catch {
    /* ignore */
  }
  try {
    const c = getCollection();
    const metas = c.meta.docMetas;
    out.notes = {
      total: metas.length,
      live: metas.filter((m: any) => !m.trashed && !m.archived).length,
    };
  } catch {
    /* ignore */
  }
  try {
    out.boundSources = Object.values(allBindings()).map((b: any) => ({ kind: b.kind, ref: b.ref }));
  } catch {
    /* ignore */
  }
  try {
    const ls: Record<string, number> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith("poof-")) ls[k] = (localStorage.getItem(k) || "").length;
    }
    out.localStorageBytes = ls;
  } catch {
    /* ignore */
  }
  return out;
}

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
  const [diagToast, setDiagToast] = useState("");

  useEffect(() => {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinned));
  }, [pinned]);

  // 诊断快照: Ctrl+Alt+S 由 Rust 端直接截图写报告(不依赖前端 JS, 所以 poof 隐藏/卡住也能用),
  // 完成后发 poof://diag-done → 这里只弹个提示(若 main 可见)。只 main 窗口听。
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let un: (() => void) | undefined;
    listen("poof://diag-done", () => {
      setDiagToast("诊断快照已存 · 报告链接已复制 → 打开「快选内容」面板可看/管理");
      setTimeout(() => setDiagToast(""), 6000);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  // 点按钮做诊断(带上前端状态: 笔记/JS堆等, 比纯热键更全)。
  const runDiagnostic = useCallback(async () => {
    try {
      const r: any = await invoke("diagnostic_snapshot", {
        stateJson: JSON.stringify(gatherDiagState(), null, 2),
      });
      setDiagToast(`诊断快照已存(${r.windows} 个窗口截图)· 报告链接已复制剪贴板`);
    } catch (e) {
      setDiagToast("诊断失败: " + String(e));
    }
    setTimeout(() => setDiagToast(""), 6000);
  }, []);

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

  // 截图：summon the snap window. 不在这里 hide() —— summon_snap 会先抓帧(含 poof 自己)再收起 main,
  // 关 snap 时把 poof 放回来。若在这里就 hide(), poof 会在抓帧前消失 = 截不到自己。
  const startSnap = useCallback(() => {
    invoke("show_snap").catch(() => {});
  }, []);

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
    if (k === "clips") return <ContentManager />;
    return (
      <div className="pf-scroll">
        {k === "project" ? <ProjectSurface /> : k === "goals" ? <GoalsSurface /> : <ReviewSurface />}
      </div>
    );
  }

  return (
    <div className="pf-root" onMouseDown={onBackdrop}>
      {diagToast && (
        <div className="pf-diag-toast" onClick={() => setDiagToast("")}>
          📸 {diagToast}
        </div>
      )}
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
          <button
            className="pf-btn"
            onClick={runDiagnostic}
            title="全量诊断快照（截当前所有可见 poof 界面 + 状态 → 报告，复制链接。也可按 Ctrl+Alt+S）"
          >
            <Stethoscope size={17} />
          </button>
          <button
            className={"pf-btn" + (isOpen("clips") ? " on" : "")}
            onClick={() => togglePanel("clips")}
            title="快选内容（剪贴板历史 + poof 快照 + 捕获/圈选 · 预览/恢复/管理）"
          >
            <ClipboardList size={17} />
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
