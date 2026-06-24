import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { TerminalView } from "./Terminal";
import { copyText, notesDocDel, notesMdDel } from "../lib";
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
import { DocCollection, Job, type Doc } from "@blocksuite/store";
import { listVersions, saveVersion, deleteVersionsFor, type NoteVersion } from "./noteVersions";
import { AffineEditorContainer } from "@blocksuite/presets";
import { OverrideThemeExtension } from "@blocksuite/affine-shared/services";
import { signal } from "@preact/signals-core";
import { getCollection } from "./notesCollection";
import { installFileWriteback, installMdPreviewToggle, insertFileIntoNote } from "./fileInsert";
import { flushNotesStore } from "./fileNotesStore";
import { scheduleNoteExport, rebuildNotesIndex, backfillExports } from "./noteExport";
import { installMarkdownPaste } from "./markdownPaste";
import { installOmniRefJump } from "./omniLink";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// DARK theme everywhere (canvas + 弹层/菜单都深底浅字, 跟 poof 的暗色玻璃悬浮层哲学一致)。
// 唯独"笔记方框(affine-note)"在 CSS 里被改成米色纸 + 深字 —— 只改方框, 不动主题/画布。
// (slash 菜单等弹层挂在 document.body 上, 不在 affine-note 子树, 所以方框作用域的深字覆盖不会染到它们。)
const THEME = signal("dark" as any);
const DARK_THEME = OverrideThemeExtension({
  getAppTheme: () => THEME,
  getEdgelessTheme: () => THEME,
});


function seedDoc(c: DocCollection): Doc {
  const doc = c.createDoc();
  doc.load(() => {
    const rootId = doc.addBlock("affine:page", {});
    doc.addBlock("affine:surface", {}, rootId);
    // 一块"笔记本页"样的文档块: 竖向(高>宽), 米色纸感(底色由 CSS 给), 含标题+正文
    const noteId = doc.addBlock("affine:note", { xywh: "[0,0,440,620]" }, rootId);
    doc.addBlock("affine:paragraph", { type: "h1" as any }, noteId);
    doc.addBlock("affine:paragraph", {}, noteId);
  });
  c.setDocMeta(doc.id, { title: "未命名笔记", updatedDate: Date.now() } as any);
  return doc;
}

