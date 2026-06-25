// 笔记 collection 单例 —— 从 NotesWorkspace.tsx 抽出的"非组件"导出。
//
// 为什么单独成文件: React Fast Refresh 只把"所有导出都是组件"的模块当作热更边界。
// NotesWorkspace.tsx 里曾经 `export function getCollection()`(非组件)会毒化整个文件的边界,
// 于是任何相关文件一保存,Vite 就从"热更"升级成"整页强制重载"(日志里的 unload→boot)。
// 而整页重载会把还挂着的 BlockSuite/Yjs/Lit/IndexedDB 非确定性地拆掉重建,撞崩 WebView2 渲染
// 进程 —— poof.exe 原生退出 0xcfffffff("未响应"后整窗消失)。把 getCollection 挪到这个纯 .ts
// 模块后,NotesWorkspace.tsx 只剩组件导出 → 恢复热更 → 不再整页重载,崩溃的触发源被根除。
import { Schema, DocCollection } from "@blocksuite/store";
import { AffineSchemas } from "@blocksuite/blocks";
import { effects as blocksEffects } from "@blocksuite/blocks/effects";
import { effects as presetsEffects } from "@blocksuite/presets/effects";
import { AiBlockSchema, aiBlockSchemas } from "../blocks/aiblock";
import { FileDocSource, FileBlobSource, ensureMigrated, healOrphanNotes } from "./fileNotesStore";

// Lit/BlockSuite 的 customElements.define 全局只能注册一次;跨"模块再求值"(热更)用 globalThis
// 兜底幂等,避免重复 define 抛 DOMException(BlockSuite 重新初始化时的一类致命错)。
const g = globalThis as any;

function registerEffects(): void {
  if (g.__poofBsRegistered) return;
  g.__poofBsRegistered = true;
  blocksEffects();
  presetsEffects();
}

// #6 让活的 collection 能加 AI 块: 注册 poof:aiblock + 把它加进 affine:surface 的 children 白名单
// (否则 addBlock 到 surface 会被 schema 拒)。注意 children 在 schema.model 上, 不是 schema.metadata。
function ensureAiSchema(c: DocCollection): void {
  try {
    const sm = (c as any).schema?.flavourSchemaMap;
    if (sm && !sm.get("poof:aiblock")) (c as any).schema.register([AiBlockSchema]);
    const surf = sm?.get("affine:surface");
    const kids = surf?.model?.children;
    if (Array.isArray(kids) && !kids.includes("poof:aiblock")) kids.push("poof:aiblock");
  } catch {
    /* ignore */
  }
}

// ONE persistent, IndexedDB-backed collection for all notes (survives summons/restarts).
// globalThis-pinned: 万一模块被再求值(热更),复用同一个 DocCollection/IndexedDB,绝不开第二个连接。
export function getCollection(): DocCollection {
  if (g.__poofNotesCollection) {
    ensureAiSchema(g.__poofNotesCollection);
    return g.__poofNotesCollection;
  }
  registerEffects();
  // aiBlockSchemas: 复制放宽 surface 的 children 白名单 + 追加 AiBlockSchema(见 blocks/aiblock)
  const schema = new Schema().register(aiBlockSchemas(AffineSchemas as any));
  // 落盘存储: 先跑一次性迁移(旧 IndexedDB → 磁盘), source 的 pull/push 会 await 这个 ready,
  // 所以 collection 可同步创建, IO 自动等迁移完成。数据落 E:\WindowsWorkspace\poof-notes\。
  const ready = ensureMigrated();
  const collection = new DocCollection({
    id: "poof-notes",
    schema,
    docSources: { main: new FileDocSource(ready) },
    blobSources: { main: new FileBlobSource(ready) },
  });
  collection.meta.initialize();
  collection.start();
  g.__poofNotesCollection = collection;
  // 自愈: 等迁移 + 首轮 meta pull 落定后, ① 把磁盘上有 .ydoc 却没进 meta 的孤儿笔记加回列表;
  // ② 给"在列表但标题空"的笔记从 .ydoc 内容回填标题(否则得逐篇打开才显标题, 见 healOrphanNotes)。
  // docMetas 是异步逐条 pull 的, 固定延时容易"赶早了"。所以订阅 docMetaAdded: 每当有笔记进列表就防抖
  // 跑一遍, 直到加载稳定; 再加两个绝对时点兜底(防全部早已在列表→不触发 docMetaAdded 的情况)。
  // 幂等(已登记/已有标题都跳过), 不会重复登记或来回改标题。加载窗口过后退订, 免得后续每次新建都全盘扫。
  void ready.then(() => {
    let healTimer: ReturnType<typeof setTimeout> | undefined;
    const runHeal = () => void healOrphanNotes(collection).catch(() => {});
    const scheduleHeal = () => {
      if (healTimer) clearTimeout(healTimer);
      healTimer = setTimeout(runHeal, 700);
    };
    let off: any;
    try {
      off = collection.meta.docMetaAdded.on(scheduleHeal);
    } catch {
      /* ignore */
    }
    scheduleHeal();
    setTimeout(runHeal, 2500); // 兜底一遍
    setTimeout(() => {
      runHeal(); // 兜底两遍
      try {
        off?.dispose?.();
      } catch {
        /* ignore */
      }
    }, 6000);
  });
  return collection;
}
