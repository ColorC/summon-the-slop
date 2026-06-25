// 同步源块引擎 —— 把外部源(markdown 文件 / omni 实体)绑定成一个 BlockSuite 子文档(真源 = 这个 Y.Doc),
// 经 affine:embed-synced-doc 原地、可编辑地嵌进笔记; 同步适配层镜像"子文档 ⇄ 外部源":
//   · 导入: 源 markdown → 子文档(MarkdownAdapter.toDocSnapshot + Job.snapshotToDoc)
//   · 导出: 子文档 → 源 markdown(防抖, 写回前过三路合并冲突闸, 原子写)
//   · 历史: 每次落定存一版子文档 Yjs 快照(复用 noteVersions)
//   · 保真闸: 子文档里有非 markdown 可表达的块(图片/附件/AI块…)时警示, 不静默写坏源
// 设计依据见 docs/plans/synced-source-blocks-and-browse-plan.md。源类型可插拔(md-file 内置, omni-* 后加)。
import * as Y from "yjs";
import { Job } from "@blocksuite/store";
import { MarkdownAdapter } from "@blocksuite/blocks";
import { getCollection } from "./notesCollection";
import { saveVersion } from "./noteVersions";
import { readFileText, writeFileText } from "../lib";
import { diff3 } from "./diff3";

// ============ 源适配器(可插拔) ============
export interface SourceAdapter {
  kind: string; // "md-file" | "omni-plan" | "omni-progress" | "omni-review" | …
  writable: boolean; // 能不能写回(只读源 = false)
  read(ref: string): Promise<string>; // 取源当前 markdown
  write(ref: string, md: string): Promise<void>; // 写回源
  label(ref: string): string; // 显示名
}

const adapters = new Map<string, SourceAdapter>();
export function registerSourceAdapter(a: SourceAdapter): void {
  adapters.set(a.kind, a);
}
export function getSourceAdapter(kind: string): SourceAdapter | undefined {
  return adapters.get(kind);
}

// 内置: markdown 文件源(可写回)
registerSourceAdapter({
  kind: "md-file",
  writable: true,
  read: (ref) => readFileText(ref),
  write: (ref, md) => writeFileText(ref, md),
  label: (ref) => ref.replace(/\\/g, "/").split("/").pop() || ref,
});

// ============ 内容 hash(检测外部改动) ============
export function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return ("00000000" + h.toString(16)).slice(-8);
}

// ============ 绑定登记(纯 localStorage, 在 boundRegistry.ts, 防循环引用) ============
export { getBinding, setBinding, removeBinding, allBindings, isBoundSubDoc } from "./boundRegistry";
export type { Binding } from "./boundRegistry";
import { getBinding, setBinding } from "./boundRegistry";

// ============ markdown ⇄ 子文档 ============
// 子文档必须有 page+surface+note 才能被 embed-synced-doc 在画布渲染(否则 BlockSuite 抛 missing surface 崩窗)。
function ensureRenderable(subDoc: any): void {
  const root = subDoc.root;
  if (!root) return;
  if (!subDoc.getBlocksByFlavour(["affine:surface"]).length) {
    try {
      subDoc.addBlock("affine:surface", {}, root.id);
    } catch {
      /* ignore */
    }
  }
  if (!subDoc.getBlocksByFlavour(["affine:note"]).length) {
    try {
      const nid = subDoc.addBlock("affine:note", { xywh: "[0,0,800,600]" }, root.id);
      subDoc.addBlock("affine:paragraph", {}, nid);
    } catch {
      /* ignore */
    }
  }
}

/** markdown 文本 → 新建一个子文档(返回 doc, 失败 null)。 */
export async function importMdToNewSubDoc(md: string, collection?: any): Promise<any> {
  const c = collection || getCollection();
  const job = new Job({ collection: c });
  const adapter = new MarkdownAdapter(job as any);
  const snapshot = await adapter.toDocSnapshot({ file: md });
  if (!snapshot) return null;
  // 清掉默认页标题(否则导出会多出一行 "# Untitled" 噪声; md 的首个标题在正文里, 不该再有独立 doc 标题)。
  if (snapshot.meta) snapshot.meta.title = "";
  const subDoc = await (job as any).snapshotToDoc(snapshot);
  if (!subDoc) return null;
  subDoc.load();
  ensureRenderable(subDoc);
  return subDoc;
}

