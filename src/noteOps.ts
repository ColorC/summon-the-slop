// 笔记 ops 桥 — poof 前端轮询 nb_pending, 在活的 BlockSuite collection 上做定向 op, nb_respond 回结果。
// 全是定向 op(查/加/删/改单元素), 不整 doc 替换 → 不损坏笔记。给 `omni notes` CLI(codex 总控)用。
import { invoke } from "@tauri-apps/api/core";
import { Text } from "@blocksuite/store";
import { getCollection } from "./regions/NotesWorkspace";

let activeEditor: { setEditor?: unknown } | any = null;
export function setActiveEditor(ed: unknown): void {
  activeEditor = ed;
}

function blockText(model: any): string {
  try {
    const t = model?.text;
    if (!t) return "";
    if (t.yText?.toString) return t.yText.toString();
    if (typeof t.toString === "function") {
      const s = t.toString();
      if (s && s !== "[object Object]") return s;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function allBlocks(doc: any): any[] {
  const out: any[] = [];
  const visit = (m: any) => {
    if (!m) return;
    out.push(m);
    (m.children || []).forEach(visit);
  };
  try {
    visit(doc.root);
  } catch {
    /* ignore */
  }
  return out;
}

function metas(c: any): any[] {
  try {
    return c.meta?.docMetas ?? [];
  } catch {
    return [];
  }
}

function findBlock(doc: any, id: string): any {
  return doc.getBlock?.(id)?.model || allBlocks(doc).find((b: any) => b.id === id) || null;
}

function elemView(note: string, b: any, n = 160): any {
  return { id: b.id, flavour: b.flavour, text: blockText(b).slice(0, n), link: `poof-note://${note}/${b.id}` };
}

function handleNoteOp(cmd: any): any {
  const c = getCollection();
  const op = cmd.op;
  try {
    if (op === "list") {
      return {
        ok: true,
        notes: metas(c).map((m: any) => {
          const d = c.getDoc(m.id);
          return { id: m.id, title: m.title || "未命名", elements: d ? allBlocks(d).length : 0 };
        }),
      };
    }
    if (op === "templates") {
      return {
        ok: true,
        templates: ["affine:paragraph", "affine:list", "affine:code", "affine:image",
          "affine:note", "affine:bookmark", "affine:divider", "affine:database"],
      };
    }
    if (op === "search") {
      const q = String(cmd.query || "").toLowerCase();
      const hits: any[] = [];
      for (const m of metas(c)) {
        const d = c.getDoc(m.id);
        if (!d) continue;
        const titleHit = String(m.title || "").toLowerCase().includes(q);
        const elems = allBlocks(d).filter((b) => blockText(b).toLowerCase().includes(q));
        if (titleHit || elems.length) {
          hits.push({
            note: m.id, title: m.title || "未命名", titleHit, link: `poof-note://${m.id}`,
            elements: elems.slice(0, 20).map((b) => elemView(m.id, b, 120)),
          });
        }
      }
      return { ok: true, hits };
    }

    if (op === "refresh") {
      return { ok: true, op };
    }
    if (op === "new") {
      const id = "note-" + Math.random().toString(36).slice(2, 9);
      const doc: any = c.createDoc({ id });
      doc.load(() => {
        const root = doc.addBlock("affine:page", { title: new Text(String(cmd.title || "新笔记")) });
        const noteBlk = doc.addBlock("affine:note", {}, root);
        doc.addBlock("affine:paragraph", { text: new Text(String(cmd.text || "")) }, noteBlk);
      });
      return { ok: true, created: id, link: `poof-note://${id}` };
    }

    const note = cmd.note;
    const doc = note ? c.getDoc(note) : null;
    if (!doc) return { ok: false, error: `没找到笔记 ${note}` };

    if (op === "show") {
      return {
        ok: true, note, title: metas(c).find((m: any) => m.id === note)?.title,
        elements: allBlocks(doc).map((b) => elemView(note, b, 300)),
      };
    }
    if (op === "add") {
      const parent =
        cmd.parent ||
        allBlocks(doc).find((b: any) => b.flavour === "affine:note")?.id ||
        doc.root?.id;
      const props: any = {};
      if (cmd.text) props.text = new Text(String(cmd.text));
      const id = doc.addBlock(cmd.flavour || "affine:paragraph", props, parent);
      return { ok: true, added: id, link: `poof-note://${note}/${id}` };
    }
    if (op === "update") {
      const b = findBlock(doc, cmd.block);
      if (!b) return { ok: false, error: `没找到元素 ${cmd.block}` };
      const props = { ...(cmd.props || {}) };
      if (props.text !== undefined && b.text) {
        const s = String(props.text);
        doc.transact?.(() => {
          try {
            b.text.delete(0, b.text.length);
            b.text.insert(s, 0);
          } catch {
            /* ignore */
          }
        });
        delete props.text;
      }
      if (Object.keys(props).length) doc.updateBlock(b, props);
      return { ok: true, updated: cmd.block };
    }
    if (op === "delete") {
      const b = findBlock(doc, cmd.block);
      if (!b) return { ok: false, error: `没找到元素 ${cmd.block}` };
      doc.deleteBlock(b);
      return { ok: true, deleted: cmd.block };
    }
    if (op === "center") {
      if (!activeEditor) return { ok: false, error: "笔记面板没开,无法居中(数据 op 不受影响)" };
      try {
        activeEditor.doc = doc;
        activeEditor.std?.command?.exec?.("fitToScreen");
      } catch {
        /* best-effort */
      }
      return { ok: true, op };
    }
    return { ok: false, error: `未知 op ${op}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

let timer: number | undefined;
export function startNoteBridge(): void {
  if (timer) return;
  try {
    getCollection(); // 预热: 加载 IndexedDB 笔记, 即使笔记面板没开过
  } catch {
    /* ignore */
  }
  const tick = async () => {
    let pending: [string, string][] = [];
    try {
      pending = await invoke<[string, string][]>("nb_pending");
    } catch {
      return;
    }
    for (const [id, body] of pending) {
      let result: any;
      try {
        result = handleNoteOp(JSON.parse(body));
      } catch (e) {
        result = { ok: false, error: String(e) };
      }
      try {
        await invoke("nb_respond", { id, body: JSON.stringify(result) });
      } catch {
        /* ignore */
      }
    }
  };
  timer = window.setInterval(tick, 1200);
}
