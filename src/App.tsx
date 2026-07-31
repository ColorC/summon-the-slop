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
  SquareTerminal,
  Bell,
  Pin,
  PinOff,
  X,
  ClipboardList,
  Stethoscope,
  ListChecks,
} from "lucide-react";
import { ContentManager } from "./content/ContentManager";
import { SearchBar } from "./regions/SearchBar";
import { Notifications } from "./regions/Notifications";
import { TerminalBar } from "./regions/TerminalBar";
import { ProjectSurface, ReviewSurface } from "./surfaces";
import { NotesWorkspace } from "./regions/NotesWorkspace";
import { DockStage, PersistentChatDock, type PanelKind } from "./panels";
import GoalsSurface from "./goalsSurface";
import PinnedSurface from "./pinnedSurface";
import { sendToController, OMNI_WEB_URL } from "./controller";
import { startNoteBridge } from "./noteOps";
import { installInstantTooltips } from "./tooltips";
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
  // 审计原生表单控件 + iframe —— 揪"莫名其妙的原生控件"(如 number 的 ▲▼ spinner)的归属。
  // ⚠ 必须穿透 shadow DOM(BlockSuite 等 web component 把 input 藏在 shadow root, 普通 querySelectorAll
  // 看不到), 且不按尺寸过滤(可能是被压成 0 宽、只露 spinner 的输入)。host 链记录它藏在哪些自定义元素里。
  try {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const inputs: any[] = [];
    const walk = (root: Document | ShadowRoot, host: string, depth: number) => {
      if (depth > 16) return;
      let all: NodeListOf<Element>;
      try { all = root.querySelectorAll("*"); } catch { return; }
      all.forEach((el) => {
        const t = el.tagName.toLowerCase();
        if (t === "input" || t === "textarea" || t === "select") {
          inputs.push({ el: t + ((el as HTMLInputElement).type ? `[${(el as HTMLInputElement).type}]` : ""), host, ...box(el) });
        }
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr, host ? host + ">" + t : t, depth + 1);
      });
    };
    walk(document, "", 0);
    out.deepInputs = inputs;
    out.iframesAudit = Array.from(document.querySelectorAll("iframe")).map((f) => ({
      src: (f as HTMLIFrameElement).getAttribute("src") || ((f as HTMLIFrameElement).srcdoc ? "[srcdoc]" : ""),
      cls: (f.className as string) || "",
      ...box(f),
    }));
  } catch {
    /* ignore */
  }
  // 当前交互态(全量诊断的核心): 打开了哪篇笔记、选中了哪个内容块、它的内容、这篇笔记的大纲。
  try {
    const ed: any = document.querySelector("affine-editor-container");
    if (ed && ed.doc) {
      const doc = ed.doc;
      let title = "";
      try {
        const c = getCollection();
        title = c.meta.docMetas.find((m: any) => m.id === doc.id)?.title || (doc.meta as any)?.title || "";
      } catch {
        /* ignore */
      }
      // 取块内容: 自己有文本就用自己的; 容器(note 等)自己没文本 → 收子块文本(选中一篇 note 时, 这样
      // 才能看见它真正写了什么, 而不是空字符串)。
      const blockContent = (m: any, depth = 0): string => {
        if (!m || depth > 3) return "";
        const own = (m.text?.toString?.() ?? "").trim();
        if (own) return own.slice(0, 400);
        const kids: any[] = m.children ?? [];
        return kids
          .map((c) => blockContent(c, depth + 1))
          .filter(Boolean)
          .join(" ⏎ ")
          .slice(0, 400);
      };
      const blockInfo = (id: string) => {
        try {
          const m = doc.getBlock?.(id)?.model ?? doc.getBlockById?.(id) ?? null;
          return { flavour: m?.flavour, text: blockContent(m) };
        } catch {
          return {};
        }
      };
      // 选区: 覆盖文本/块选择 + 无限画布选中的元素。跳过 edgeless 光标([gfx-cursor])这种噪声。
      const noise = (id: any) => id == null || (typeof id === "string" && id.startsWith("["));
      const selectedBlocks: any[] = [];
      try {
        for (const s of (ed.std?.selection?.value ?? []) as any[]) {
          const type = s.type ?? s?.constructor?.type;
          if (type === "cursor") continue;
          if (Array.isArray(s.elements) && s.elements.length) {
            for (const id of s.elements) {
              if (noise(id)) continue;
              selectedBlocks.push({ type: type ?? "surface", blockId: id, ...blockInfo(id) });
            }
          } else {
            const blockId = s.blockId ?? s.from?.blockId ?? (Array.isArray(s.path) ? s.path[s.path.length - 1] : undefined);
            if (noise(blockId)) continue;
            selectedBlocks.push({
              type,
              blockId,
              ...blockInfo(blockId),
              from: s.from ? { index: s.from.index, length: s.from.length } : undefined,
            });
          }
        }
      } catch {
        /* ignore */
      }
      let outline: any[] = [];
      try {
        const blocks =
          doc.getBlocksByFlavour?.([
            "affine:paragraph",
            "affine:list",
            "affine:code",
            "affine:image",
            "affine:attachment",
            "affine:bookmark",
            "affine:embed-synced-doc",
          ]) ?? [];
        outline = blocks.slice(0, 20).map((b: any) => {
          const m = b?.model ?? b;
          return { id: m?.id, flavour: m?.flavour, text: (m?.text?.toString?.() ?? "").slice(0, 80) };
        });
      } catch {
        /* ignore */
      }
      out.interaction = {
        openNote: { id: doc.id, title, mode: ed.mode },
        selectedCount: selectedBlocks.length,
        selectedBlocks,
        outline,
      };
    } else {
      out.interaction = { openNote: null, note: "当前没有打开笔记编辑器" };
    }
  } catch {
    /* ignore */
  }
  // 当前打开的面板(从 DockStage 标题栏读, 两条路径都能拿到)
  try {
    out.openPanels = Array.from(document.querySelectorAll(".dock-panel")).map(
      (p) => (p.querySelector(".dock-title")?.textContent || "").trim()
    ).filter(Boolean);
  } catch {
    /* ignore */
  }
  // 全量 DOM —— 整页所有元素(穿透 shadow)。最大头, 放最后。Rust 会把它单独落 state.json。
  try {
    out.dom = gatherDom();
  } catch {
    /* ignore */
  }
  return out;
}

