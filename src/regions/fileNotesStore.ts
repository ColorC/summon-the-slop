// 工作流一: 把笔记从 WebView2 不透明 IndexedDB 搬到磁盘浅路径(notesstore.rs 定根:
// 环境变量 OVERLAY_NOTE_STORE_ROOT, 缺省 %LOCALAPPDATA%\overlay-shell\note-store\)。
//  · FileDocSource  —— BlockSuite 的 DocSource(每个 Yjs doc 一份合并快照 <id>.ydoc), 语义照搬官方
//    IndexedDBDocSource(mergeCount=1, push 合并、pull diff)。
//  · FileBlobSource —— BlockSuite 的 BlobSource(图片/PDF 落 blobs/<sha>; 原来是 MemoryBlobSource 关即丢)。
//  · ensureMigrated —— 首次切换时把旧 IndexedDB("poof-notes")里的 doc 一次性写成 .ydoc(零丢失, 旧库不删)。
// 所有真正的磁盘读写在 Rust(notesstore.rs), 这里只做 Yjs 合并/diff + base64 编解码。
import * as Y from "yjs";
import { diffUpdate, encodeStateVectorFromUpdate, mergeUpdates } from "yjs";
import { openDB } from "idb";
import {
  notesDocGet,
  notesDocPut,
  notesDocKeys,
  notesBlobGet,
  notesBlobPut,
  notesBlobDel,
  notesBlobKeys,
} from "../lib";
import { isBoundSubDoc } from "./boundRegistry";

// ---- base64 <-> bytes(分块, 防大数组爆栈/二次方拼接)----
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  }
  return btoa(s);
}

// ---- DocSource: 落盘 ----
let activeDocSource: FileDocSource | null = null;
/** 关窗/重载前调: 把还在防抖窗口里没落盘的改动立刻写盘(尽力而为)。 */
export function flushNotesStore(): Promise<void> {
  return activeDocSource ? activeDocSource.flush() : Promise.resolve();
}

export class FileDocSource {
  name = "poof-file";
  private cache = new Map<string, Uint8Array>(); // docId -> 合并后的完整 update
  private loaded = new Set<string>(); // 已问过磁盘(避免重复 IO + 区分"没有"与"没读过")
  private timers = new Map<string, number>();
  private dirty = new Set<string>(); // 有改动但还没确认落盘的 doc(写失败也留在这里 → 重试/flush)
  private retries = new Map<string, number>(); // 连续落盘失败次数(退避 + 封顶, 防持久故障无限重试)

  constructor(private ready: Promise<void>) {
    activeDocSource = this;
  }

  private async load(docId: string): Promise<Uint8Array | null> {
    const c = this.cache.get(docId);
    if (c) return c;
    if (this.loaded.has(docId)) return null;
    let b64: string | null = null;
    try {
      b64 = await notesDocGet(docId);
    } catch {
      /* 读失败当没有, 别卡住编辑 */
    }
    this.loaded.add(docId);
    if (!b64) return null;
    const bytes = b64ToBytes(b64);
    this.cache.set(docId, bytes);
    return bytes;
  }

