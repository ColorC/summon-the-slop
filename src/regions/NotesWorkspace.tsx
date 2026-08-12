import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Search,
  X,
  Maximize2,
  Minimize2,
  Trash2,
  Hash,
  PanelLeft,
  Pencil,
  Copy,
  Archive,
  ArchiveRestore,
  RotateCcw,
  Star,
  ArrowDownUp,
  History,
  Save,
  SquareTerminal,
  Link2,
  LayoutGrid,
  FolderInput,
} from "lucide-react";
import { copyText, notesDocDel, notesMdDel, notesRoot } from "../lib";
import { TagChip } from "../lib/tagchip";
import { insertAiBlock, AiBlockSpec, mountAiToolbarButton, killAllAiTerminals } from "../blocks/aiblock";
import {
  FileSearchConfig,
  localizeSlashMenu,
  installChromeTranslator,
  mountNoteExpandButton,
  installFileTemplateSearch,
} from "../editorConfig";
import * as Y from "yjs";
import "@toeverything/theme/style.css";
import { DocCollection, Job, Text, type Doc } from "@blocksuite/store";
import { listVersions, saveVersion, deleteVersionsFor, type NoteVersion } from "./noteVersions";
import { AffineEditorContainer } from "@blocksuite/presets";
import { OverrideThemeExtension } from "@blocksuite/affine-shared/services";
import { signal } from "@preact/signals-core";
import { getCollection } from "./notesCollection";
import { installFileWriteback, installMdPreviewToggle, insertFileIntoNote } from "./fileInsert";
import { installBoundSync } from "./boundSource";
import { isBoundSubDoc } from "./boundRegistry";
import { flushNotesStore, getCachedTitle, setCachedTitle } from "./fileNotesStore";
import { scheduleNoteExport, rebuildNotesIndex, exportNoteToMd } from "./noteExport";
import { installMarkdownPaste } from "./markdownPaste";
import { installOmniRefJump } from "./omniLink";
import { installShapeTextStabilityGuard } from "./shapeTextGuard";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CardGeometry, SessionNoteCard } from "./SessionNotesCanvas";
import {
  getActiveNoteSession,
  sessionFromLocation,
  subscribeNoteSession,
  type NoteSession,
} from "../noteSession";

const BrowsePanel = lazy(() =>
  import("./BrowsePanel").then((module) => ({ default: module.BrowsePanel }))
);
const SessionNotesCanvas = lazy(() =>
  import("./SessionNotesCanvas").then((module) => ({ default: module.SessionNotesCanvas }))
);
const TerminalView = lazy(() =>
  import("./Terminal").then((module) => ({ default: module.TerminalView }))
);

// DARK theme everywhere (canvas + 弹层/菜单都深底浅字, 跟 poof 的暗色玻璃悬浮层哲学一致)。
// 唯独"笔记方框(affine-note)"在 CSS 里被改成米色纸 + 深字 —— 只改方框, 不动主题/画布。
// (slash 菜单等弹层挂在 document.body 上, 不在 affine-note 子树, 所以方框作用域的深字覆盖不会染到它们。)
const THEME = signal("dark" as any);
const DARK_THEME = OverrideThemeExtension({
  getAppTheme: () => THEME,
  getEdgelessTheme: () => THEME,
});

/**
 * BlockSuite 0.19 can briefly retain both a canvas selection and a rich-text
 * selection.  Its global Delete hotkey then reaches both handlers: the shape
 * disappears as intended, while the stale caret also deletes note content.
 * Own destructive canvas deletion at the editor capture boundary so exactly
 * one selection domain is allowed to mutate the document.
 */
function installSafeEdgelessDelete(
  editor: AffineEditorContainer,
  doc: any,
  noteId: string,
  collection: any,
  notify: (message: string) => void
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const root: any = editor.querySelector("affine-edgeless-root");
    const service = root?.service;
    const selection = service?.selection;
    const selected: any[] = [...(selection?.selectedElements ?? [])];
    if (!root || !service || service.locked || selection?.editing || !selected.length) return;
    if (selected.some((element) => element?.isLocked?.())) return;

    // Do not let the same physical key reach BlockSuite's stale rich-text
    // selection and its global edgeless selection handler independently.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    try {
      root.std?.selection?.clear?.(["text"]);
      window.getSelection()?.removeAllRanges();

      // Persist a restart-safe recovery point before every destructive canvas
      // action.  In-memory undo cannot survive closing and reopening the app.
      void saveVersion(noteId, Y.encodeStateAsUpdate(doc.spaceDoc), "删除前");
      doc.captureSync?.();

      const noteCount = selected.filter((element) => element?.flavour === "affine:note").length;
      // A note is the document's background/content container.  If it is
      // accidentally co-selected with ordinary shapes, keep the note and only
      // delete the ordinary canvas elements.
      const deletionTargets = noteCount > 0 && noteCount < selected.length
        ? selected.filter((element) => element?.flavour !== "affine:note")
        : selected;
      if (deletionTargets.length !== selected.length) {
        notify("检测到正文背景与图形同时被选中：已保留正文，只删除图形");
      }

      const doomed = new Map<string, any>();
      for (const element of deletionTargets) {
        doomed.set(element.id, element);
        try {
          for (const connector of service.getConnectors?.(element) ?? []) {
            doomed.set(connector.id, connector);
          }
        } catch {
          /* elements without connectors */
        }
      }
      for (const element of doomed.values()) {
        if (element?.flavour === "affine:note") {
          // Match BlockSuite's own invariant: never delete the last note.
          if ((doc.root?.children?.length ?? 0) > 1) doc.deleteBlock(element);
        } else {
          service.removeElement(element.id);
        }
      }
      selection.clear();
      // A deleted text/shape element must not leave the insertion tool armed;
      // otherwise every later canvas click creates another text element.
      root.gfx?.tool?.setTool?.("default", undefined);
      doc.captureSync?.();
      scheduleNoteExport(doc, collection);
      window.setTimeout(() => void flushNotesStore(), 500);
    } catch (error) {
      notify(`删除被安全拦截：${String(error)}`);
    }
  };

  editor.addEventListener("keydown", onKeyDown, true);
  return () => editor.removeEventListener("keydown", onKeyDown, true);
}