/** first non-empty paragraph/heading text — the note's auto-title (no editor needed). */
function firstLineOf(doc: any): string {
  try {
    const blocks = doc.getBlocksByFlavour(["affine:paragraph", "affine:list"]) || [];
    for (const b of blocks) {
      const model = b?.model ?? b; // getBlocksByFlavour returns Block (.model); be defensive
      const s = model?.text?.toString?.().trim();
      if (s) return s.slice(0, 80);
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
    c.setDocMeta(nd.id, {
      title: (((doc.meta as any)?.title || "未命名笔记") + " 副本"),
      updatedDate: Date.now(),
    } as any);
    return nd.id;
  } catch {
    return null;
  }
}

// remember the last-opened note so re-summoning lands you back where you were (#4)
const LAST_KEY = "poof-notes-last";
// 默认 = 画布(edgeless): 半透明暗色玻璃板 + 一张米色文档方框。page 是"展开写作"的可选模式。
const MODE_KEY = "poof-notes-mode";
type EditorMode = "page" | "edgeless";
function loadMode(): EditorMode {
  return localStorage.getItem(MODE_KEY) === "page" ? "page" : "edgeless";
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
}
type View = "notes" | "archive" | "trash";
type Sort = "updated" | "created" | "title";

export function NotesWorkspace({ onClose }: { onClose: () => void }) {
  const c = getCollection();
  const host = useRef<HTMLDivElement>(null);
  const [metas, setMetas] = useState<Meta[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [q, setQ] = useState("");
  const [full, setFull] = useState(true); // #6 默认全屏, 用户想退全屏再说
  const [libOpen, setLibOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false); // #7 笔记里的 powershell 右侧栏
  const [mode, setMode] = useState<EditorMode>(loadMode); // #3 文档/画布
  const editorRef = useRef<AffineEditorContainer | null>(null);
  const [view, setView] = useState<View>("notes");
  const [sort, setSort] = useState<Sort>("updated");
  const [tags, setTags] = useState<TagMap>(loadTags);
  const [ready, setReady] = useState(false);
  const [verOpen, setVerOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const seeded = useRef(false);
  const [geom, setGeom] = useState<Geom>(loadGeom);

  // ⚠ 整页重载(Rust 重编重启 / 改入口文件 / 手动刷新)会把还挂着的 BlockSuite 编辑器暴力拆掉,
  // 撞崩 WebView2 渲染进程 —— 实测 poof.exe exit 0xcfffffff 且无 Rust panic(就是这条整页重载,
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
    return c.meta.docMetas.map((m: any) => ({
      id: m.id,
      title: (m.title || "").trim(),
      archived: !!m.archived,
      trashed: !!m.trashed,
      favorite: !!m.favorite,
      createDate: m.createDate,
      updatedDate: m.updatedDate,
    }));
  }

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

  // 打开时落点 (#4): 上次打开的笔记 → 否则最近修改的真实笔记 → 否则新建一条。绝不停在空白/旧测试笔记。
  useEffect(() => {
    if (!ready || seeded.current || activeId) return;
    const all = readMetas();
    const live = all.filter((m) => !m.trashed && !m.archived);
    if (live.length === 0) {
      // 没有可打开的真实笔记(首次运行, 或全在回收站/归档) → 新建一条
      seeded.current = true;
      const d = seedDoc(c);
      setActiveId(d.id);
      return;
    }
    const lastId = localStorage.getItem(LAST_KEY) || "";
    const pick =
      live.find((m) => m.id === lastId) ??
      [...live].sort((a, b) => (b.updatedDate || 0) - (a.updatedDate || 0))[0];
    setActiveId(pick.id);
  }, [ready, c, activeId]);

  // 记住当前打开的笔记, 下次召出回到这里 (#4)
  useEffect(() => {
    if (activeId) localStorage.setItem(LAST_KEY, activeId);
  }, [activeId]);

  // mount the BlockSuite editor for the active doc + auto-sync its title (fixes 未命名)
  useEffect(() => {
    if (!activeId || !host.current) return;
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
      editor.mode = loadMode() as any; // 默认画布
      host.current.innerHTML = "";
      host.current.appendChild(editor);
      editorRef.current = editor;
      localizeSlashMenu(editor); // #8 slash 菜单中文(config)
      installChromeTranslator(); // #8 全量中文(格式条/工具条/tooltip/链接卡片, DOM 级)
      installFileTemplateSearch(); // #5 工具栏"Search file or anything"(模板面板)→ 搜本机文件(Everything)
      hookCleanups.push(installFileWriteback(doc)); // 活文件块: 改文本块 → 防抖写回源文件
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
  }, [activeId, c]);

  // #3 文档/画布切换: 不重挂编辑器, 直接切 mode + 记住
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
    if (editorRef.current) {
      try {
        editorRef.current.mode = mode as any;
      } catch {
        /* ignore */
      }
    }
  }, [mode]);

  // 从系统拖文件进笔记 → 直接插进当前笔记(只在笔记打开时挂监听)。Tauri 给的是真实磁盘路径,
  // 正好喂给 insertFileIntoNote(文本→可编辑写回 / 图片PDF→预览 / 其它→文件卡)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    getCurrentWebview()
      .onDragDropEvent((ev: any) => {
        if (ev.payload?.type !== "drop" || !activeId) return;
        const doc = c.getDoc(activeId);
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
  }, [activeId, c]);

  // 笔记库就绪后, 后台全量补导一次 .md(没打开过的老笔记也导)+ 刷 index。一次性(带 flag), 幂等。
  useEffect(() => {
    if (ready) void backfillExports(c);
  }, [ready, c]);


  // ---- actions ----
  function createNote() {
    const d = seedDoc(c);
    setActiveId(d.id);
    setView("notes");
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
  function rename(id: string) {
    const cur = metas.find((m) => m.id === id)?.title || "";
    const v = window.prompt("重命名笔记：", cur);
    if (v == null) return;
    const name = v.trim() || "未命名笔记";
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

  const activeTitle = metas.find((m) => m.id === activeId)?.title || "未命名笔记";

  return (
    <div
      className={"notes-ws " + mode + (full ? " full" : "")}
      style={full ? undefined : { left: geom.x, top: geom.y, width: geom.w, height: geom.h }}
    >
      <div className="notespace" ref={host} />

      {!full && (
        <>
          {["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => (
            <div key={d} className={"nws-rz " + d} onPointerDown={(e) => startDrag(e, d)} />
          ))}
        </>
      )}

      <div
        className="notes-bar"
        onPointerDown={(e) => {
          if (!full && !(e.target as HTMLElement).closest("button,input")) startDrag(e, "move");
        }}
        title={full ? undefined : "拖这里移动窗口"}
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
        <span className="notes-bar-title">{activeTitle}</span>
        <span className="notes-bar-spacer" />
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
          title="复制当前笔记链接(发给 AI：poof-note://… · AI 可 omni notes show/search/编辑)"
          disabled={!activeId}
          onClick={() => { if (activeId) void copyText(`poof-note://${activeId}`); }}
        >
          <Link2 size={15} />
        </button>
        <button
          className={"notes-bar-btn" + (termOpen ? " on" : "")}
          title="PowerShell（笔记里的终端容器，右侧栏）"
          onClick={() => setTermOpen((t) => !t)}
        >
          <SquareTerminal size={15} />
        </button>
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
      </div>

      {/* #2 展开写作=从笔记块的元素工具条触发(见 mountNoteExpandButton)。这里只在"已展开(page)"时
          给一个回到画布的出口(page 模式没有画布元素工具条)。 */}
      {mode === "page" && (
        <button className="notes-expand" title="回到画布" onClick={() => setMode("edgeless")}>
          <LayoutGrid size={14} /> 回到画布
        </button>
      )}

      {termOpen && (
        <div className="notes-term">
          <div className="notes-term-head">
            <SquareTerminal size={13} /> PowerShell
            <span style={{ flex: 1 }} />
            <button className="notes-lib-x" onClick={() => setTermOpen(false)} title="收起">
              <X size={14} />
            </button>
          </div>
          <div className="notes-term-body">
            <TerminalView id="notes-ps" />
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
                className={"notes-item" + (m.id === activeId ? " on" : "")}
                onClick={() => view !== "trash" && setActiveId(m.id)}
                onDoubleClick={() => view === "notes" && rename(m.id)}
              >
                <div className="notes-item-title">
                  {m.favorite && view === "notes" ? "★ " : ""}
                  {m.title || "未命名笔记"}
                </div>
                {!!(tags[m.id] || []).length && (
                  <div className="notes-item-tags" onClick={(e) => e.stopPropagation()}>
                    {(tags[m.id] || []).map((t) => (
                      <TagChip key={t} name={t} onRemove={() => removeNoteTag(m.id, t)} />
                    ))}
                  </div>
                )}
                <div className="notes-item-acts" onClick={(e) => e.stopPropagation()}>
                  {view === "notes" && (
                    <>
                      <button title="置顶/取消" onClick={() => setFlag(m.id, { favorite: !m.favorite })}>
                        <Star size={13} fill={m.favorite ? "currentColor" : "none"} />
                      </button>
                      <button title="重命名" onClick={() => rename(m.id)}>
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
    </div>
  );
}
