// Note version history — persistent Yjs snapshots in our OWN IndexedDB store (NOT the
// BlockSuite `poof-notes` DB, which compacts updates). Each version is a full
// Y.encodeStateAsUpdate() byte blob; restore = apply into a fresh doc.
const DB = "poof-note-versions";
const STORE = "versions";
const MAX_PER_DOC = 40;

export interface NoteVersion {
  id?: number;
  docId: string;
  ts: number;
  label: string;
  bytes: Uint8Array;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("docId", "docId", { unique: false });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function listVersions(docId: string): Promise<NoteVersion[]> {
  const db = await openDB();
  try {
    const out = await new Promise<NoteVersion[]>((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).index("docId").getAll(docId);
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    return out.sort((a, b) => b.ts - a.ts); // newest first
  } finally {
    db.close();
  }
}

export async function saveVersion(docId: string, bytes: Uint8Array, label: string): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add({ docId, ts: Date.now(), label, bytes });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
  // evict the oldest beyond the cap
  const all = await listVersions(docId);
  if (all.length > MAX_PER_DOC) {
    const drop = all.slice(MAX_PER_DOC);
    const db2 = await openDB();
    try {
      const tx = db2.transaction(STORE, "readwrite");
      drop.forEach((v) => v.id != null && tx.objectStore(STORE).delete(v.id));
      await new Promise<void>((r) => (tx.oncomplete = () => r()));
    } finally {
      db2.close();
    }
  }
}

export async function deleteVersionsFor(docId: string): Promise<void> {
  const vs = await listVersions(docId);
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, "readwrite");
    vs.forEach((v) => v.id != null && tx.objectStore(STORE).delete(v.id));
    await new Promise<void>((r) => (tx.oncomplete = () => r()));
  } finally {
    db.close();
  }
}