function seedDoc(
  c: DocCollection,
  seed?: { title?: string; text?: string; sessionId?: string; geometry?: CardGeometry }
): Doc {
  const doc = c.createDoc();
  const title = seed?.title?.trim() || "未命名笔记";
  const geometry = seed?.geometry || { x: 0, y: 0, width: 440, height: 620 };
  doc.load(() => {
    const rootId = doc.addBlock("affine:page", { title: new Text(title) });
    doc.addBlock("affine:surface", {}, rootId);
    const noteId = doc.addBlock(
      "affine:note",
      { xywh: `[${geometry.x},${geometry.y},${geometry.width},${geometry.height}]` },
      rootId
    );
    if (seed) {
      doc.addBlock("affine:paragraph", { text: new Text(seed.text || "") }, noteId);
    } else {
      // 传统手动新建仍保留标题+正文结构；会话札记走上面的单段落轻量结构。
      doc.addBlock("affine:paragraph", { type: "h1" as any }, noteId);
      doc.addBlock("affine:paragraph", {}, noteId);
    }
  });
  c.setDocMeta(doc.id, {
    title,
    sessionId: seed?.sessionId,
    updatedDate: Date.now(),
  } as any);
  setCachedTitle(doc.id, title);
  return doc;
}

function parseXywh(value: unknown): CardGeometry {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(Number.isFinite)) {
      return { x: parsed[0], y: parsed[1], width: parsed[2], height: parsed[3] };
    }
  } catch {
    /* fall through */
  }
  return { x: 80, y: 72, width: 420, height: 320 };
}

function textOfBlock(model: any): string {
  const own = model?.text?.toString?.() || "";
  if (own) return own;
  return (model?.children || []).map(textOfBlock).filter(Boolean).join("\n");
}

function flowCardsOf(doc: any): SessionNoteCard[] {
  if (!doc) return [];
  try {
    doc.load();
    return (doc.getBlocksByFlavour?.(["affine:note"]) || []).map((block: any, index: number) => {
      const model = block?.model ?? block;
      const children = model?.children || [];
      const editable =
        children.length === 1 &&
        children[0]?.flavour === "affine:paragraph" &&
        !(children[0]?.children || []).length;
      const geometry = parseXywh(model?.xywh);
      return {
        id: model.id,
        title:
          index === 0
            ? ((doc.meta as any)?.title || getCachedTitle(doc.id) || "会话札记")
            : `札记 ${index + 1}`,
        text: editable ? children[0]?.text?.toString?.() || "" : textOfBlock(model),
        ...geometry,
        editable,
        detail: editable ? undefined : "为避免破坏既有富文本结构，新画布暂时只读展示这张卡片。",
      };
    });
  } catch {
    return [];
  }
}

/** first non-empty paragraph/heading text — the note's auto-title (no editor needed).
 *  正文都空时退到 代码块首行 / 附件名, 让"拖文件进去"生成的笔记也能自动有标题。
 *  规则与 fileNotesStore.scanYdoc 保持一致, 否则启动回填的标题会在打开笔记时被算回空。 */
