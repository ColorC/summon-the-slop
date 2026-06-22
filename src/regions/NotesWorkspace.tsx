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
} from "lucide-react";
import { TerminalView } from "./Terminal";
import { copyText } from "../lib";
import * as Y from "yjs";
import "@toeverything/theme/style.css";
import { Schema, DocCollection, Job, type Doc } from "@blocksuite/store";
import { listVersions, saveVersion, deleteVersionsFor, type NoteVersion } from "./noteVersions";
import { AffineSchemas } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { IndexedDBDocSource } from "@blocksuite/sync";
import { OverrideThemeExtension } from "@blocksuite/affine-shared/services";
import { signal } from "@preact/signals-core";
import { effects as blocksEffects } from "@blocksuite/blocks/effects";
import { effects as presetsEffects } from "@blocksuite/presets/effects";

// force dark theme on the editor (toolbar + default elements = 深底浅字)
const DARK = signal("dark" as any);
const DARK_THEME = OverrideThemeExtension({
  getAppTheme: () => DARK,
  getEdgelessTheme: () => DARK,
});

let registered = false;
function registerEffects() {
  if (registered) return;
  registered = true;
  blocksEffects();
  presetsEffects();
}

// ONE persistent, IndexedDB-backed collection for all notes (survives summons/restarts).
let collection: DocCollection | null = null;
export function getCollection(): DocCollection {
  if (collection) return collection;
  registerEffects();
  const schema = new Schema().register(AffineSchemas);
  collection = new DocCollection({
    id: "poof-notes",
    schema,
    docSources: { main: new IndexedDBDocSource("poof-notes") },
  });
  collection.meta.initialize();
  collection.start();
  return collection;
}

function seedDoc(c: DocCollection): Doc {
  const doc = c.createDoc();
  doc.load(() => {
    const rootId = doc.addBlock("affine:page", {});
    doc.addBlock("affine:surface", {}, rootId);
    // a real document block (sized note with a heading + body), not an empty rectangle
    const noteId = doc.addBlock("affine:note", { xywh: "[0,0,540,360]" }, rootId);
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
  const [view, setView] = useState<View>("notes");
  const [sort, setSort] = useState<Sort>("updated");
  const [tags, setTags] = useState<TagMap>(loadTags);
  const [ready, setReady] = useState(false);
  const [verOpen, setVerOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const seeded = useRef(false);

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
    };
    sync(); // backfill the title for older notes when opened
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

    const editor = new AffineEditorContainer();
    editor.edgelessSpecs = [...editor.edgelessSpecs, DARK_THEME];
    editor.pageSpecs = [...editor.pageSpecs, DARK_THEME];
    editor.doc = doc;
    editor.mode = "edgeless" as any;
    host.current.innerHTML = "";
    host.current.appendChild(editor);
    return () => {
      backfills.forEach((t) => clearTimeout(t));
      clearInterval(snapTimer);
      if (dirty) snap("自动"); // capture the latest edits on close
      offTitle();
      offBlock();
      try {
        editor.remove();
      } catch {
        /* ignore */
      }
    };
  }, [activeId, c]);

  // ---- actions ----
  function createNote() {
    const d = seedDoc(c);
    setActiveId(d.id);
    setView("notes");
  }
  function setFlag(id: string, flag: Partial<Record<"archived" | "trashed" | "favorite", boolean>>) {
    c.setDocMeta(id, { ...flag, updatedDate: Date.now() } as any);
    setMetas(readMetas());
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
    <div className={"notes-ws" + (full ? " full" : "")}>
      <div className="notespace" ref={host} />

      <div className="notes-bar">
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
                  <div className="notes-item-tags">
                    {(tags[m.id] || []).map((t) => (
                      <span className="notes-tag" key={t}>
                        {t}
                      </span>
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
