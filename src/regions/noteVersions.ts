// 笔记版本历史 —— 全量 Yjs 快照(Y.encodeStateAsUpdate), 落盘到 versions/<docId>/<ts>.json({label, b64})。
// 原来在自建 IndexedDB(poof-note-versions), 现搬盘, 完成"搬出 WebView2 IndexedDB"。restore = applyUpdate 进 fresh doc。
// 对外 API(listVersions/saveVersion/deleteVersionsFor/NoteVersion)不变, 调用方无需改。
import {
  notesVersionPut,
  notesVersionAll,
  notesVersionDelOne,
  notesVersionDelAll,
} from "../lib";

const MAX_PER_DOC = 40;

export interface NoteVersion {
  id?: number; // 兼容旧类型(盘存以 ts 为键, 不用 id)
  docId: string;
  ts: number;
  label: string;
  bytes: Uint8Array;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  return btoa(s);
}

// ---- 一次性迁移: 旧 IndexedDB(poof-note-versions / store versions) → 磁盘 ----
const VMIGRATED = "poof-note-versions-migrated-v1";
let vMigration: Promise<void> | null = null;

function openOldVersionsDB(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open("poof-note-versions"); // 不传 version: 存在则按现版本打开
    } catch {
      return res(null);
    }
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(null);
    req.onupgradeneeded = () => {
      /* 库不存在时会建空库(无 store), 下面 getAll 拿到 [] */
    };
  });
}
function getAllOldVersions(db: IDBDatabase): Promise<any[]> {
  return new Promise((res) => {
    try {
      if (!db.objectStoreNames.contains("versions")) return res([]);
      const req = db.transaction("versions", "readonly").objectStore("versions").getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => res([]);
    } catch {
      res([]);
    }
  });
}

function ensureVersionsMigrated(): Promise<void> {
  if (vMigration) return vMigration;
  vMigration = (async () => {
    try {
      if (localStorage.getItem(VMIGRATED)) return;
      try {
        const dbs: any[] = (await (indexedDB as any).databases?.()) || [];
        if (Array.isArray(dbs) && dbs.length && !dbs.some((d) => d?.name === "poof-note-versions")) {
          localStorage.setItem(VMIGRATED, "1");
          return; // 旧库不存在 → 首次安装
        }
      } catch {
        /* databases() 不支持就继续 */
      }
      const db = await openOldVersionsDB();
      if (!db) return; // 打开失败别设 flag, 下次重试
      if (!db.objectStoreNames.contains("versions")) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        try {
          indexedDB.deleteDatabase("poof-note-versions"); // 清掉 open 可能刚建出的空僵尸库
        } catch {
          /* ignore */
        }
        localStorage.setItem(VMIGRATED, "1");
        return; // 没有旧版本数据(首次安装)
      }
      const rows = await getAllOldVersions(db);
      try {
        db.close();
      } catch {
        /* ignore */
      }
      for (const r of rows) {
        try {
          if (!r?.docId || r?.ts == null || !r?.bytes) continue;
          const json = JSON.stringify({ label: r.label ?? "", b64: bytesToB64(r.bytes) });
          await notesVersionPut(r.docId, String(r.ts), json);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[notes] 迁移版本失败", r?.docId, r?.ts, e);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[notes] 已迁移 ${rows.length} 条版本到磁盘(旧库保留)`);
      localStorage.setItem(VMIGRATED, "1");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[notes] 版本迁移异常(下次重试)", e);
    }
  })();
  return vMigration;
}

export async function listVersions(docId: string): Promise<NoteVersion[]> {
  await ensureVersionsMigrated();
  let rows: { ts: string; json: string }[] = [];
  try {
    rows = (await notesVersionAll(docId)) ?? [];
  } catch {
    rows = [];
  }
  const out: NoteVersion[] = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.json);
      out.push({ docId, ts: Number(r.ts), label: o.label ?? "", bytes: b64ToBytes(o.b64 ?? "") });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => b.ts - a.ts); // newest first
}

export async function saveVersion(docId: string, bytes: Uint8Array, label: string): Promise<void> {
  await ensureVersionsMigrated();
  const ts = Date.now();
  const json = JSON.stringify({ label, b64: bytesToB64(bytes) });
  await notesVersionPut(docId, String(ts), json);
  // 超过上限淘汰最旧
  try {
    const all = await notesVersionAll(docId);
    if (all.length > MAX_PER_DOC) {
      const sorted = all.map((r) => Number(r.ts)).sort((a, b) => b - a); // newest first
      for (const t of sorted.slice(MAX_PER_DOC)) await notesVersionDelOne(docId, String(t));
    }
  } catch {
    /* ignore */
  }
}

export async function deleteVersionsFor(docId: string): Promise<void> {
  try {
    await notesVersionDelAll(docId);
  } catch {
    /* ignore */
  }
}
