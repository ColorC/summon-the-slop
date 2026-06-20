import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import "@toeverything/theme/style.css"; // AFFiNE design tokens (--affine-* CSS vars)
import { Schema, DocCollection, type Doc } from "@blocksuite/store";
import { AffineSchemas } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { effects as blocksEffects } from "@blocksuite/blocks/effects";
import { effects as presetsEffects } from "@blocksuite/presets/effects";

// BlockSuite (AFFiNE engine, MPL — no license prompt) gives us the 「笔记空间」:
// an infinite edgeless canvas whose note blocks ARE full Markdown documents.
let registered = false;
function registerEffects() {
  if (registered) return;
  registered = true;
  blocksEffects();
  presetsEffects();
}

function createCollection() {
  const schema = new Schema().register(AffineSchemas);
  const collection = new DocCollection({ schema });
  collection.meta.initialize();
  return collection;
}

/** Seed a doc with page → surface(canvas) → note(markdown doc) → paragraph. */
function initDoc(doc: Doc) {
  doc.load(() => {
    const rootId = doc.addBlock("affine:page", {});
    doc.addBlock("affine:surface", {}, rootId);
    const noteId = doc.addBlock("affine:note", {}, rootId);
    doc.addBlock("affine:paragraph", {}, noteId);
  });
}

export function NoteSpace() {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [diag, setDiag] = useState<string>("");

  useEffect(() => {
    let editor: AffineEditorContainer | null = null;
    let collection: DocCollection | null = null;
    try {
      registerEffects();
      collection = createCollection();
      const doc = collection.createDoc({ id: "poof-note-1" });
      initDoc(doc);
      editor = new AffineEditorContainer();
      editor.doc = doc;
      editor.mode = "edgeless" as any; // 笔记空间 = 无限画布
      ref.current?.appendChild(editor);
      setLoading(false);
      const ed = editor;
      setTimeout(() => {
        try {
          setDiag(
            `connected=${ed.isConnected} h=${ed.offsetHeight}x${ed.offsetWidth} ` +
              `root=${!!doc.root} kids=${ed.children.length} ` +
              `vp=${!!ed.querySelector(".affine-edgeless-viewport,.edgeless-editor-container,edgeless-editor")}`
          );
        } catch (e2) {
          setDiag("diag-fail " + String(e2));
        }
      }, 1000);
    } catch (e) {
      setErr(String((e as any)?.stack || e));
      setLoading(false);
    }
    return () => {
      try {
        editor?.remove();
      } catch {
        /* ignore */
      }
      try {
        collection?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <div className="notespace-host" data-theme="dark">
      <div className="notespace" ref={ref} />
      {loading && (
        <div className="notespace-msg">
          <Loader2 size={18} className="spin" /> 加载笔记空间…
        </div>
      )}
      {err && <div className="notespace-msg error">笔记空间加载失败：{err}</div>}
      {diag && (
        <div
          style={{
            position: "absolute",
            left: 6,
            top: 6,
            zIndex: 9,
            background: "#10233a",
            color: "#9fd0ff",
            font: "11px monospace",
            padding: "4px 7px",
            borderRadius: 6,
          }}
        >
          {diag}
        </div>
      )}
    </div>
  );
}
