import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search, X, Maximize2, Minimize2, Trash2, Hash } from "lucide-react";
import "@toeverything/theme/style.css";
import { Schema, DocCollection, type Doc } from "@blocksuite/store";
import { AffineSchemas } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { IndexedDBDocSource } from "@blocksuite/sync";
import { effects as blocksEffects } from "@blocksuite/blocks/effects";
import { effects as presetsEffects } from "@blocksuite/presets/effects";

let registered = false;
function registerEffects() {
  if (registered) return;
  registered = true;
  blocksEffects();
  presetsEffects();
}

// ONE persistent, IndexedDB-backed collection for all notes (survives summons/restarts).
// Stable collection id => its docMetas (the note list) persist too.
let collection: DocCollection | null = null;
function getCollection(): DocCollection {
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
    const noteId = doc.addBlock("affine:note", {}, rootId);
    doc.addBlock("affine:paragraph", {}, noteId);
  });
  return doc;
}

// lightweight tags/category store (BlockSuite's tag schema is heavy; we keep our own)
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
}

export function NotesWorkspace({ onClose }: { onClose: () => void }) {
  const c = getCollection();
  const host = useRef<HTMLDivElement>(null);
  const [metas, setMetas] = useState<Meta[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [q, setQ] = useState("");
  const [full, setFull] = useState(false);
  const [tags, setTags] = useState<TagMap>(loadTags);
  const [ready, setReady] = useState(false);
  const seeded = useRef(false);

  // load + keep the note list in sync (after IndexedDB pull settles)
  useEffect(() => {
    const refresh = () =>
      setMetas(c.meta.docMetas.map((m: any) => ({ id: m.id, title: (m.title || "").trim() })));
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
  }, [c]);

  // first run ever → seed one note (once, after sync settled)
  useEffect(() => {
    if (!ready || seeded.current) return;
    if (c.meta.docMetas.length === 0) {
      seeded.current = true;
      const d = seedDoc(c);
      setActiveId(d.id);
    } else if (!activeId) {
      setActiveId(c.meta.docMetas[0].id);
    }
  }, [ready, c, activeId]);

  // mount the BlockSuite editor for the active doc (edgeless = infinite canvas)
  useEffect(() => {
    if (!activeId || !host.current) return;
    const doc = c.getDoc(activeId);
    if (!doc) return;
    doc.load();
    const editor = new AffineEditorContainer();
    editor.doc = doc;
    editor.mode = "edgeless" as any;
    host.current.innerHTML = "";
    host.current.appendChild(editor);
    return () => {
      try {
        editor.remove();
      } catch {
        /* ignore */
      }
    };
  }, [activeId, c]);

  function createNote() {
    const d = seedDoc(c);
    setActiveId(d.id);
  }
  function removeNote(id: string) {
    c.removeDoc(id);
    const next = tags;
    delete next[id];
    saveTags(next);
    setTags({ ...next });
    if (activeId === id) setActiveId("");
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

  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? metas.filter(
        (m) =>
          (m.title || "未命名").toLowerCase().includes(ql) ||
          (tags[m.id] || []).some((t) => t.toLowerCase().includes(ql))
      )
    : metas;

  return (
    <div className={"notes-ws" + (full ? " full" : "")}>
      {/* left rail: library — browse / search / tags */}
      <div className="notes-rail">
        <div className="notes-rail-top">
          <button className="notes-new" onClick={createNote}>
            <Plus size={15} /> 新建笔记
          </button>
          <div className="notes-search">
            <Search size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题 / 标签…"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="notes-list">
          {!ready && (
            <div className="notes-empty">
              <Loader2 size={16} className="spin" /> 载入笔记库…
            </div>
          )}
          {ready && filtered.length === 0 && <div className="notes-empty">无笔记</div>}
          {filtered.map((m) => (
            <div
              key={m.id}
              className={"notes-item" + (m.id === activeId ? " on" : "")}
              onClick={() => setActiveId(m.id)}
            >
              <div className="notes-item-title">{m.title || "未命名笔记"}</div>
              <div className="notes-item-tags">
                {(tags[m.id] || []).map((t) => (
                  <span className="notes-tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="notes-item-acts">
                <button title="加标签" onClick={(e) => { e.stopPropagation(); addTag(m.id); }}>
                  <Hash size={13} />
                </button>
                <button title="删除" onClick={(e) => { e.stopPropagation(); removeNote(m.id); }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* right: the editor (edgeless canvas) */}
      <div className="notes-main">
        <div className="notes-main-bar">
          <span className="notes-main-title">笔记空间</span>
          <div className="notes-main-acts">
            <button title={full ? "退出全屏" : "无边全屏"} onClick={() => setFull((f) => !f)}>
              {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button title="关闭" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="notespace" ref={host} />
      </div>
    </div>
  );
}