// 全量 DOM 快照: 把整页每个元素(穿透 shadow DOM)的 标签/id/class/位置尺寸/属性/直接文本/是否 0 尺寸
// 都记下 —— "全量信息 = 所有网页元素"。这才能让界面上任何元素级的问题(错位/塌陷/多出来/样式坏)在数据里看得见。
function gatherDom(): any {
  let count = 0;
  const MAX = 12000;
  let truncated = false;
  const node = (el: Element): any => {
    count++;
    const r = el.getBoundingClientRect();
    const o: any = { tag: el.tagName.toLowerCase() };
    if (el.id) o.id = el.id;
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    if (cls) o.cls = cls.length > 140 ? cls.slice(0, 140) + "…" : cls;
    o.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    if (r.width === 0 || r.height === 0) o.zero = true; // 0 尺寸: 隐藏/塌陷, 可疑
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name === "id" || a.name === "class" || a.name === "style") continue;
      attrs[a.name] = a.value.length > 80 ? a.value.slice(0, 80) + "…" : a.value;
    }
    if (Object.keys(attrs).length) o.attrs = attrs;
    const dt = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && (n.textContent || "").trim())
      .map((n) => (n.textContent || "").trim())
      .join(" ");
    if (dt) o.text = dt.length > 200 ? dt.slice(0, 200) + "…" : dt;
    const kids: any[] = [];
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) {
      o.shadowHost = true;
      for (const c of Array.from(sr.children)) {
        if (count >= MAX) { truncated = true; break; }
        kids.push(node(c));
      }
    }
    for (const c of Array.from(el.children)) {
      if (count >= MAX) { truncated = true; break; }
      kids.push(node(c));
    }
    if (kids.length) o.children = kids;
    return o;
  };
  const tree = node(document.documentElement);
  return { count, truncated, max: MAX, tree };
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

  // 点按钮做诊断(带上前端状态: 笔记/JS堆等, 比纯热键更全)。完成后由 Rust 弹独立的小提示窗
  // (底部居中、不抢焦点、无声, poof 藏着也能看见), 所以这里成功不再弹 —— 只在出错时就地提示。
  const runDiagnostic = useCallback(async () => {
    try {
      await invoke("diagnostic_snapshot", {
        stateJson: JSON.stringify(gatherDiagState(), null, 2),
      });
    } catch (e) {
      setDiagToast("诊断失败: " + String(e));
      setTimeout(() => setDiagToast(""), 6000);
    }
  }, []);

  // 热键诊断时 Rust 用 eval 直接调 main 里的 __reportDiagState(事件系统对这类回传不稳, eval 最稳),
  // 它把和按钮路径一样的 gatherDiagState 回传给 Rust → 纯热键拍的快照也带全量信息(不再只有几个数字)。
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    (window as any).__reportDiagState = () => {
      try {
        invoke("report_diag_state", { json: JSON.stringify(gatherDiagState(), null, 2) }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
  }, []);

  // #7 笔记 ops 桥: 后台轮询文件命令(omni notes), 在活笔记 collection 上执行。常驻(笔记面板不开也能改)。
  useEffect(() => {
    startNoteBridge();
  }, []);

  // 全局即时提示: 所有带 data-tip/title 的按钮悬浮立刻显示名称(无延迟)
  useEffect(() => installInstantTooltips(), []);

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
    if (k === "clips") return <ContentManager />;
    return (
      <div className="pf-scroll">
        {k === "project" ? <ProjectSurface /> : k === "goals" ? <GoalsSurface /> : k === "pinned" ? <PinnedSurface /> : <ReviewSurface />}
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
        open={open.filter((k) => k !== "notes" && k !== "chat")}
        pinned={pinned}
        onPin={togglePin}
        onClose={closePanel}
        renderContent={panelContent}
      />

      {/* 对话 / 终端 — 常驻挂载(不进 DockStage), 关面板/召出只隐藏不卸载, 终端与对话会话一直保留 */}
      <PersistentChatDock open={isOpen("chat")} onClose={() => closePanel("chat")}>
        <TerminalBar />
      </PersistentChatDock>

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
          {/* 面板 — 工作区与内容 */}
          <button className={"pf-btn" + (isOpen("notes") ? " on" : "")} onClick={() => togglePanel("notes")} data-tip="笔记空间">
            <PenLine size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("project") ? " on" : "")} onClick={() => togglePanel("project")} data-tip="项目">
            <FolderKanban size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("goals") ? " on" : "")} onClick={() => togglePanel("goals")} data-tip="目标 / 任务">
            <Target size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("pinned") ? " on" : "")} onClick={() => togglePanel("pinned")} data-tip="当前任务（置顶）">
            <ListChecks size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("review") ? " on" : "")} onClick={() => togglePanel("review")} data-tip="审阅台">
            <CheckSquare size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("chat") ? " on" : "")} onClick={() => togglePanel("chat")} data-tip="终端 / 对话">
            <SquareTerminal size={17} />
          </button>
          <button className={"pf-btn" + (isOpen("clips") ? " on" : "")} onClick={() => togglePanel("clips")} data-tip="快选内容（剪贴板 · 快照）">
            <ClipboardList size={17} />
          </button>
          <span className="pf-sep" />
          {/* 抓取 — 截图 / 圈选 / 录屏 / 回放 / 诊断 */}
          <button className="pf-btn" onClick={startSnap} data-tip="截图 / 标注">
            <Camera size={17} />
          </button>
          <button className="pf-btn" onClick={startInspect} data-tip="圈选 / 洞察">
            <ScanEye size={17} />
          </button>
          <button className="pf-btn" onClick={startScreenRecord} data-tip="录屏">
            <MonitorPlay size={17} />
          </button>
          <button className="pf-btn" onClick={runDiagnostic} data-tip="全量诊断快照（Ctrl+Alt+S）">
            <Stethoscope size={17} />
          </button>
          <span className="pf-sep" />
          {/* 系统 */}
          <button className={"pf-btn" + (notifOpen ? " on" : "")} onClick={() => setNotifOpen((o) => !o)} data-tip="通知">
            <Bell size={17} />
          </button>
          <button className="pf-btn" onClick={toggleOnTop} data-tip="钉屏（始终置顶）">
            {onTop ? <Pin size={17} /> : <PinOff size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
