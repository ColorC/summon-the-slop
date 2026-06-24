// 工作流一·导出物: 把保真 .ydoc 笔记导成 docs/<id>.md, 并维护根目录 index.json(id→标题/时间/标签),
// 让 omni / 人能直接读笔记。.ydoc 是真源, .md/index 是按需导出物。
//
// 导出 API(已由调研 workflow 在离屏台实测确认): Job.docToSnapshot(doc) + MarkdownAdapter.fromDocSnapshot,
// 取 result.file。md 是有损投影 —— 丢画布坐标/AI块/附件, 但**不报错、始终产出 md 字符串**(未知 flavour
// 静默跳过)。所以这里不怕笔记里有 AI 块/画布元素。
//
// 策略: 懒导出 —— 打开/编辑某条笔记时才导它的 .md(只在你真用到的笔记上花成本); index.json 则每次都从
// meta.docMetas 全量重建(标题/时间不需加载 doc), 所以 omni 拿到的笔记**清单始终完整**, 只有正文 .md 是
// 你打开过的才有。全量补导(未打开过的老笔记)留作后续(index 已能列全, 不阻塞 omni 检索)。
import { Job } from "@blocksuite/store";
import { MarkdownAdapter } from "@blocksuite/blocks";
import { notesMdPut, notesIndexPut } from "../lib";
import { recordNoteOmniLinks, omniLinksOf } from "./omniLink";

/** 单条笔记 → docs/<id>.md。跳过根 doc(id==collectionId, 是 meta 容器不是笔记)。 */
export async function exportNoteToMd(doc: any, collection: any): Promise<void> {
  if (!doc || !collection || doc.id === collection.id) return;
  try {
    doc.load();
    // ⚠ doc.load() 是同步的, 真内容靠异步 pull(await ready + IPC)。若此刻还没 pull 完, doc 里没块,
    // 导出会得到空 md → 覆盖掉已有的好 .md(静默损坏)。守卫: 没有 note 块(=没 pull 完 / 真空)就跳过,
    // 绝不用空 md clobber。真笔记 seed 时必有一个 note 块, 所以"有 note 块"≈"已 pull"。
    if (!doc.getBlocksByFlavour?.(["affine:note"]).length) return;
    const job = new Job({ collection });
    const snapshot = (job as any).docToSnapshot(doc);
    if (!snapshot) return;
    const result = await new MarkdownAdapter(job as any).fromDocSnapshot({
      snapshot,
      assets: (job as any).assetsManager,
    });
    await notesMdPut(doc.id, result?.file ?? "");
    recordNoteOmniLinks(doc); // 顺手记下这篇引用了哪些 omni 项目/计划(供 index 反向查)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[notes] 导出 md 失败", doc?.id, e);
  }
}

/** 全量重建 index.json(从 meta.docMetas, 不需加载任何 doc)。omni 检索主入口。 */
export async function rebuildNotesIndex(collection: any): Promise<void> {
  try {
    // 标签真源在 localStorage(不在 docMeta), 否则 index 里 tags 永远空 → omni 拿不到标签维度。
    let tagMap: Record<string, string[]> = {};
    try {
      tagMap = JSON.parse(localStorage.getItem("poof-notes-tags") || "{}");
    } catch {
      /* ignore */
    }
    const metas = collection?.meta?.docMetas ?? [];
    const notes = metas
      .filter((m: any) => m.id !== collection.id && !m.trashed && !m.archived) // 排除根/回收站/归档
      .map((m: any) => ({
        id: m.id,
        title: m.title || "未命名笔记",
        createDate: m.createDate ?? null,
        updatedDate: m.updatedDate ?? null,
        tags: tagMap[m.id] ?? [],
        links: omniLinksOf(m.id), // 关联的 omni 项目/计划(反向查: 哪些笔记挂了项目 X)
        ydoc: `docs/${m.id}.ydoc`,
        md: `docs/${m.id}.md`,
      }));
    const index = { version: 1, collectionId: collection.id, count: notes.length, notes };
    await notesIndexPut(JSON.stringify(index, null, 2));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[notes] 重建 index 失败", e);
  }
}

// 全量补导: 把所有(包括从没打开过的)笔记导成 .md —— 否则 index 列了它但 docs/<id>.md 不存在,
// omni 按 md 路径读会缺。一次性, 带 flag; index 每次都先全量刷新(标题级始终完整)。
const BACKFILL_FLAG = "poof-notes-md-backfill-v1";
let backfillRun: Promise<void> | null = null;
export function backfillExports(collection: any): Promise<void> {
  if (backfillRun) return backfillRun;
  backfillRun = (async () => {
    try {
      await rebuildNotesIndex(collection); // 先把 index 刷全(便宜, 不需加载 doc)
      if (localStorage.getItem(BACKFILL_FLAG)) return;
      const metas = (collection?.meta?.docMetas ?? []).filter(
        (m: any) => m.id !== collection.id && !m.trashed && !m.archived
      );
      for (const m of metas) {
        const doc = collection.getDoc?.(m.id);
        if (!doc) continue;
        doc.load();
        // 等 pull 完(出现 note 块)再导, 最多 ~3s; 等不到就跳过(下次打开会懒导), 绝不空 md clobber。
        for (let i = 0; i < 30 && !doc.getBlocksByFlavour?.(["affine:note"]).length; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        await exportNoteToMd(doc, collection);
      }
      await rebuildNotesIndex(collection);
      localStorage.setItem(BACKFILL_FLAG, "1");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[notes] backfill 失败", e);
    }
  })();
  return backfillRun;
}

// 防抖: 编辑时别每次都导(导一次要序列化整篇), 攒 1.5s 导一次 + 重建 index。
let timer = 0;
const pending = new Set<any>();
let pendingCollection: any = null;
export function scheduleNoteExport(doc: any, collection: any): void {
  if (doc) pending.add(doc);
  pendingCollection = collection;
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(async () => {
    timer = 0;
    const docs = [...pending];
    pending.clear();
    for (const d of docs) {
      // 1.5s 内 doc 可能已被删/dispose(removeDoc / bridge drop)→ 跳过, 别导一个空壳覆盖 .md。
      if (!pendingCollection?.meta?.getDocMeta?.(d.id)) continue;
      await exportNoteToMd(d, pendingCollection);
    }
    if (pendingCollection) await rebuildNotesIndex(pendingCollection);
  }, 1500);
}