/** 子文档 → markdown 文本(有损投影; 不报错, 未知块静默跳过)。 */
export async function exportSubDocMd(subDoc: any, collection?: any): Promise<string> {
  const c = collection || getCollection();
  const job = new Job({ collection: c });
  const snapshot = (job as any).docToSnapshot(subDoc);
  if (!snapshot) return "";
  const result = await new MarkdownAdapter(job as any).fromDocSnapshot({
    snapshot,
    assets: (job as any).assetsManager,
  });
  let md = result?.file ?? "";
  // 兜底: 若仍把空/默认页标题输出成首行 "# " / "# Untitled", 去掉(真实首个标题 "# 标题一" 不会被误删)。
  md = md.replace(/^#\s*(Untitled)?[ \t]*\n+/, "");
  return md;
}

/** 把 markdown 重新灌进已有子文档(拉外部改动): 清空 note 子块 + 插入解析出的块。 */
export async function reimportMd(subDoc: any, md: string, collection?: any): Promise<void> {
  const c = collection || getCollection();
  const note = subDoc.getBlocksByFlavour(["affine:note"])[0];
  const noteModel = note?.model ?? note;
  if (!noteModel) return;
  for (const child of [...(noteModel.children ?? [])]) {
    try {
      subDoc.deleteBlock(child);
    } catch {
      /* ignore */
    }
  }
  const job = new Job({ collection: c });
  const adapter = new MarkdownAdapter(job as any);
  const slice = await adapter.toSliceSnapshot({
    file: md,
    workspaceId: c.id,
    pageId: subDoc.id,
  } as any);
  if (slice) {
    try {
      await (job as any).snapshotToSlice(slice, subDoc, noteModel.id, 0);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[bound] reimport slice 失败", e);
    }
  }
  // 灌完可能没留 paragraph, 补一个空段防空 note
  if (!(noteModel.children ?? []).length) {
    try {
      subDoc.addBlock("affine:paragraph", {}, noteModel.id);
    } catch {
      /* ignore */
    }
  }
}

// ============ 保真闸: 子文档里有没有 markdown 存不下的块 ============
const MD_OK = new Set([
  "affine:page",
  "affine:surface",
  "affine:note",
  "affine:paragraph",
  "affine:list",
  "affine:code",
  "affine:divider",
]);
/** 返回子文档里"markdown 存不下"的块 flavour 列表(空 = 可无损写回)。 */
export function nonMdBlocks(subDoc: any): string[] {
  const bad = new Set<string>();
  try {
    const visit = (m: any) => {
      if (!m) return;
      const fl = m.flavour;
      if (fl && !MD_OK.has(fl)) bad.add(fl);
      (m.children ?? []).forEach(visit);
    };
    visit(subDoc.root);
  } catch {
    /* ignore */
  }
  return [...bad];
}

// ============ 公开: 插入一个绑定源块 ============
/** 读源 → 建子文档 → 插 embed-synced-doc 到当前笔记。返回 embed 块 id(失败 null)。 */
export async function insertBoundSource(
  hostDoc: any,
  kind: string,
  ref: string
): Promise<string | null> {
  const adapter = getSourceAdapter(kind);
  if (!adapter) {
    // eslint-disable-next-line no-console
    console.error("[bound] 未知源类型", kind);
    return null;
  }
  let md = "";
  try {
    md = await adapter.read(ref);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[bound] 读源失败", kind, ref, e);
    return null;
  }
  const subDoc = await importMdToNewSubDoc(md, getCollection());
  if (!subDoc) return null;
  setBinding(subDoc.id, { kind, ref, base: md, hash: hashStr(md) });
  try {
    await saveVersion(subDoc.id, Y.encodeStateAsUpdate(subDoc.spaceDoc), "导入 " + adapter.label(ref));
  } catch {
    /* ignore */
  }
  const note = hostDoc.getBlocksByFlavour(["affine:note"])[0];
  const noteId = note?.model?.id ?? note?.id ?? hostDoc.root?.id;
  if (!noteId) return null;
  try {
    return hostDoc.addBlock("affine:embed-synced-doc", { pageId: subDoc.id }, noteId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[bound] 插入 embed 块失败", e);
    return null;
  }
}

// ============ 写回一次(导出 → 冲突闸 → 写源 → 回灌 → 历史)。独立可测。 ============
export async function syncBoundDoc(
  subDocId: string,
  collection?: any,
  onConflict?: (ref: string) => void
): Promise<{ wrote: boolean; conflict: boolean }> {
  const c = collection || getCollection();
  const binding = getBinding(subDocId);
  if (!binding) return { wrote: false, conflict: false };
  const adapter = getSourceAdapter(binding.kind);
  if (!adapter || !adapter.writable) return { wrote: false, conflict: false };
  const subDoc = c.getDoc(subDocId);
  if (!subDoc) return { wrote: false, conflict: false };

  let mine = "";
  try {
    mine = await exportSubDocMd(subDoc, c);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[bound] 导出失败", subDocId, e);
    return { wrote: false, conflict: false };
  }
  if (mine === binding.base) return { wrote: false, conflict: false }; // 没实质变化

  // 写回前重读源, 检测外部改动
  let theirs = binding.base;
  try {
    theirs = await adapter.read(binding.ref);
  } catch {
    /* 读不到当无外部改动 */
  }
  let toWrite = mine;
  let conflict = false;
  if (hashStr(theirs) !== binding.hash) {
    const r = diff3(binding.base, mine, theirs); // 外部也改了 → 三路合并
    toWrite = r.merged;
    conflict = r.conflict;
  }
  try {
    await adapter.write(binding.ref, toWrite);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[bound] 写回源失败", binding.ref, e);
    return { wrote: false, conflict: false };
  }
  if (toWrite !== mine) {
    await reimportMd(subDoc, toWrite, c); // 合并结果回灌, 让笔记看到合并后内容
  }
  setBinding(subDocId, { ...binding, base: toWrite, hash: hashStr(toWrite) });
  try {
    await saveVersion(
      subDocId,
      Y.encodeStateAsUpdate(subDoc.spaceDoc),
      (conflict ? "冲突合并 " : "写回 ") + adapter.label(binding.ref)
    );
  } catch {
    /* ignore */
  }
  if (conflict && onConflict) onConflict(binding.ref);
  return { wrote: true, conflict };
}

// ============ 同步引擎: 监听绑定子文档 → 导出写回(冲突闸 + 历史) + 轮询外部 ============
interface SyncState {
  subDocId: string;
  off: () => void; // 取消 Yjs 监听
  timer: number; // 防抖导出
  suppress: boolean; // reimport 期间抑制自身触发的导出
  dirty: boolean; // 有未导出的本地改动
  lastConflict: boolean;
}

// 给一个 host 笔记装同步: 找它里面所有 embed-synced-doc → 绑定子文档 → 监听+导出+轮询。返回 cleanup。
export function installBoundSync(
  hostDoc: any,
  onConflict?: (ref: string) => void
): () => void {
  const collection = getCollection();
  const states = new Map<string, SyncState>();

  const exportNow = async (subDocId: string): Promise<void> => {
    const st = states.get(subDocId);
    if (!st) return;
    st.suppress = true; // syncBoundDoc 内可能 reimport(回灌) → 抑制由此触发的再导出
    try {
      const r = await syncBoundDoc(subDocId, collection, onConflict);
      st.lastConflict = r.conflict;
    } finally {
      st.suppress = false;
      st.dirty = false;
    }
  };

  const scheduleExport = (subDocId: string): void => {
    const st = states.get(subDocId);
    if (!st || st.suppress) return;
    st.dirty = true;
    if (st.timer) clearTimeout(st.timer);
    st.timer = window.setTimeout(() => {
      st.timer = 0;
      void exportNow(subDocId);
    }, 900);
  };

  const watch = (subDocId: string): void => {
    if (states.has(subDocId)) return;
    if (!getBinding(subDocId)) return;
    const subDoc = collection.getDoc(subDocId);
    if (!subDoc) return;
    subDoc.load();
    const yDoc: Y.Doc = subDoc.spaceDoc;
    const cb = () => scheduleExport(subDocId);
    yDoc.on("update", cb);
    states.set(subDocId, {
      subDocId,
      off: () => {
        try {
          yDoc.off("update", cb);
        } catch {
          /* ignore */
        }
      },
      timer: 0,
      suppress: false,
      dirty: false,
      lastConflict: false,
    });
  };

  // 扫 host 里的 embed-synced-doc → 监听它们的绑定子文档
  const scanEmbeds = (): void => {
    try {
      const embeds = hostDoc.getBlocksByFlavour(["affine:embed-synced-doc"]) || [];
      for (const e of embeds) {
        const pageId = (e.model ?? e)?.pageId;
        if (pageId && getBinding(pageId)) watch(pageId);
      }
    } catch {
      /* ignore */
    }
  };
  scanEmbeds();
  // 块可能晚物化 + 用户随后插入新的绑定块 → 周期重扫
  const scanIv = window.setInterval(scanEmbeds, 1500);

  // 外部轮询: 源被别处改了且本地无脏 → 拉进子文档(缩小冲突窗)
  const pollIv = window.setInterval(async () => {
    for (const [subDocId, st] of states) {
      if (st.dirty) continue; // 本地有改动, 留给 exportNow 合并
      const binding = getBinding(subDocId);
      if (!binding) continue;
      const adapter = getSourceAdapter(binding.kind);
      if (!adapter) continue;
      let theirs = "";
      try {
        theirs = await adapter.read(binding.ref);
      } catch {
        continue;
      }
      if (hashStr(theirs) === binding.hash) continue; // 没变
      const subDoc = collection.getDoc(subDocId);
      if (!subDoc) continue;
      st.suppress = true;
      try {
        await reimportMd(subDoc, theirs, collection);
        setBinding(subDocId, { ...binding, base: theirs, hash: hashStr(theirs) });
      } finally {
        st.suppress = false;
      }
    }
  }, 4000);

  return () => {
    clearInterval(scanIv);
    clearInterval(pollIv);
    for (const st of states.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.off();
      // 关笔记前把脏的最后导一次
      if (st.dirty) void exportNow(st.subDocId);
    }
    states.clear();
  };
}
