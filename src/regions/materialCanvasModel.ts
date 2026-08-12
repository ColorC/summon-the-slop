export type MaterialSource =
  | { kind: "file"; path: string; token: string; mime?: string; editableId?: string }
  | { kind: "link"; url: string }
  | { kind: "legacy-note"; id: string };

export type CardKind = "text" | "material";
export type MaterialAdapter =
  | "auto"
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "web"
  | "link"
  | "file"
  | "legacy-note";

export interface CanvasCardRecord {
  id: string;
  kind: CardKind;
  title: string;
  text?: string;
  source?: MaterialSource;
  adapter: MaterialAdapter;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 冻结快照元数据: 存在即渲染为死快照; from/fromAdapter 记住活源供解冻新开一块。 */
  frozen?: { capturedAt: string; from: MaterialSource; fromAdapter: MaterialAdapter };
}

export interface CanvasRelationRecord {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface MaterialCanvasDocument {
  version: 1;
  sessionId: string;
  updatedAt: string;
  cards: CanvasCardRecord[];
  relations: CanvasRelationRecord[];
}

export function safeRandomId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUuid) return `${prefix}${randomUuid()}`;
  const random = Math.random().toString(36).slice(2);
  return `${prefix}${Date.now().toString(36)}-${random}`;
}

export function canvasStorageId(sessionId: string): string {
  const bytes = new TextEncoder().encode(sessionId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `session-${encoded.slice(0, 180)}`;
}

export function normalizeLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("/")) return null;
  try {
    const url = new URL(trimmed, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function adapterForLink(urlText: string): MaterialAdapter {
  const url = new URL(urlText);
  const path = url.pathname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(path)) return "image";
  if (/\.pdf$/.test(path)) return "pdf";
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(path)) return "audio";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  return url.origin === window.location.origin ? "web" : "link";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validSource(value: unknown): value is MaterialSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (source.kind === "file") {
    return typeof source.path === "string" && typeof source.token === "string";
  }
  if (source.kind === "link") return typeof source.url === "string";
  if (source.kind === "legacy-note") return typeof source.id === "string";
  return false;
}

function validFrozen(value: unknown): CanvasCardRecord["frozen"] {
  if (!value || typeof value !== "object") return undefined;
  const frozen = value as Record<string, unknown>;
  if (!validSource(frozen.from) || typeof frozen.fromAdapter !== "string") return undefined;
  return {
    capturedAt: typeof frozen.capturedAt === "string" ? frozen.capturedAt : "",
    from: frozen.from,
    fromAdapter: frozen.fromAdapter as MaterialAdapter,
  };
}

export function parseCanvasDocument(raw: string | null, sessionId: string): MaterialCanvasDocument | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MaterialCanvasDocument>;
    if (value.version !== 1 || !Array.isArray(value.cards) || !Array.isArray(value.relations)) return null;
    const cards = value.cards.flatMap((candidate): CanvasCardRecord[] => {
      if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") return [];
      const kind = candidate.kind === "material" ? "material" : "text";
      if (kind === "material" && !validSource(candidate.source)) return [];
      if (kind === "text" && !validSource(candidate.source)) return [];
      return [{
        id: candidate.id,
        kind,
        title: typeof candidate.title === "string" ? candidate.title : "未命名卡片",
        text: typeof candidate.text === "string" ? candidate.text : undefined,
        source: validSource(candidate.source) ? candidate.source : undefined,
        adapter: typeof candidate.adapter === "string" ? candidate.adapter as MaterialAdapter : "auto",
        frozen: validFrozen(candidate.frozen),
        x: finite(candidate.x, 80),
        y: finite(candidate.y, 72),
        width: Math.max(260, finite(candidate.width, 440)),
        height: Math.max(180, finite(candidate.height, 320)),
      }];
    });
    const ids = new Set(cards.map((card) => card.id));
    const relations = value.relations.flatMap((candidate): CanvasRelationRecord[] => {
      if (!candidate || typeof candidate !== "object") return [];
      if (typeof candidate.id !== "string" || typeof candidate.source !== "string" || typeof candidate.target !== "string") return [];
      if (!ids.has(candidate.source) || !ids.has(candidate.target)) return [];
      return [{
        id: candidate.id,
        source: candidate.source,
        target: candidate.target,
        label: typeof candidate.label === "string" ? candidate.label : undefined,
      }];
    });
    return {
      version: 1,
      sessionId,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      cards,
      relations,
    };
  } catch {
    return null;
  }
}