  private async writeNow(docId: string): Promise<void> {
    const bytes = this.cache.get(docId);
    if (!bytes) return;
    try {
      await notesDocPut(docId, bytesToB64(bytes));
      this.dirty.delete(docId);
      this.retries.delete(docId);
    } catch (e) {
      // ⚠ 别静默吞: 公司机 EDR/杀软可能让 rename 失败(os error 5/32), 吞掉=这次改动悄悄丢。
      // 但也别无限转: 退避重试, 超过上限就停掉定时重试(改动仍留 dirty/cache, 下次 push 或 flush 会再试)。
      const n = (this.retries.get(docId) ?? 0) + 1;
      this.retries.set(docId, n);
      if (n <= 6) {
        const delay = Math.min(1500 * 2 ** (n - 1), 30000); // 1.5→3→6→12→24→30s 封顶
        // eslint-disable-next-line no-console
        console.error(`[notes] 落盘失败(第${n}次), ${delay}ms 后重试`, docId, e);
        this.scheduleWrite(docId, delay);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[notes] 落盘连续失败 ${n} 次, 暂停自动重试(改动仍在内存, 下次编辑/关窗会再试)`, docId);
      }
    }
  }

  private scheduleWrite(docId: string, delay = 400): void {
    this.dirty.add(docId);
    const prev = this.timers.get(docId);
    if (prev) clearTimeout(prev);
    const t = window.setTimeout(() => {
      this.timers.delete(docId);
      void this.writeNow(docId);
    }, delay);
    this.timers.set(docId, t);
  }

  /** 立刻落盘所有 dirty doc(关窗/重载前调)。注意: pagehide/beforeunload 里异步 IPC 不保证跑完,
   *  但能覆盖 HMR 整页重载等"撕 WebView 前还有一拍"的常见场景, 比完全不 flush 强得多。 */
  async flush(): Promise<void> {
    const ids = [...this.dirty];
    for (const id of ids) {
      const prev = this.timers.get(id);
      if (prev) {
        clearTimeout(prev);
        this.timers.delete(id);
      }
    }
    await Promise.all(ids.map((id) => this.writeNow(id)));
  }

  async pull(
    docId: string,
    state: Uint8Array
  ): Promise<{ data: Uint8Array; state?: Uint8Array } | null> {
    await this.ready;
    const update = await this.load(docId);
    if (!update) return null;
    const diff = state.length ? diffUpdate(update, state) : update;
    return { data: diff, state: encodeStateVectorFromUpdate(update) };
  }

  async push(docId: string, data: Uint8Array): Promise<void> {
    await this.ready;
    const existing = await this.load(docId);
    const merged = existing ? mergeUpdates([existing, data]) : data;
    this.cache.set(docId, merged);
    this.loaded.add(docId);
    this.retries.delete(docId); // 新编辑 → 重置重试预算(给故障恢复后的新内容一个新机会)
    this.scheduleWrite(docId);
  }

  subscribe(): () => void {
    return () => {}; // 单窗口, 无需跨 tab 广播
  }
}

// ---- BlobSource: 落盘 ----
export class FileBlobSource {
  name = "poof-file-blob";
  readonly = false;

  constructor(private ready: Promise<void>) {}

  async get(key: string): Promise<Blob | null> {
    await this.ready;
    let b64: string | null = null;
    try {
      b64 = await notesBlobGet(key);
    } catch {
      return null;
    }
    return b64 ? new Blob([b64ToBytes(b64)]) : null;
  }
  async set(key: string, value: Blob): Promise<string> {
    await this.ready;
    const buf = new Uint8Array(await value.arrayBuffer());
    await notesBlobPut(key, bytesToB64(buf));
    return key;
  }
  async delete(key: string): Promise<void> {
    await this.ready;
    await notesBlobDel(key).catch(() => {});
  }
  async list(): Promise<string[]> {
    await this.ready;
    try {
      return await notesBlobKeys();
    } catch {
      return [];
    }
  }
}

// ---- 显示标题缓存(独立于 docMeta.title)----
// 为什么要这层: docMeta.title 不是真源, 它由 BlockSuite 的 RootBlockModel 在文档加载(rootAdded)时
// 强制刷成"页标题"(affine:page.prop:title)。很多笔记的标题写在正文首行/首个标题块里, 页标题是空的,
// 于是每次加载都把 docMeta.title 刷成空 → 侧栏/桥显示"未命名"(逐篇打开也只是临时盖住, 重启又回空)。
// 不去和这个内部绑定较劲(改页标题会和正文标题重复显示), 而是另存一份"从内容扫出来的显示标题",
// 侧栏/桥在 docMeta.title 为空时回退到它。真源永远是笔记内容; 这只是个显示用的派生缓存。
const TITLE_CACHE_KEY = "poof-note-titles";
let titleCache: Record<string, string> | null = null;
function loadTitleCache(): Record<string, string> {
  if (titleCache) return titleCache;
  try {
    titleCache = JSON.parse(localStorage.getItem(TITLE_CACHE_KEY) || "{}");
  } catch {
    titleCache = {};
  }
  return titleCache!;
}
/** 取某笔记的内容派生显示标题(没有则空串)。给侧栏/桥在 docMeta.title 为空时回退用。 */
export function getCachedTitle(id: string): string {
  return loadTitleCache()[id] || "";
}
/** 写入显示标题缓存。空标题不覆盖(内容可能临时为空, 别把已知标题抹掉)。 */
export function setCachedTitle(id: string, title: string): void {
  const t = (title || "").trim().slice(0, 80);
  if (!t) return;
  const cache = loadTitleCache();
  if (cache[id] === t) return;
  cache[id] = t;
  try {
    localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

// ---- 自愈: 把磁盘上有 .ydoc 但 meta 没列的"孤儿笔记"重新加回 meta(防迁移后"笔记看不见")----
// 只读笔记内容拿标题 + 只往 meta 加条目(addDocMeta), 绝不碰笔记内容 .ydoc, 对笔记零风险。
// 内容在用户打开该笔记时由 FileDocSource 懒加载。每次启动都跑 → 即便 meta 再被截断也能恢复。
// 读 .ydoc 的标题, 并判断是否"可渲染"(有 page 根 + note 块)。空/坏文档(无 page 或无 note)不能进列表,
// 否则在 edgeless 渲染时 BlockSuite 抛 "missing surface block" / "children undefined" 直接崩 WebView2。
function scanYdoc(bytes: Uint8Array): { title: string; renderable: boolean } {
  try {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, bytes);
    const blocks = ydoc.getMap("blocks") as any;
    let pageTitle = "";
    let firstPara = ""; // 首个非空 正文段/列表(标题首选来源)
    let firstOther = ""; // 退路: 代码块首行 / 附件名(拖文件生成的笔记没有正文段也能有标题)
    let hasPage = false;
    let hasNote = false;
    blocks.forEach((b: any) => {
      const fl = b?.get?.("sys:flavour");
      if (fl === "affine:page") {
        hasPage = true;
        const t = b.get("prop:title");
        if (t?.toString) pageTitle = t.toString().trim();
      } else if (fl === "affine:note") {
        hasNote = true;
      } else if (fl === "affine:paragraph" || fl === "affine:list") {
        if (!firstPara) {
          const s = b.get("prop:text")?.toString?.().trim();
          if (s) firstPara = s;
        }
      } else if (fl === "affine:code") {
        if (!firstOther) {
          const s = b.get("prop:text")?.toString?.().trim();
          if (s) firstOther = s.split("\n")[0]; // 代码块取首行
        }
      } else if (fl === "affine:attachment" || fl === "affine:bookmark" || fl === "affine:image") {
        if (!firstOther) {
          const s = (b.get("prop:name") ?? b.get("prop:title") ?? b.get("prop:caption"))
            ?.toString?.()
            .trim();
          if (s) firstOther = s;
        }
      }
    });
    const title = (pageTitle || firstPara || firstOther || "").slice(0, 80);
    return { title, renderable: hasPage && hasNote };
  } catch {
    return { title: "", renderable: false };
  }
}

export async function healOrphanNotes(collection: any): Promise<{ added: number; titled: number }> {
  let keys: string[] = [];
  try {
    keys = await notesDocKeys();
  } catch {
    return { added: 0, titled: 0 };
  }
  let added = 0;
  let titled = 0;
  for (const id of keys) {
    if (id === collection.id) continue; // workspace 根 doc(=collectionId), 不是笔记
    if (isBoundSubDoc(id)) continue; // 同步源块的绑定子文档(embed 内容), 不是独立笔记, 别列进去
    // 扫一次 .ydoc 拿标题 + 可渲染性(补登记孤儿 + 喂显示标题缓存都要用)。
    let title = "";
    let renderable = false;
    try {
      const b64 = await notesDocGet(id);
      if (b64) {
        const s = scanYdoc(b64ToBytes(b64));
        title = s.title;
        renderable = s.renderable;
      }
    } catch {
      /* ignore */
    }
    // 从内容扫出的标题喂进显示缓存。docMeta.title 会被 RootBlockModel 在加载时刷成空页标题(见缓存说明),
    // 所以不去改 docMeta, 让侧栏/桥读 docMeta.title || getCachedTitle(id) 即可稳定显示, 不必逐篇打开。
    if (title) {
      setCachedTitle(id, title);
      titled++;
    }
    // ⚠ 实时复查(不是开头快照): meta 是异步加载的, 延迟期间这条可能已自己进来了。
    const existing = (collection?.meta?.docMetas || []).some((m: any) => m.id === id);
    if (existing) continue;
    if (!renderable) continue; // ⚠ 空/坏文档不加进列表, 否则 edgeless 渲染崩 WebView2
    try {
      collection.meta.addDocMeta({
        id,
        title: title || "未命名笔记",
        createDate: Date.now(),
        tags: [],
      });
      added++;
    } catch {
      /* 已存在/竞态, 跳过 */
    }
  }
  if (added) {
    // eslint-disable-next-line no-console
    console.log(`[notes] 自愈: 补登记 ${added} 篇孤儿笔记`);
  }
  // 缓存里有了新标题 → 戳一下 docUpdated, 让已打开的侧栏重新 readMetas 拿到回退标题(缓存在 localStorage,
  // 不会自己触发刷新)。docAdded 已由 addDocMeta 触发, 这里补 titled 的情况。
  if (titled) {
    try {
      collection.slots.docUpdated.emit();
    } catch {
      /* ignore */
    }
  }
  return { added, titled };
}

// ---- 一次性迁移: 旧 IndexedDB("poof-notes") → 磁盘 .ydoc ----
const MIGRATED_FLAG = "poof-notes-migrated-v1";
let migrationPromise: Promise<void> | null = null;

export function ensureMigrated(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    try {
      if (localStorage.getItem(MIGRATED_FLAG)) return;
      // 别用 openDB(name, 1): 旧库不存在会建空僵尸库; 旧库版本若更高会抛 VersionError → 被误判"没数据"
      // 永久跳过真数据。先查存在性, 再用现有版本打开(不传 version = 不升级不新建)。
      try {
        const dbs: any[] = (await (indexedDB as any).databases?.()) || [];
        if (Array.isArray(dbs) && dbs.length && !dbs.some((d) => d?.name === "poof-notes")) {
          localStorage.setItem(MIGRATED_FLAG, "1");
          return; // 确认旧库不存在 → 首次安装
        }
      } catch {
        /* databases() 不支持就继续尝试打开 */
      }
      let db: any;
      try {
        // 不传 version: 已存在则按现有版本打开(不升级/不抛 VersionError)。⚠ 但**旧库不存在时 open 仍会以
        // v1 新建一个空库**(无 upgrade 回调=空升级), 所以下面发现没有 collection store 时要把这个空僵尸库删掉。
        // databases() 可用时通常已提前早退、走不到这, 这只是 databases() 不可用路径的兜底。
        db = await openDB("poof-notes");
      } catch (e) {
        // ⚠ 打开失败可能只是暂时的: 别设 flag(否则永久跳过真数据), 下次重试。
        // eslint-disable-next-line no-console
        console.error("[notes] 打开旧库失败, 下次重试", e);
        return;
      }
      if (!db.objectStoreNames.contains("collection")) {
        db.close();
        try {
          indexedDB.deleteDatabase("poof-notes"); // 清掉刚才可能建出的空僵尸库
        } catch {
          /* ignore */
        }
        localStorage.setItem(MIGRATED_FLAG, "1");
        return; // 没有旧数据(首次安装), 直接标记
      }
      const rows = await db.getAll("collection");
      db.close();
      let n = 0;
      for (const row of rows) {
        try {
          const updates = (row?.updates || [])
            .map((u: any) => u?.update)
            .filter((u: any) => u);
          if (!updates.length) continue;
          let merged: Uint8Array = updates.length === 1 ? updates[0] : mergeUpdates(updates);
          // 覆盖保护: 上次迁移失败后用户可能已在新库写过这条 → 合并而非直接覆盖, 别丢那段编辑。
          const existing = await notesDocGet(row.id).catch(() => null);
          if (existing) {
            try {
              merged = mergeUpdates([b64ToBytes(existing), merged]);
            } catch {
              /* 合并失败就用迁移数据 */
            }
          }
          await notesDocPut(row.id, bytesToB64(merged));
          n++;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[notes] 迁移 doc 失败", row?.id, e);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[notes] 已迁移 ${n} 个 doc 到磁盘(旧 IndexedDB 保留未删)`);
      localStorage.setItem(MIGRATED_FLAG, "1");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[notes] 迁移异常(下次重试)", e);
      // 故意不设 flag → 下次重试; ready 仍 resolve, 不卡启动
    }
  })();
  return migrationPromise;
}