function firstLineOf(doc: any): string {
  try {
    const text = doc.getBlocksByFlavour(["affine:paragraph", "affine:list"]) || [];
    for (const b of text) {
      const s = (b?.model ?? b)?.text?.toString?.().trim(); // getBlocksByFlavour 返回 Block(.model)
      if (s) return s.slice(0, 80);
    }
    const code = doc.getBlocksByFlavour(["affine:code"]) || [];
    for (const b of code) {
      const s = (b?.model ?? b)?.text?.toString?.().trim();
      if (s) return s.split("\n")[0].slice(0, 80);
    }
    const att = doc.getBlocksByFlavour(["affine:attachment", "affine:bookmark", "affine:image"]) || [];
    for (const b of att) {
      const m = b?.model ?? b;
      const s = (m?.name ?? m?.title ?? m?.caption)?.toString?.().trim?.();
      if (s) return String(s).slice(0, 80);
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function duplicateDoc(c: DocCollection, id: string): Promise<string | null> {
  const doc = c.getDoc(id);
  if (!doc) return null;
  doc.load();
  try {
    const job = new Job({ collection: c as any });
    const snap = (job as any).docToSnapshot(doc);
    if (!snap) return null;
    const nd = await (job as any).snapshotToDoc(snap);
    const dupTitle = ((doc.meta as any)?.title || getCachedTitle(id) || "未命名笔记") + " 副本";
    c.setDocMeta(nd.id, { title: dupTitle, updatedDate: Date.now() } as any);
    setCachedTitle(nd.id, dupTitle); // 副本的页标题多为空, docMeta 会被刷掉 → 同时写显示缓存才稳得住
    return nd.id;
  } catch {
    return null;
  }
}

// remember the last-opened note so re-summoning lands you back where you were (#4)
const LAST_KEY = "poof-notes-last";
// 默认 = 画布(edgeless): 半透明暗色玻璃板 + 一张米色文档方框。page 是"展开写作"的可选模式。
const MODE_KEY = "poof-notes-mode";
const WEB_FAST_MODE_MIGRATION_KEY = "poof-notes-web-fast-mode-v1";
const FLOW_MODE_MIGRATION_KEY = "poof-notes-flow-mode-v1";
type EditorMode = "flow" | "page" | "edgeless";
function loadMode(): EditorMode {
  if (!localStorage.getItem(FLOW_MODE_MIGRATION_KEY)) {
    localStorage.setItem(FLOW_MODE_MIGRATION_KEY, "1");
    // React Flow 已取代网页端为避开旧 edgeless 首屏而做的 page 迁移；同时标记完成，
    // 避免第二次打开网页时又被旧迁移从新画布切回文档模式。
    localStorage.setItem(WEB_FAST_MODE_MIGRATION_KEY, "1");
    localStorage.setItem(MODE_KEY, "flow");
    return "flow";
  }
  // The Dashboard iframe used to persist the heavy canvas default before the
  // editor was usable. Migrate that web runtime once to the faster document
  // view; an explicit later switch back to canvas remains persistent.
  if (
    window.location.pathname.startsWith("/lofa/overlay/app/") &&
    !localStorage.getItem(WEB_FAST_MODE_MIGRATION_KEY)
  ) {
    localStorage.setItem(WEB_FAST_MODE_MIGRATION_KEY, "1");
    localStorage.setItem(MODE_KEY, "page");
    return "page";
  }
  const saved = localStorage.getItem(MODE_KEY);
  return saved === "page" || saved === "edgeless" ? saved : "flow";
}

// #3 非全屏窗口的位置+尺寸(自定义拖动/八向缩放, 因为 CSS resize 只能右下角且不能移动)
const GEOM_KEY = "poof-notes-geom";
interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}
function loadGeom(): Geom {
  try {
    const g = JSON.parse(localStorage.getItem(GEOM_KEY) || "");
    if (g && typeof g.x === "number") return g;
  } catch {
    /* ignore */
  }
  return { x: 96, y: 92, w: 840, h: 560 };
}

// lightweight tags store (BlockSuite's tag schema is heavy; we keep our own)
const TAGS_KEY = "poof-notes-tags";
type TagMap = Record<string, string[]>;
function loadTags(): TagMap {
  try {
    return JSON.parse(localStorage.getItem(TAGS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveTags(t: TagMap) {
  localStorage.setItem(TAGS_KEY, JSON.stringify(t));
}

interface Meta {
  id: string;
  title: string;
  archived: boolean;
  trashed: boolean;
  favorite: boolean;
  createDate?: number;
  updatedDate?: number;
  sessionId?: string;
}
type View = "notes" | "archive" | "trash";
type Sort = "updated" | "created" | "title";

export function NotesWorkspace({
  onClose,
  embedded = false,
  allowPowerShell = true,
  session: sessionProp,
}: {
  onClose: () => void;
  embedded?: boolean;
  allowPowerShell?: boolean;
  session?: NoteSession;
}) {
  const c = getCollection();
  const host = useRef<HTMLDivElement>(null);
  const [metas, setMetas] = useState<Meta[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const activeIdRef = useRef("");
  activeIdRef.current = activeId;
  const [q, setQ] = useState("");
  const [full, setFull] = useState(!embedded); // 独立网页仍全屏；主应用已进入真实侧栏。
  const [libOpen, setLibOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false); // #7 笔记里的 powershell 右侧栏
  const [mode, setMode] = useState<EditorMode>(loadMode); // #3 文档/画布
  const editorRef = useRef<AffineEditorContainer | null>(null);
  const [view, setView] = useState<View>("notes");
  const [sort, setSort] = useState<Sort>("updated");
  const [tags, setTags] = useState<TagMap>(loadTags);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [verOpen, setVerOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false); // 浏览/插入面板(文件/计划/进度/审阅)
  const [conflictMsg, setConflictMsg] = useState(""); // 同步源块写回冲突提示
  // 初值留空, 挂载后 notes_root()(Rust)解析真根(环境变量 OVERLAY_NOTE_STORE_ROOT 或
  // %LOCALAPPDATA%\overlay-shell\note-store)回填。
  const noteStoreRoot = useRef("");
  const locationSession = useMemo(sessionFromLocation, []);
  const [session, setSession] = useState<NoteSession>(
    () => sessionProp || locationSession || getActiveNoteSession()
  );
  const [draftNonce, setDraftNonce] = useState(0);
  const [geom, setGeom] = useState<Geom>(loadGeom);

  // 网页端复制必须在按钮点击的用户手势里立刻发生。提前缓存根目录，避免点击后先 await HTTP
  // 而错过 Chromium 对非 HTTPS 页面剪贴板操作的授权窗口。
  useEffect(() => {
    let dead = false;
    void notesRoot()
      .then((root) => {
        if (!dead && root) noteStoreRoot.current = root.replace(/\\/g, "/").replace(/\/+$/, "");
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  // ⚠ 整页重载(Rust 重编重启 / 改入口文件 / 手动刷新)会把还挂着的 BlockSuite 编辑器暴力拆掉,
  // 撞崩 WebView2 渲染进程 —— 实测 overlay-shell.exe exit 0xcfffffff 且无 Rust panic(就是这条整页重载,
  // 不是搜索)。页面卸载/重载前主动、有序地 remove 编辑器, 让 Lit/Yjs 干净断开, 别让渲染进程在
  // 混乱拆解里崩。pagehide/beforeunload 覆盖进程重启+手动刷新, vite:beforeFullReload 覆盖 HMR 整页重载。
  useEffect(() => {
    const dispose = () => {
      void flushNotesStore(); // 先尽力把 ≤400ms 未落盘的改动写盘(防关窗/整页重载丢最后一段编辑)
      try {
        editorRef.current?.remove();
      } catch {
        /* ignore */
      }
      editorRef.current = null;
    };
    // ⚠ pagehide/beforeunload 里 flush 的异步 IPC 在"真关窗/真退进程"时来不及跑完(只救得到 HMR 重载)。
    // 真正堵生产期丢数据的是这条: poof 常态"关闭"=隐藏(main.hide), 会触发 visibilitychange→hidden, 此刻
    // WebView 仍活、IPC 还能往返 → 在这里 flush 才真落得了盘。
    const onHide = () => {
      if (document.hidden) void flushNotesStore();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", dispose);
    window.addEventListener("beforeunload", dispose);
    const hot = (import.meta as any).hot;
    hot?.on?.("vite:beforeFullReload", dispose);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", dispose);
      window.removeEventListener("beforeunload", dispose);
    };
  }, []);

  // #3 拖动(move) / 八向缩放(n/s/e/w/ne/nw/se/sw)。指针事件挂 window, 拖出元素也跟手。
  useEffect(() => {
    if (!full) localStorage.setItem(GEOM_KEY, JSON.stringify(geom));
  }, [geom, full]);
  function startDrag(e: React.PointerEvent, dir: string) {
    if (full) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const g0 = { ...geom };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { x, y, w, h } = g0;
      if (dir === "move") {
        x = Math.min(Math.max(0, g0.x + dx), vw - 120);
        y = Math.min(Math.max(0, g0.y + dy), vh - 56);
      } else {
        if (dir.includes("e")) w = Math.max(360, g0.w + dx);
        if (dir.includes("s")) h = Math.max(240, g0.h + dy);
        if (dir.includes("w")) {
          w = Math.max(360, g0.w - dx);
          x = g0.x + (g0.w - w);
        }
        if (dir.includes("n")) {
          h = Math.max(240, g0.h - dy);
          y = g0.y + (g0.h - h);
        }
      }
      setGeom({ x, y, w, h });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function readMetas(): Meta[] {
    return c.meta.docMetas
      .filter((m: any) => !isBoundSubDoc(m.id)) // 同步源块的绑定子文档不是独立笔记, 不进列表
      .map((m: any) => ({
      id: m.id,
      // docMeta.title 加载时会被刷成空页标题 → 回退到内容派生的显示标题缓存(见 fileNotesStore)。
      title: (m.title || getCachedTitle(m.id) || "").trim(),
      archived: !!m.archived,
      trashed: !!m.trashed,
      favorite: !!m.favorite,
      createDate: m.createDate,
      updatedDate: m.updatedDate,
      sessionId: m.sessionId,
    }));
  }

  useEffect(() => {
    if (sessionProp || locationSession) return;
    return subscribeNoteSession((next) => setSession(next));
  }, [sessionProp, locationSession]);

  // keep the note list in sync (after the IndexedDB pull settles)
  useEffect(() => {
    const refresh = () => setMetas(readMetas());
    refresh();
    const subs = [
      c.slots.docUpdated.on(refresh),
      c.slots.docAdded.on(refresh),
      c.slots.docRemoved.on(refresh),
    ];
    const t = setTimeout(() => {
      refresh();
      setReady(true);
    }, 700);
    return () => {
      subs.forEach((s) => s.dispose());
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

  // 一个真实会话对应一张默认札记。没有已保存内容时这里只呈现内存草稿，绝不 createDoc；
  // 第一次出现非空内容时才由 materializeSessionNote 物化并绑定 sessionId。
  useEffect(() => {
    if (!ready) return;
    setDraftNonce(0);
    const bound = readMetas().find(
      (meta) => !meta.trashed && !meta.archived && meta.sessionId === session.id
    );
    activeIdRef.current = bound?.id || "";
    setActiveId(activeIdRef.current);
  }, [ready, c, session.id]);

  // 记住当前打开的笔记, 下次召出回到这里 (#4)
  useEffect(() => {
    if (activeId) localStorage.setItem(LAST_KEY, activeId);
  }, [activeId]);

  // slash 菜单"插入内容" → 打开浏览面板(slash 在 editorConfig, 用事件桥到这里的 React 状态)
  useEffect(() => {
    const open = () => setBrowseOpen(true);
    window.addEventListener("poof:open-browse", open);
    return () => window.removeEventListener("poof:open-browse", open);
  }, []);

  // mount the BlockSuite editor for the active doc + auto-sync its title (fixes 未命名)
  useEffect(() => {
    if (mode === "flow") {
      if (host.current) host.current.innerHTML = "";
      editorRef.current = null;
      return;
    }
    if (!activeId || !host.current) return;
    // The sync engine loads sub-docs sequentially. Move the selected note to the
    // head of its shared pull/push queues before asking BlockSuite to mount it.
    c.docSync.setPriorityRule((id) => id === activeId);
    const doc = c.getDoc(activeId);
    if (!doc) return;
    doc.load();

    const root: any = doc.root;
    const sync = () => {
      let t = "";
      try {
        t = root?.title?.toString?.().trim() ?? "";
      } catch {
        /* ignore */
      }
      if (!t) t = firstLineOf(doc);
      if (t) setCachedTitle(activeId, t); // 喂显示标题缓存(编辑当前笔记时实时刷新, 不依赖打开才有标题)
      const cur = ((doc.meta as any)?.title || "").trim();
      if (t && t !== cur) c.setDocMeta(activeId, { title: t, updatedDate: Date.now() } as any);
    };
    let dirty = false;
    const onChange = () => {
      dirty = true;
      sync();
      scheduleNoteExport(doc, c); // 编辑 → 防抖导出 .md + 重建 index.json(给 omni 读)
    };
    sync(); // backfill the title for older notes when opened
    scheduleNoteExport(doc, c); // 打开即导一次这条笔记的 .md, 并刷新 index
    // blocks may materialize slightly after mount → retry the backfill a few times
    const backfills = [250, 700, 1500].map((ms) => window.setTimeout(sync, ms));
    let offTitle = () => {};
    try {
      const yt = root?.title?.yText;
      if (yt?.observe) {
        yt.observe(onChange);
        offTitle = () => yt.unobserve(onChange);
      }
    } catch {
      /* ignore */
    }
    let offBlock = () => {};
    try {
      const d = doc.slots?.blockUpdated?.on?.(onChange);
      if (d?.dispose) offBlock = () => d.dispose();
    } catch {
      /* ignore */
    }
    // auto-snapshot a version every few minutes while the note is being edited
    const snap = (label: string) => {
      try {
        saveVersion(activeId, Y.encodeStateAsUpdate(doc.spaceDoc), label);
      } catch {
        /* ignore */
      }
    };
    const snapTimer = window.setInterval(() => {
      if (!dirty) return;
      dirty = false;
      snap("自动");
    }, 180000);

    // ⚠ 编辑器延迟挂载: 必须等 doc 可渲染(有 page 根 + surface)再挂。直接挂一个还没 pull 完 / 缺 surface /
    // 块结构残缺的 doc, edgeless 会抛 "missing surface block" / "children undefined" 直接崩 WebView2(整窗 0xcfffffff)。
    let editor: AffineEditorContainer | null = null;
    let mounted = false;
    let cancelled = false;
    const hookCleanups: Array<() => void> = [];

    const mountEditor = () => {
      if (cancelled || mounted || !host.current) return;
      mounted = true;
      editor = new AffineEditorContainer();
      editor.edgelessSpecs = [...editor.edgelessSpecs, DARK_THEME, ...AiBlockSpec, FileSearchConfig];
      editor.pageSpecs = [...editor.pageSpecs, DARK_THEME, ...AiBlockSpec, FileSearchConfig];
      editor.doc = doc;
      editor.mode = mode as any;
      host.current.innerHTML = "";
      host.current.appendChild(editor);
      editorRef.current = editor;
      hookCleanups.push(installShapeTextStabilityGuard(editor, doc, c));
      hookCleanups.push(
        installSafeEdgelessDelete(editor, doc, activeId, c, (message) => {
          setConflictMsg(message);
          window.setTimeout(() => setConflictMsg(""), 8000);
        })
      );
      localizeSlashMenu(editor); // #8 slash 菜单中文(config)
      installChromeTranslator(); // #8 全量中文(格式条/工具条/tooltip/链接卡片, DOM 级)
      installFileTemplateSearch(); // #5 工具栏"Search file or anything"(模板面板)→ 搜本机文件(Everything)
      hookCleanups.push(installFileWriteback(doc)); // 活文件块: 改文本块 → 防抖写回源文件
      hookCleanups.push(
        installBoundSync(doc, (ref, kind, detail) => {
          const name = ref.replace(/\\/g, "/").split("/").pop() || ref;
          setConflictMsg(
            kind === "conflict"
              ? `「${name}」源文件外部也被改过，已三路合并（含冲突标记）写回，请检查`
              : `「${name}」含 markdown 存不下的块（${detail}），这些块不会写进源文件`
          );
          window.setTimeout(() => setConflictMsg(""), 8000);
        })
      ); // 同步源块: 改 embed 子文档 → 防抖写回源(冲突闸+保真闸+历史) + 轮询外部改动
      hookCleanups.push(installMdPreviewToggle(doc)); // md 活文件块: 源码 ⇄ 渲染预览
      hookCleanups.push(installMarkdownPaste(editor)); // 粘贴 markdown 智能转(Shift=纯文本)
      hookCleanups.push(installOmniRefJump(editor)); // @omni 引用点击 → 跳 vscode/看板
      hookCleanups.push(
        mountAiToolbarButton(() => {
          try {
            insertAiBlock(doc, activeId);
          } catch {
            /* ignore */
          }
        })
      );
      hookCleanups.push(mountNoteExpandButton(() => setMode("page")));
      // 让画布上的 note 自动贴合内容: 去掉"折叠/固定高"(edgeless.collapse), BlockSuite 便按内容自适应高度
      // → 选中框 = note 框 = 内容, 不再出现"选中框比内容大/小"。内容变化后防抖再跑一次。
      hookCleanups.push(
        (() => {
          const fit = () => {
            try {
              for (const b of doc.getBlocksByFlavour?.(["affine:note"]) ?? []) {
                const m: any = (b as any)?.model ?? b;
                if (m?.edgeless?.collapse) {
                  doc.updateBlock(m, { edgeless: { ...m.edgeless, collapse: false } });
                }
              }
            } catch {
              /* ignore */
            }
          };
          fit();
          const t1 = window.setTimeout(fit, 600);
          let t2 = 0;
          let off = () => {};
          try {
            const d = doc.slots?.blockUpdated?.on?.(() => {
              clearTimeout(t2);
              t2 = window.setTimeout(fit, 400);
            });
            if (d?.dispose) off = () => d.dispose();
          } catch {
            /* ignore */
          }
          return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            try {
              off();
            } catch {
              /* ignore */
            }
          };
        })()
      );
    };

    // 轮询: doc 加载出 page 根就补 surface(若缺)再挂; 等够(~1.5s)仍无 page = 空/坏文档 → reseed 成有效空笔记再挂。
    // 本地 pull 很快(<200ms), 1.5s 还没 page 基本就是真空文档, reseed 不会误伤慢加载的好笔记。
    const tryMount = (attempt: number) => {
      if (cancelled || mounted) return;
      const r: any = doc.root;
      if (r?.id) {
        try {
          if (!doc.getBlocksByFlavour(["affine:surface"]).length) doc.addBlock("affine:surface", {}, r.id);
        } catch {
          /* ignore */
        }
        mountEditor();
      } else if (attempt >= 10) {
        try {
          const rootId = doc.addBlock("affine:page", {});
          doc.addBlock("affine:surface", {}, rootId);
          const nid = doc.addBlock("affine:note", { xywh: "[0,0,440,620]" }, rootId);
          doc.addBlock("affine:paragraph", {}, nid);
        } catch {
          /* ignore */
        }
        mountEditor();
      } else {
        window.setTimeout(() => tryMount(attempt + 1), 150);
      }
    };
    tryMount(0);

    return () => {
      cancelled = true;
      backfills.forEach((t) => clearTimeout(t));
      clearInterval(snapTimer);
      hookCleanups.forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
      killAllAiTerminals(); // 关笔记/切笔记才真关 AI 终端; 模式切换不走这里, 所以不重载
      if (dirty) snap("自动"); // capture the latest edits on close
      offTitle();
      offBlock();
      editorRef.current = null;
      try {
        editor?.remove();
      } catch {
        /* ignore */
      }
    };
  }, [activeId, c, mode]);

  // #3 文档/画布切换: 不重挂编辑器, 直接切 mode + 记住
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
    if (mode !== "flow" && editorRef.current) {
      try {
        editorRef.current.mode = mode as any;
      } catch {
        /* ignore */
      }
    }
  }, [mode]);

  function materializeSessionNote(
    text: string,
    geometry: CardGeometry,
    force = false
  ): Doc | null {
    const existingId = activeIdRef.current;
    if (existingId) return c.getDoc(existingId) || null;
    if (!force && !text.trim()) return null;

    const firstLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    const title = firstLine?.slice(0, 80) || (draftNonce === 0 ? session.label : "新札记");
    const doc = seedDoc(c, {
      title,
      text,
      sessionId: draftNonce === 0 ? session.id : undefined,
      geometry,
    });
    activeIdRef.current = doc.id;
    setActiveId(doc.id);
    setMetas(readMetas());
    scheduleNoteExport(doc, c);
    window.setTimeout(() => void flushNotesStore(), 500);
    return doc;
  }

  function updateFlowText(noteId: string, text: string): void {
    const id = activeIdRef.current;
    const doc: any = id ? c.getDoc(id) : null;
    if (!doc) return;
    doc.load();
    const noteBlock = (doc.getBlocksByFlavour?.(["affine:note"]) || []).find(
      (block: any) => (block?.model ?? block)?.id === noteId
    );
    const note = noteBlock?.model ?? noteBlock;
    const paragraph = note?.children?.[0];
    if (!paragraph?.text || note.children.length !== 1 || paragraph.flavour !== "affine:paragraph") return;

    const title =
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
        ?.slice(0, 80) || "未命名笔记";
    doc.transact(() => {
      paragraph.text.delete(0, paragraph.text.length);
      if (text) paragraph.text.insert(text, 0);
      const rootTitle = doc.root?.title;
      if (rootTitle?.replace) rootTitle.replace(0, rootTitle.length, title);
    });
    c.setDocMeta(id, { title, updatedDate: Date.now() } as any);
    setCachedTitle(id, title);
    scheduleNoteExport(doc, c);
    window.setTimeout(() => void flushNotesStore(), 500);
  }

  function updateFlowGeometry(noteId: string, geometry: CardGeometry): void {
    const id = activeIdRef.current;
    const doc: any = id ? c.getDoc(id) : null;
    if (!doc) return;
    doc.load();
    const noteBlock = (doc.getBlocksByFlavour?.(["affine:note"]) || []).find(
      (block: any) => (block?.model ?? block)?.id === noteId
    );
    const note = noteBlock?.model ?? noteBlock;
    if (!note) return;
    doc.updateBlock(note, {
      xywh: `[${geometry.x},${geometry.y},${geometry.width},${geometry.height}]`,
    });
    c.setDocMeta(id, { updatedDate: Date.now() } as any);
    window.setTimeout(() => void flushNotesStore(), 500);
  }

  // 从系统拖文件进笔记 → 直接插进当前笔记(只在笔记打开时挂监听)。Tauri 给的是真实磁盘路径,
  // 正好喂给 insertFileIntoNote(文本→可编辑写回 / 图片PDF→预览 / 其它→文件卡)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    getCurrentWebview()
      .onDragDropEvent((ev: any) => {
        if (ev.payload?.type !== "drop") return;
        const doc = activeIdRef.current
          ? c.getDoc(activeIdRef.current)
          : materializeSessionNote("", { x: 80, y: 72, width: 420, height: 320 }, true);
        if (!doc) return;
        doc.load();
        for (const p of ev.payload.paths || []) void insertFileIntoNote(doc, p);
      })
      .then((u) => {
        if (dead) u();
        else unlisten = u;
      })
      .catch(() => {
        /* 非 Tauri 环境(离屏台)忽略 */
      });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [activeId, c, session.id, session.label, draftNonce]);

  // ---- actions ----
  function createNote() {
    activeIdRef.current = "";
    setActiveId("");
    setDraftNonce((value) => value + 1);
    setView("notes");
    setMode("flow");
  }
  function setFlag(id: string, flag: Partial<Record<"archived" | "trashed" | "favorite", boolean>>) {
    c.setDocMeta(id, { ...flag, updatedDate: Date.now() } as any);
    setMetas(readMetas());
    // 归档/回收 → 删导出的 .md(真源 .ydoc 留着可恢复), 否则"已删/归档"笔记的 .md 还能被 omni 直接 cat 到。
    if (flag.archived || flag.trashed) notesMdDel(id).catch(() => {});
    // 进/出 index 的状态变了就重建 index(favorite 不影响 index, 不重建)。恢复时 .md 等下次打开懒导回来。
    if (flag.archived !== undefined || flag.trashed !== undefined) rebuildNotesIndex(c).catch(() => {});
  }
  function toTrash(id: string) {
    setFlag(id, { trashed: true, archived: false });
    if (activeId === id) setActiveId("");
  }
  function restore(id: string) {
    setFlag(id, { trashed: false, archived: false });
  }
  function deleteForever(id: string) {
    if (!window.confirm("彻底删除这条笔记？不可恢复。")) return;
    c.removeDoc(id);
    deleteVersionsFor(id).catch(() => {});
    // 删盘上的真源 + 导出物(否则 .ydoc/.md 成孤儿, 且"已删"笔记的 .md 还能被 omni 读到)。
    // 不删 blobs(sha 内容寻址, 可能被别的笔记共享)。删完重建 index。
    notesDocDel(id).catch(() => {});
    notesMdDel(id).catch(() => {});
    rebuildNotesIndex(c).catch(() => {});
    const t = { ...tags };
    delete t[id];
    saveTags(t);
    setTags(t);
    if (activeId === id) setActiveId("");
    setMetas(readMetas());
  }
  function startRename(id: string) {
    const cur = metas.find((m) => m.id === id)?.title || "未命名笔记";
    setRenameDraft(cur);
    setRenamingId(id);
  }
  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
  }
  function commitRename(id: string, value: string) {
    const name = value.trim() || "未命名笔记";
    const doc = c.getDoc(id);
    if (doc) {
      try {
        doc.load();
        const root: any = doc.root;
        if (root?.title?.replace) doc.transact(() => root.title.replace(0, root.title.length, name));
      } catch {
        /* ignore */
      }
    }
    c.setDocMeta(id, { title: name, updatedDate: Date.now() } as any);
    setCachedTitle(id, name);
    setRenamingId(null);
    setRenameDraft("");
    setMetas(readMetas());
  }
  async function duplicate(id: string) {
    const nid = await duplicateDoc(c, id);
    setMetas(readMetas());
    if (nid) setActiveId(nid);
  }
  function addTag(id: string) {
    const v = window.prompt("标签 / 分类：")?.trim();
    if (!v) return;
    const cur = tags[id] || [];
    if (cur.includes(v)) return;
    const next = { ...tags, [id]: [...cur, v] };
    saveTags(next);
    setTags(next);
  }
  function removeNoteTag(id: string, t: string) {
    const cur = (tags[id] || []).filter((x) => x !== t);
    const next = { ...tags } as TagMap;
    if (cur.length) next[id] = cur;
    else delete next[id];
    saveTags(next);
    setTags(next);
  }

  // ---- version history ----
  async function openVersions() {
    if (!activeId) return;
    setVersions(await listVersions(activeId));
    setVerOpen(true);
  }
  function saveVersionNow() {
    if (!activeId) return;
    const doc = c.getDoc(activeId);
    if (!doc) return;
    try {
      saveVersion(activeId, Y.encodeStateAsUpdate(doc.spaceDoc), "手动");
    } catch {
      /* ignore */
    }
    setTimeout(async () => setVersions(await listVersions(activeId)), 250);
  }
  async function restoreVersion(v: NoteVersion) {
    const orig = metas.find((m) => m.id === activeId)?.title || "未命名笔记";
    const nd = c.createDoc();
    nd.load();
    try {
      Y.applyUpdate(nd.spaceDoc, v.bytes);
    } catch {
      /* ignore */
    }
    c.setDocMeta(nd.id, {
      title: orig + " · 恢复@" + new Date(v.ts).toLocaleString(),
      updatedDate: Date.now(),
    } as any);
    setMetas(readMetas());
    setActiveId(nd.id);
    setVerOpen(false);
  }

  // ---- list: filter by view + search, then sort ----
  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const inView = (m: Meta) =>
      view === "trash" ? m.trashed : view === "archive" ? m.archived && !m.trashed : !m.archived && !m.trashed;
    let list = metas.filter(inView);
    if (ql)
      list = list.filter(
        (m) =>
          (m.title || "未命名").toLowerCase().includes(ql) ||
          (tags[m.id] || []).some((t) => t.toLowerCase().includes(ql))
      );
    return list.sort((a, b) => {
      if (view === "notes" && a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (sort === "title") return (a.title || "").localeCompare(b.title || "");
      const ka = sort === "created" ? a.createDate || 0 : a.updatedDate || a.createDate || 0;
      const kb = sort === "created" ? b.createDate || 0 : b.updatedDate || b.createDate || 0;
      return kb - ka;
    });
  }, [metas, q, view, sort, tags]);

  const draftTitle = draftNonce === 0 ? session.label : "新札记";
  const activeTitle = metas.find((m) => m.id === activeId)?.title || draftTitle;
  const flowCards = activeId ? flowCardsOf(c.getDoc(activeId)) : [];
  const flowDocumentKey = activeId || `${session.id}:${draftNonce}`;

  // 复制当前笔记的 .md 绝对路径(而非不透明的 poof-note:// 链接) —— 发给 AI 可直接读文件,
  // 文件名即笔记 id(omni notes 仍可由此反推编辑)。复制后立即补一次导出，刷新 .md 内容。
  function copyNoteMdPath(id: string): void {
    // 先在当前点击手势内复制；导出随后刷新即可（编辑过程本身也一直在防抖导出）。
    void copyText(`${noteStoreRoot.current}/docs/${id}.md`);
    try {
      const doc = c.getDoc(id);
      if (doc) void exportNoteToMd(doc, c).catch(() => {});
    } catch {
      /* 导出失败也无妨: 已有的 .md 仍可用 */
    }
  }

  return (
    <div
      className={"notes-ws " + mode + (full ? " full" : "") + (embedded ? " embedded" : "")}
      style={!embedded && !full ? { left: geom.x, top: geom.y, width: geom.w, height: geom.h } : undefined}
    >
      <div className="notespace" ref={host} />

      {mode === "flow" && (
        <Suspense fallback={<div className="notes-empty">正在加载稳定画布…</div>}>
          <SessionNotesCanvas
            documentKey={flowDocumentKey}
            draftTitle={draftTitle}
            cards={flowCards}
            onDraftContent={(text, geometry) => {
              materializeSessionNote(text, geometry);
            }}
            onCardText={updateFlowText}
            onCardGeometry={updateFlowGeometry}
            onOpenCompatibility={() => setMode("page")}
          />
        </Suspense>
      )}

      {!embedded && !full && (
        <>
          {["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => (
            <div key={d} className={"nws-rz " + d} onPointerDown={(e) => startDrag(e, d)} />
          ))}
        </>
      )}

      <div
        className="notes-bar"
        onPointerDown={(e) => {
          if (!embedded && !full && !(e.target as HTMLElement).closest("button,input")) startDrag(e, "move");
        }}
        title={!embedded && !full ? "拖这里移动窗口" : undefined}
      >
        <button
          className={"notes-bar-btn" + (libOpen ? " on" : "")}
          title="笔记库"
          onClick={() => setLibOpen((o) => !o)}
        >
          <PanelLeft size={15} />
        </button>
        <button className="notes-bar-btn" title="新建笔记" onClick={createNote}>
          <Plus size={15} />
        </button>
        <button
          className={"notes-bar-btn" + (browseOpen ? " on" : "")}
          title="插入内容（文件 / 计划 / 任务 / 审阅材料 → 同步源块）"
          disabled={!activeId}
          onClick={() => setBrowseOpen((o) => !o)}
        >
          <FolderInput size={15} />
        </button>
        <span className="notes-bar-title">{activeTitle}</span>
        <span className="notes-bar-spacer" />
        <button
          className={"notes-bar-btn" + (mode === "flow" ? " on" : "")}
          title={mode === "flow" ? "兼容写作视图" : "React Flow 画布"}
          disabled={mode === "flow" && !activeId}
          onClick={() => setMode((current) => (current === "flow" ? "page" : "flow"))}
        >
          <LayoutGrid size={15} />
        </button>
        <button
          className={"notes-bar-btn" + (verOpen ? " on" : "")}
          title="版本历史"
          onClick={() => (verOpen ? setVerOpen(false) : openVersions())}
          disabled={!activeId}
        >
          <History size={15} />
        </button>
        <button
          className="notes-bar-btn"
          title="复制当前笔记的 .md 文件路径(发给 AI 可直接读：…/overlay-note-store/docs/<id>.md · 文件名即 id, omni notes 仍可编辑)"
          disabled={!activeId}
          onClick={() => { if (activeId) void copyNoteMdPath(activeId); }}
        >
          <Link2 size={15} />
        </button>
        {allowPowerShell && (
          <button
            className={"notes-bar-btn" + (termOpen ? " on" : "")}
            title="PowerShell（笔记里的终端容器，右侧栏）"
            onClick={() => setTermOpen((t) => !t)}
          >
            <SquareTerminal size={15} />
          </button>
        )}
        {!embedded && (
          <>
            <button
              className="notes-bar-btn"
              title={full ? "退出全屏" : "无边全屏"}
              onClick={() => setFull((f) => !f)}
            >
              {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button className="notes-bar-btn" title="关闭" onClick={onClose}>
              <X size={15} />
            </button>
          </>
        )}
      </div>

      {/* #2 展开写作=从笔记块的元素工具条触发(见 mountNoteExpandButton)。这里只在"已展开(page)"时
          给一个回到画布的出口(page 模式没有画布元素工具条)。 */}
      {mode === "page" && (
        <button className="notes-expand" title="回到新画布" onClick={() => setMode("flow")}>
          <LayoutGrid size={14} /> 回到新画布
        </button>
      )}

      {allowPowerShell && termOpen && (
        <div className="notes-term">
          <div className="notes-term-head">
            <SquareTerminal size={13} /> PowerShell
            <span style={{ flex: 1 }} />
            <button className="notes-lib-x" onClick={() => setTermOpen(false)} title="收起">
              <X size={14} />
            </button>
          </div>
          <div className="notes-term-body">
            <Suspense fallback={<div className="notes-empty">正在加载终端…</div>}>
              <TerminalView id="notes-ps" />
            </Suspense>
          </div>
        </div>
      )}

      {libOpen && (
        <div className="notes-lib">
          <div className="notes-lib-head">
            <div className="notes-views">
              <button className={view === "notes" ? "on" : ""} onClick={() => setView("notes")}>
                笔记
              </button>
              <button className={view === "archive" ? "on" : ""} onClick={() => setView("archive")}>
                归档
              </button>
              <button className={view === "trash" ? "on" : ""} onClick={() => setView("trash")}>
                回收站
              </button>
            </div>
            <button className="notes-lib-x" onClick={() => setLibOpen(false)} title="收起">
              <X size={14} />
            </button>
          </div>
          <div className="notes-rail-top">
            {view === "notes" && (
              <button className="notes-new" onClick={createNote}>
                <Plus size={15} /> 新建笔记
              </button>
            )}
            <div className="notes-search">
              <Search size={14} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索标题 / 标签…"
                spellCheck={false}
              />
            </div>
            <button
              className="notes-sort"
              title="排序"
              onClick={() =>
                setSort((s) => (s === "updated" ? "created" : s === "created" ? "title" : "updated"))
              }
            >
              <ArrowDownUp size={13} />
              {sort === "updated" ? "最近修改" : sort === "created" ? "创建时间" : "标题"}
            </button>
          </div>
          <div className="notes-list">
            {!ready && (
              <div className="notes-empty">
                <Loader2 size={16} className="spin" /> 载入笔记库…
              </div>
            )}
            {ready && visible.length === 0 && (
              <div className="notes-empty">
                {view === "trash" ? "回收站为空" : view === "archive" ? "无归档" : "无笔记"}
              </div>
            )}
            {visible.map((m) => (
              <div
                key={m.id}
                className={
                  "notes-item" +
                  (m.id === activeId ? " on" : "") +
                  (m.id === renamingId ? " renaming" : "")
                }
                onClick={() => view !== "trash" && setActiveId(m.id)}
                onDoubleClick={() => view === "notes" && startRename(m.id)}
              >
                <div className="notes-item-row">
                  {renamingId === m.id ? (
                    <input
                      className="notes-rename-input"
                      value={renameDraft}
                      autoFocus
                      aria-label="笔记标题"
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={(e) => commitRename(m.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <div className="notes-item-title" title={m.title || "未命名笔记"}>
                      {m.favorite && view === "notes" ? "★ " : ""}
                      {m.title || "未命名笔记"}
                    </div>
                  )}
                  {renamingId !== m.id && (
                    <div className="notes-item-acts" onClick={(e) => e.stopPropagation()}>
                      {view === "notes" && (
                        <>
                          <button title="置顶/取消" onClick={() => setFlag(m.id, { favorite: !m.favorite })}>
                            <Star size={13} fill={m.favorite ? "currentColor" : "none"} />
                          </button>
                          <button title="重命名" onClick={() => startRename(m.id)}>
                            <Pencil size={13} />
                          </button>
                          <button title="复制" onClick={() => duplicate(m.id)}>
                            <Copy size={13} />
                          </button>
                          <button title="加标签" onClick={() => addTag(m.id)}>
                            <Hash size={13} />
                          </button>
                          <button title="归档" onClick={() => setFlag(m.id, { archived: true })}>
                            <Archive size={13} />
                          </button>
                          <button title="删除（移入回收站）" onClick={() => toTrash(m.id)}>
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                      {view === "archive" && (
                        <>
                          <button title="取消归档" onClick={() => restore(m.id)}>
                            <ArchiveRestore size={13} />
                          </button>
                          <button title="删除（移入回收站）" onClick={() => toTrash(m.id)}>
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                      {view === "trash" && (
                        <>
                          <button title="恢复" onClick={() => restore(m.id)}>
                            <RotateCcw size={13} />
                          </button>
                          <button title="彻底删除" onClick={() => deleteForever(m.id)}>
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {!!(tags[m.id] || []).length && (
                  <div className="notes-item-tags" onClick={(e) => e.stopPropagation()}>
                    {(tags[m.id] || []).map((t) => (
                      <TagChip key={t} name={t} onRemove={() => removeNoteTag(m.id, t)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {verOpen && (
        <div className="notes-ver">
          <div className="notes-ver-head">
            <span>
              <History size={14} /> 版本历史
            </span>
            <button onClick={() => setVerOpen(false)} title="收起">
              <X size={14} />
            </button>
          </div>
          <button className="notes-new" onClick={saveVersionNow}>
            <Save size={14} /> 保存当前版本
          </button>
          <div className="notes-ver-list">
            {versions.length === 0 && (
              <div className="notes-empty">暂无版本（编辑约 3 分钟自动存，或点上方手动存）</div>
            )}
            {versions.map((v) => (
              <div className="notes-ver-item" key={v.id}>
                <div className="notes-ver-when">{new Date(v.ts).toLocaleString()}</div>
                <span className={"notes-ver-tag" + (v.label === "手动" ? " manual" : "")}>
                  {v.label}
                </span>
                <button
                  className="notes-ver-restore"
                  onClick={() => restoreVersion(v)}
                  title="恢复为新笔记"
                >
                  <RotateCcw size={13} /> 恢复
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {browseOpen && (
        <Suspense fallback={<div className="notes-empty">正在加载插入面板…</div>}>
          <BrowsePanel
            getDoc={() => c.getDoc(activeId)}
            onClose={() => setBrowseOpen(false)}
            onInserted={() => setMetas(readMetas())}
          />
        </Suspense>
      )}

      {conflictMsg && (
        <div className="notes-conflict" onClick={() => setConflictMsg("")} title="点此关闭">
          ⚠ {conflictMsg}
        </div>
      )}
    </div>
  );
}
