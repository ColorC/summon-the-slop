import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowUpRight,
  FilePlus2,
  FileText,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Redo2,
  RotateCcw,
  Search,
  Snowflake,
  Sun,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./material-notes.css";
import {
  adapterForLink,
  canvasStorageId,
  normalizeLink,
  parseCanvasDocument,
  safeRandomId,
  type CanvasCardRecord,
  type MaterialAdapter,
  type MaterialCanvasDocument,
  type MaterialSource,
} from "./materialCanvasModel";
import { registerCanvasHandler, type CanvasOpArgs } from "./canvasOps";
import { webNotesInvoke } from "../webNotesInvoke";

type ResizeDirection =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

interface CardData extends Record<string, unknown>, CanvasCardRecord {
  draft?: boolean;
}

type CanvasNode = Node<CardData, "materialCard">;
type CanvasEdge = Edge;

interface CanvasSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface FileHit {
  kind: "file" | "folder";
  name: string;
  path: string;
  open_token: string;
  mime?: string;
}

interface LegacyNote {
  id: string;
  title: string;
  updatedDate?: number;
  hasMarkdown: boolean;
}

export interface MaterialNotesWorkspaceProps {
  sessionId?: string;
  sessionTitle?: string;
  onReady?: () => void;
  onError?: (error: string) => void;
  invokeCommand?: MaterialNotesInvoke;
}

export type MaterialNotesInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const tauriInvoke: MaterialNotesInvoke = (command, args) => invoke(command, args);
const InvokeContext = createContext<MaterialNotesInvoke>(tauriInvoke);

interface TextMaterialPayload extends FileHit {
  editableId: string;
  content?: string;
}

interface FileInspection extends FileHit {
  preview: "text" | "image" | "pdf" | "audio" | "video" | "directory" | "none";
  content?: string;
  truncated?: boolean;
  items?: FileHit[];
}

interface CardActions {
  changeText: (id: string, value: string) => void;
  hydrateText: (id: string, material: TextMaterialPayload) => void;
  beginTextEdit: () => void;
  finishTextEdit: (id: string) => void;
  removeCard: (id: string) => void;
  toggleFullscreen: (id: string) => void;
  freezeCard: (id: string) => Promise<unknown>;
  unfreezeCard: (id: string) => { created: string };
  freezingId: string | null;
  beginResize: (
    id: string,
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLDivElement>,
    zoom: number
  ) => void;
}

const CardActionsContext = createContext<CardActions | null>(null);
// omni canvas highlight op 的聚光灯卡 id(不进 node data, 避免渗进持久化文档)
const SpotlightContext = createContext<string | null>(null);
const RESIZE_DIRECTIONS: ResizeDirection[] = [
  "top-left", "top", "top-right", "right",
  "bottom-right", "bottom", "bottom-left", "left",
];

function sessionIdentity(): { id: string; label: string } {
  const embedded = document.querySelector<HTMLMetaElement>('meta[name="omni-notes-session"]')?.content;
  if (embedded) {
    const external = decodeURIComponent(embedded);
    const title = document.querySelector<HTMLMetaElement>('meta[name="omni-notes-title"]')?.content;
    return { id: `external:${external}`, label: title || "会话札记" };
  }
  const params = new URLSearchParams(window.location.search);
  const external = params.get("session_id") || params.get("session") || params.get("sid");
  if (external) {
    return { id: `external:${external}`, label: params.get("session_title") || "会话札记" };
  }
  const key = "overlay-material-canvas-session";
  let fallback = sessionStorage.getItem(key);
  if (!fallback) {
    fallback = safeRandomId("browser:");
    sessionStorage.setItem(key, fallback);
  }
  return { id: fallback, label: "札记" };
}

function cloneNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => ({
    ...node,
    data: { ...node.data, source: node.data.source ? { ...node.data.source } : undefined },
    position: { ...node.position },
    style: { ...node.style },
    selected: false,
  }));
}

function snapshotOf(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasSnapshot {
  return { nodes: cloneNodes(nodes), edges: edges.map((edge) => ({ ...edge, selected: false })) };
}

function dimensionsOf(node: CanvasNode): { width: number; height: number } {
  return {
    width: Math.max(260, Number(node.style?.width) || node.measured?.width || node.width || 440),
    height: Math.max(180, Number(node.style?.height) || node.measured?.height || node.height || 320),
  };
}

function nodeFromCard(card: CanvasCardRecord, draft = false): CanvasNode {
  return {
    id: card.id,
    type: "materialCard",
    position: { x: card.x, y: card.y },
    style: { width: card.width, height: card.height },
    data: { ...card, draft },
  };
}

function draftNode(x = 80, y = 72): CanvasNode {
  return nodeFromCard({
    id: safeRandomId("text-"),
    kind: "text",
    title: "随手记",
    text: "",
    adapter: "text",
    x,
    y,
    width: 440,
    height: 320,
  }, true);
}

function persistedDocument(
  sessionId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): MaterialCanvasDocument {
  const persistedNodes = nodes.filter((node) =>
    !node.data.draft && (node.data.kind === "material" || Boolean(node.data.source))
  );
  const ids = new Set(persistedNodes.map((node) => node.id));
  return {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    cards: persistedNodes.map((node) => {
      const size = dimensionsOf(node);
      const { draft: _draft, text: _text, ...data } = node.data;
      return {
        ...data,
        x: node.position.x,
        y: node.position.y,
        width: size.width,
        height: size.height,
      };
    }),
    relations: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === "string" ? edge.label : undefined,
      })),
  };
}

function streamUrl(token: string): string {
  return `/lofa/overlay/file/${encodeURIComponent(token)}`;
}

function FilePreview({ source }: { source: Extract<MaterialSource, { kind: "file" }> }) {
  const invokeCommand = useContext(InvokeContext);
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setInspection(null);
    setError("");
    void invokeCommand<FileInspection>("file_inspect", { token: source.token })
      .then((value) => { if (live) setInspection(value); })
      .catch((reason) => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [invokeCommand, source.token]);

  if (error) return <div className="material-preview-message error">文件暂时不可读：{error}</div>;
  if (!inspection) return <div className="material-preview-message"><Loader2 className="spin" size={16} />读取材料…</div>;
  if (inspection.preview === "text") {
    return <pre className="material-text-preview">{inspection.content || "（空文件）"}</pre>;
  }
  if (inspection.preview === "image") {
    return <img className="material-media-preview" src={streamUrl(source.token)} alt={inspection.name} />;
  }
  if (inspection.preview === "pdf") {
    return <iframe className="material-frame-preview" src={streamUrl(source.token)} title={inspection.name} />;
  }
  if (inspection.preview === "audio") {
    return <audio className="material-audio-preview" src={streamUrl(source.token)} controls />;
  }
  if (inspection.preview === "video") {
    return <video className="material-media-preview" src={streamUrl(source.token)} controls />;
  }
  if (inspection.preview === "directory") {
    return (
      <div className="material-directory-preview">
        {(inspection.items || []).slice(0, 80).map((item) => (
          <div key={item.path}><span>{item.kind === "folder" ? "▸" : "·"}</span>{item.name}</div>
        ))}
        {inspection.truncated && <small>目录较大，仅显示前一部分</small>}
      </div>
    );
  }
  return <div className="material-preview-message">{inspection.mime || "文件"}<br />{inspection.path}</div>;
}

function LegacyPreview({ source }: { source: Extract<MaterialSource, { kind: "legacy-note" }> }) {
  const invokeCommand = useContext(InvokeContext);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void invokeCommand<{ content?: string }>("notes_legacy_get", { id: source.id })
      .then((value) => { if (live) setContent(value.content || "（旧札记没有可展示的 Markdown）"); })
      .catch((reason) => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [invokeCommand, source.id]);
  if (error) return <div className="material-preview-message error">旧札记读取失败：{error}</div>;
  if (content === null) return <div className="material-preview-message"><Loader2 className="spin" size={16} />读取旧札记…</div>;
  return <pre className="material-text-preview legacy">{content}</pre>;
}

function LinkPreview({ source, adapter }: {
  source: Extract<MaterialSource, { kind: "link" }>;
  adapter: MaterialAdapter;
}) {
  if (adapter === "image") return <img className="material-media-preview" src={source.url} alt="链接图片" />;
  if (adapter === "pdf" || adapter === "web") {
    return <iframe className="material-frame-preview" src={source.url} title={source.url} />;
  }
  if (adapter === "audio") return <audio className="material-audio-preview" src={source.url} controls />;
  if (adapter === "video") return <video className="material-media-preview" src={source.url} controls />;
  let host = source.url;
  try { host = new URL(source.url).host; } catch { /* keep raw */ }
  return (
    <button className="material-link-preview" type="button" onClick={() => window.open(source.url, "_blank", "noopener") }>
      <Link2 size={24} />
      <strong>{host}</strong>
      <span>{source.url}</span>
      <small>在新窗口打开 <ArrowUpRight size={12} /></small>
    </button>
  );
}

function MaterialBody({ data }: { data: CardData }) {
  if (data.frozen && data.source?.kind === "file") return <FrozenPreview source={data.source} />;
  if (!data.source) return <div className="material-preview-message">材料引用缺失</div>;
  if (data.source.kind === "file") return <FilePreview source={data.source} />;
  if (data.source.kind === "legacy-note") return <LegacyPreview source={data.source} />;
  return <LinkPreview source={data.source} adapter={data.adapter} />;
}

/** 冻结快照: sandbox 空值=禁脚本禁表单, 渲染烘焙出的单文件静态 HTML(双保险, 烘焙时已剥 script)。 */
function FrozenPreview({ source }: { source: Extract<MaterialSource, { kind: "file" }> }) {
  return <iframe className="material-frame-preview" sandbox="" src={streamUrl(source.token)} title="冻结快照" />;
}

function EditableText({ id, data, actions }: { id: string; data: CardData; actions: CardActions }) {
  const invokeCommand = useContext(InvokeContext);
  const editableId = data.source?.kind === "file" ? data.source.editableId : undefined;
  const [loading, setLoading] = useState(Boolean(editableId && data.text === undefined));
  const [error, setError] = useState("");
  useEffect(() => {
    if (!editableId || data.text !== undefined) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError("");
    void invokeCommand<TextMaterialPayload>("notes_text_get", { id: editableId })
      .then((material) => { if (live) actions.hydrateText(id, material); })
      .catch((reason) => { if (live) setError(String(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [actions, data.text, editableId, id, invokeCommand]);
  if (loading) return <div className="material-preview-message"><Loader2 className="spin" size={16} />读取文字材料…</div>;
  if (error) return <div className="material-preview-message error">文字材料读取失败：{error}</div>;
  return (
    <textarea
      value={data.text || ""}
      placeholder="写点什么……有内容后才保存"
      spellCheck
      onFocus={actions.beginTextEdit}
      onBlur={() => actions.finishTextEdit(id)}
      onChange={(event) => actions.changeText(id, event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
    />
  );
}

const MaterialCard = memo(function MaterialCard({ id, data, selected }: NodeProps<CanvasNode>) {
  const actions = useContext(CardActionsContext);
  const spotlight = useContext(SpotlightContext);
  const { zoom } = useViewport();
  const [deleteArmed, setDeleteArmed] = useState(false);
  if (!actions) return null;
  const kindLabel = data.kind === "text"
    ? (data.draft ? "未保存" : "文字")
    : data.frozen ? "快照 · 已冻结"
    : data.source?.kind === "legacy-note" ? "旧札记 · 只读" : "材料";
  const openUrl = data.source?.kind === "link"
    ? data.source.url
    : data.source?.kind === "file" && ["image", "pdf", "audio", "video"].includes(data.adapter)
      ? streamUrl(data.source.token)
      : null;
  return (
    <article className={`material-canvas-card${selected ? " selected" : ""}${spotlight === id ? " spotlight" : ""}`}>
      <Handle type="target" position={Position.Left} className="material-card-handle input" />
      <Handle type="source" position={Position.Right} className="material-card-handle output" />
      {selected && RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`material-resize-handle nodrag nopan ${direction}`}
          data-direction={direction}
          style={{ scale: `${1 / Math.max(zoom, 0.01)}` }}
          onPointerDown={(event) => actions.beginResize(id, direction, event, zoom)}
          aria-label={`调整卡片尺寸：${direction}`}
        />
      ))}
      <header className="material-card-drag">
        {data.kind === "text" ? <FileText size={14} /> : <Link2 size={14} />}
        <strong title={data.title}>{data.title}</strong>
        <small>{kindLabel}</small>
        {openUrl && (
          <button className="nodrag nopan" type="button" title="打开源材料" onClick={() => window.open(openUrl, "_blank", "noopener") }>
            <ArrowUpRight size={14} />
          </button>
        )}
        {!data.frozen && data.kind === "material" && data.source?.kind === "link" && data.adapter === "web" && (
          <button
            className="nodrag nopan" type="button" disabled={actions.freezingId === id}
            title="冻结成静态快照（剥交互，烘焙成单文件 HTML，原地取代活页）"
            onClick={() => void actions.freezeCard(id).catch((reason) => console.error("[material-canvas] freeze failed", reason))}
          >
            {actions.freezingId === id ? <Loader2 className="spin" size={14} /> : <Snowflake size={14} />}
          </button>
        )}
        {data.frozen && (
          <button
            className="nodrag nopan" type="button"
            title="解冻：按记住的活源在旁边新开一块（本快照保留）"
            onClick={() => actions.unfreezeCard(id)}
          >
            <Sun size={14} />
          </button>
        )}
        <button className="nodrag nopan" type="button" title="全屏查看（Esc 退出）" onClick={() => actions.toggleFullscreen(id)}>
          <Maximize2 size={14} />
        </button>
        <button
          className={`nodrag nopan material-delete${deleteArmed ? " armed" : ""}`}
          type="button"
          title={deleteArmed ? "再次点击确认移除" : "从画布移除"}
          onBlur={() => setDeleteArmed(false)}
          onClick={() => {
            if (deleteArmed) actions.removeCard(id);
            else {
              setDeleteArmed(true);
              window.setTimeout(() => setDeleteArmed(false), 2500);
            }
          }}
        >
          {deleteArmed ? <span>确认</span> : <Trash2 size={14} />}
        </button>
      </header>
      <div className="material-card-body nodrag nopan nowheel">
        {data.kind === "text" ? (
          <EditableText id={id} data={data} actions={actions} />
        ) : <MaterialBody data={data} />}
      </div>
    </article>
  );
});

const nodeTypes = { materialCard: MaterialCard };

function CanvasDialog({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="material-dialog-backdrop" role="presentation" onPointerDown={onClose}>
      <section className="material-dialog" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>{title}</strong><button type="button" onClick={onClose}><X size={17} /></button></header>
        {children}
      </section>
    </div>
  );
}

export function MaterialNotesWorkspace({
  sessionId,
  sessionTitle,
  onReady,
  onError,
  invokeCommand = tauriInvoke,
}: MaterialNotesWorkspaceProps = {}) {
  const session = useMemo(
    () => sessionId
      ? { id: `external:${sessionId}`, label: sessionTitle || "会话札记" }
      : sessionIdentity(),
    [sessionId, sessionTitle],
  );
  const storageId = useMemo(() => canvasStorageId(session.id), [session.id]);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const flowRef = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null);
  const past = useRef<CanvasSnapshot[]>([]);
  const future = useRef<CanvasSnapshot[]>([]);
  const dragSnapshot = useRef<CanvasSnapshot | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveRevision = useRef(0);
  const textWriteTimers = useRef(new Map<string, number>());
  const textWriteRevisions = useRef(new Map<string, number>());
  const [historyRevision, setHistoryRevision] = useState(0);
  const [booting, setBooting] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<"empty" | "dirty" | "saving" | "saved" | "error">("empty");
  const [dialog, setDialog] = useState<"material" | "legacy" | null>(null);
  const [materialInput, setMaterialInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hits, setHits] = useState<FileHit[]>([]);
  const [legacyNotes, setLegacyNotes] = useState<LegacyNote[]>([]);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [freezingId, setFreezingId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightRef = useRef<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  // 卡片被移除时退出其全屏; Esc 随时退出
  useEffect(() => {
    if (fullscreenId && !nodes.some((node) => node.id === fullscreenId)) setFullscreenId(null);
  }, [fullscreenId, nodes]);
  useEffect(() => {
    if (!fullscreenId) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreenId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenId]);

  const refreshHistory = () => setHistoryRevision((value) => value + 1);
  const pushHistory = useCallback((value = snapshotOf(nodesRef.current, edgesRef.current)) => {
    past.current.push(value);
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    refreshHistory();
  }, []);

  const writeDocument = useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const revision = ++saveRevision.current;
    const document = persistedDocument(session.id, nextNodes, nextEdges);
    setSaveState(document.cards.length ? "dirty" : "empty");
    saveTimer.current = window.setTimeout(() => {
      setSaveState("saving");
      const operation = document.cards.length
        ? invokeCommand("notes_canvas_put", { id: storageId, json: JSON.stringify(document) })
        : invokeCommand("notes_canvas_del", { id: storageId });
      void operation
        .then(() => { if (saveRevision.current === revision) setSaveState(document.cards.length ? "saved" : "empty"); })
        .catch((reason) => {
          console.error("[material-canvas] save failed", reason);
          if (saveRevision.current === revision) setSaveState("error");
        });
    }, 180);
  }, [invokeCommand, session.id, storageId]);

  const writeTextMaterial = useCallback((id: string, content: string) => {
    const existing = textWriteTimers.current.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    const revision = (textWriteRevisions.current.get(id) || 0) + 1;
    textWriteRevisions.current.set(id, revision);
    setSaveState("dirty");
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      void invokeCommand<TextMaterialPayload>("notes_text_put", { id, content })
        .then((material) => {
          if (textWriteRevisions.current.get(id) !== revision) return;
          const source: MaterialSource = {
            kind: "file",
            path: material.path,
            token: material.open_token,
            mime: material.mime,
            editableId: material.editableId,
          };
          const next = nodesRef.current.map((node) => node.id === id ? {
            ...node,
            data: { ...node.data, source, draft: false },
          } : node);
          nodesRef.current = next;
          setNodes(next);
          writeDocument(next, edgesRef.current);
        })
        .catch((reason) => {
          console.error("[material-canvas] text save failed", reason);
          if (textWriteRevisions.current.get(id) === revision) setSaveState("error");
        });
    }, 180);
    textWriteTimers.current.set(id, timer);
  }, [invokeCommand, writeDocument]);

  useEffect(() => {
    let live = true;
    setBooting(true);
    setLoadError("");
    void invokeCommand<string | null>("notes_canvas_get", { id: storageId })
      .then((raw) => {
        if (!live) return;
        const document = parseCanvasDocument(raw, session.id);
        if (!document || !document.cards.length) {
          const draft = draftNode();
          nodesRef.current = [draft];
          setNodes([draft]);
          setEdges([]);
          setSaveState("empty");
        } else {
          const loadedNodes = document.cards.map((card) => nodeFromCard(card));
          const loadedEdges = document.relations.map((relation) => ({
            id: relation.id,
            source: relation.source,
            target: relation.target,
            label: relation.label,
          }));
          nodesRef.current = loadedNodes;
          edgesRef.current = loadedEdges;
          setNodes(loadedNodes);
          setEdges(loadedEdges);
          setSaveState("saved");
        }
        setBooting(false);
      })
      .catch((reason) => {
        if (!live) return;
        setLoadError(String(reason));
        setBooting(false);
      });
    return () => { live = false; };
  }, [invokeCommand, session.id, storageId]);

  useEffect(() => {
    if (booting) return;
    const message = loadError
      ? { type: "omni-notes-error", sessionId: session.id, error: loadError }
      : { type: "omni-notes-ready", sessionId: session.id };
    if (loadError) onError?.(loadError);
    else onReady?.();
    if (window.parent !== window) {
      const targetOrigin = new URL(document.baseURI).origin;
      window.parent.postMessage(message, targetOrigin);
    }
  }, [booting, loadError, onError, onReady, session.id]);

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    for (const timer of textWriteTimers.current.values()) window.clearTimeout(timer);
  }, []);

  const setGraph = useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[], persist = true) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    if (persist) writeDocument(nextNodes, nextEdges);
  }, [writeDocument]);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(snapshotOf(nodesRef.current, edgesRef.current));
    for (const node of previous.nodes) {
      if (node.data.kind === "text" && node.data.source?.kind === "file" && node.data.source.editableId && typeof node.data.text === "string") {
        writeTextMaterial(node.data.source.editableId, node.data.text);
      }
    }
    setGraph(cloneNodes(previous.nodes), previous.edges.map((edge) => ({ ...edge })));
    refreshHistory();
  }, [setGraph, writeTextMaterial]);

  const redo = useCallback(() => {
    const following = future.current.pop();
    if (!following) return;
    past.current.push(snapshotOf(nodesRef.current, edgesRef.current));
    for (const node of following.nodes) {
      if (node.data.kind === "text" && node.data.source?.kind === "file" && node.data.source.editableId && typeof node.data.text === "string") {
        writeTextMaterial(node.data.source.editableId, node.data.text);
      }
    }
    setGraph(cloneNodes(following.nodes), following.edges.map((edge) => ({ ...edge })));
    refreshHistory();
  }, [setGraph, writeTextMaterial]);

  const addCard = useCallback((card: Omit<CanvasCardRecord, "x" | "y">) => {
    pushHistory();
    const count = nodesRef.current.length;
    const next = [...nodesRef.current, nodeFromCard({
      ...card,
      x: 80 + (count % 3) * 580,
      y: 72 + Math.floor(count / 3) * 460,
    })];
    setGraph(next, edgesRef.current);
    setDialog(null);
  }, [pushHistory, setGraph]);

  const addText = useCallback(() => {
    const currentDraft = nodesRef.current.find((node) => node.data.kind === "text" && node.data.draft);
    if (currentDraft) {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === currentDraft.id })));
      return;
    }
    pushHistory();
    const count = nodesRef.current.length;
    const next = [...nodesRef.current, draftNode(80 + (count % 3) * 580, 72 + Math.floor(count / 3) * 460)];
    setGraph(next, edgesRef.current, false);
  }, [pushHistory, setGraph]);

  const addLink = useCallback((url: string) => {
    let title = url;
    try { title = new URL(url).hostname || url; } catch { /* keep URL */ }
    addCard({
      id: safeRandomId("material-"),
      kind: "material",
      title,
      source: { kind: "link", url },
      adapter: adapterForLink(url),
      width: adapterForLink(url) === "link" ? 420 : 560,
      height: adapterForLink(url) === "link" ? 250 : 420,
    });
  }, [addCard]);

  const addFile = useCallback((hit: FileHit) => {
    addCard({
      id: safeRandomId("material-"),
      kind: "material",
      title: hit.name,
      source: { kind: "file", path: hit.path, token: hit.open_token, mime: hit.mime },
      adapter: "auto",
      width: 520,
      height: 400,
    });
  }, [addCard]);

  const addLegacy = useCallback((note: LegacyNote) => {
    addCard({
      id: safeRandomId("legacy-"),
      kind: "material",
      title: note.title,
      source: { kind: "legacy-note", id: note.id },
      adapter: "legacy-note",
      width: 520,
      height: 420,
    });
  }, [addCard]);

  const submitMaterial = useCallback(() => {
    const link = normalizeLink(materialInput);
    if (link) {
      addLink(link);
      setMaterialInput("");
      setHits([]);
      return;
    }
    const query = materialInput.trim();
    if (!query) return;
    setSearching(true);
    setSearchError("");
    void invokeCommand<FileHit[]>("search", { query, limit: 40 })
      .then((result) => {
        setHits(result);
        if (!result.length) setSearchError("没有找到文件；可换文件名、路径片段或关键词。");
      })
      .catch((reason) => setSearchError(String(reason)))
      .finally(() => setSearching(false));
  }, [addLink, invokeCommand, materialInput]);

  const openLegacy = useCallback(() => {
    setDialog("legacy");
    if (legacyNotes.length || legacyLoading) return;
    setLegacyLoading(true);
    void invokeCommand<LegacyNote[]>("notes_legacy_list")
      .then(setLegacyNotes)
      .catch((reason) => setSearchError(String(reason)))
      .finally(() => setLegacyLoading(false));
  }, [invokeCommand, legacyLoading, legacyNotes.length]);

  const cardActions = useMemo<CardActions>(() => ({
    beginTextEdit: () => pushHistory(),
    finishTextEdit: (id) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (node && ((node.data.text || "").trim() || node.data.source?.kind === "file")) {
        writeTextMaterial(node.data.source?.kind === "file" && node.data.source.editableId
          ? node.data.source.editableId
          : id, node.data.text || "");
      }
    },
    hydrateText: (id, material) => {
      const source: MaterialSource = {
        kind: "file",
        path: material.path,
        token: material.open_token,
        mime: material.mime,
        editableId: material.editableId,
      };
      const next = nodesRef.current.map((node) => node.id === id ? {
        ...node,
        data: { ...node.data, text: material.content || "", source, draft: false },
      } : node);
      nodesRef.current = next;
      setNodes(next);
      writeDocument(next, edgesRef.current);
    },
    changeText: (id, value) => {
      const current = nodesRef.current.find((node) => node.id === id);
      const editableId = current?.data.source?.kind === "file" && current.data.source.editableId
        ? current.data.source.editableId
        : id;
      const next = nodesRef.current.map((node) => {
        if (node.id !== id) return node;
        const firstLine = value.trim().split(/\r?\n/, 1)[0]?.slice(0, 60);
        return {
          ...node,
          data: {
            ...node.data,
            text: value,
            title: firstLine || "随手记",
            draft: !value.trim() && !node.data.source,
          },
        };
      });
      nodesRef.current = next;
      setNodes(next);
      if (value.trim() || current?.data.source) writeTextMaterial(editableId, value);
      else writeDocument(next, edgesRef.current);
    },
    removeCard: (id) => {
      pushHistory();
      const nextNodes = nodesRef.current.filter((node) => node.id !== id);
      const nextEdges = edgesRef.current.filter((edge) => edge.source !== id && edge.target !== id);
      setGraph(nextNodes.length ? nextNodes : [draftNode()], nextEdges);
    },
    toggleFullscreen: (id) => setFullscreenId((current) => (current === id ? null : id)),
    freezeCard: async (id) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) throw new Error(`没找到卡片 ${id}`);
      if (node.data.frozen) throw new Error("已是冻结快照卡");
      const source = node.data.source;
      if (node.data.kind !== "material" || source?.kind !== "link" || node.data.adapter !== "web") {
        throw new Error("只有 web 页面链接卡能冻结");
      }
      setFreezingId(id);
      try {
        // 捕获是秒级慢操作且只有 HTTP 桥有实现(桌面 Rust 侧无此命令), 直连 webNotesInvoke 给足 60s
        const payload = await webNotesInvoke<FileHit & { snapshotId: string; stats: Record<string, number> }>(
          "notes_snapshot_capture", { id, url: source.url }, 60_000);
        pushHistory();
        const frozen = { capturedAt: new Date().toISOString(), from: source, fromAdapter: node.data.adapter };
        const next = nodesRef.current.map((item) => item.id !== id ? item : {
          ...item,
          data: {
            ...item.data,
            frozen,
            source: { kind: "file" as const, path: payload.path, token: payload.open_token, mime: payload.mime },
          },
        });
        setGraph(next, edgesRef.current);
        return payload.stats;
      } finally {
        setFreezingId(null);
      }
    },
    unfreezeCard: (id) => {
      const node = nodesRef.current.find((item) => item.id === id);
      const frozen = node?.data.frozen;
      if (!node || !frozen) throw new Error("不是冻结快照卡");
      pushHistory();
      const size = dimensionsOf(node);
      const live = nodeFromCard({
        id: safeRandomId("material-"),
        kind: "material",
        title: node.data.title,
        source: frozen.from,
        adapter: frozen.fromAdapter,
        x: node.position.x + size.width + 60,
        y: node.position.y,
        width: size.width,
        height: size.height,
      });
      setGraph([...nodesRef.current, live], edgesRef.current);
      return { created: live.id };
    },
    freezingId,
    beginResize: (id, direction, event, zoom) => {
      event.preventDefault();
      event.stopPropagation();
      pushHistory();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const startNode = nodesRef.current.find((node) => node.id === id);
      if (!startNode) return;
      const startSize = dimensionsOf(startNode);
      const start = { x: startNode.position.x, y: startNode.position.y, ...startSize };
      target.setPointerCapture(pointerId);
      const move = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        const dx = (pointer.clientX - startX) / Math.max(zoom, 0.01);
        const dy = (pointer.clientY - startY) / Math.max(zoom, 0.01);
        const fromLeft = direction.includes("left");
        const fromRight = direction.includes("right");
        const fromTop = direction.includes("top");
        const fromBottom = direction.includes("bottom");
        const width = fromLeft ? Math.max(260, start.width - dx) : fromRight ? Math.max(260, start.width + dx) : start.width;
        const height = fromTop ? Math.max(180, start.height - dy) : fromBottom ? Math.max(180, start.height + dy) : start.height;
        const next = nodesRef.current.map((node) => node.id === id ? {
          ...node,
          position: {
            x: fromLeft ? start.x + start.width - width : start.x,
            y: fromTop ? start.y + start.height - height : start.y,
          },
          style: { ...node.style, width, height },
        } : node);
        nodesRef.current = next;
        setNodes(next);
      };
      const finish = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
        writeDocument(nodesRef.current, edgesRef.current);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    },
  }), [pushHistory, setGraph, writeDocument, writeTextMaterial, freezingId]);

  // omni canvas 活画布 ops(cb 文件队列桥, 见 canvasOps.ts): state/update/remove/viewport/focus/highlight
  useEffect(() => {
    const applyHighlight = (id: string | null, seconds = 6) => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
      }
      highlightRef.current = id;
      setHighlightId(id);
      if (id && seconds > 0) {
        highlightTimer.current = window.setTimeout(() => {
          highlightRef.current = null;
          setHighlightId(null);
          highlightTimer.current = null;
        }, seconds * 1000);
      }
    };
    return registerCanvasHandler(storageId, {
      state: () => ({
        canvas: storageId,
        viewport: flowRef.current ? flowRef.current.getViewport() : null,
        cards: nodesRef.current.length,
        selected: nodesRef.current.filter((node) => node.selected).map((node) => node.id),
        highlighted: highlightRef.current,
      }),
      update: (args: CanvasOpArgs) => {
        const id = String(args.card || "");
        if (!nodesRef.current.some((item) => item.id === id)) throw new Error(`没找到卡片 ${id}`);
        pushHistory();
        const next = nodesRef.current.map((item) => item.id !== id ? item : {
          ...item,
          position: {
            x: typeof args.x === "number" ? args.x : item.position.x,
            y: typeof args.y === "number" ? args.y : item.position.y,
          },
          style: {
            ...item.style,
            width: typeof args.width === "number" ? Math.max(260, args.width) : item.style?.width,
            height: typeof args.height === "number" ? Math.max(180, args.height) : item.style?.height,
          },
          data: {
            ...item.data,
            title: typeof args.title === "string" && args.title.trim() ? args.title : item.data.title,
            adapter: typeof args.adapter === "string" ? (args.adapter as MaterialAdapter) : item.data.adapter,
          },
        });
        setGraph(next, edgesRef.current);
        return { updated: id };
      },
      remove: (args: CanvasOpArgs) => {
        const id = String(args.card || "");
        if (!nodesRef.current.some((item) => item.id === id)) throw new Error(`没找到卡片 ${id}`);
        cardActions.removeCard(id);
        return { removed: id };
      },
      viewport: (args: CanvasOpArgs) => {
        const flow = flowRef.current;
        if (!flow) throw new Error("画布视图未就绪");
        const current = flow.getViewport();
        const next = {
          x: typeof args.x === "number" ? args.x : current.x,
          y: typeof args.y === "number" ? args.y : current.y,
          zoom: typeof args.zoom === "number" ? args.zoom : current.zoom,
        };
        void flow.setViewport(next, { duration: 200 });
        return { viewport: next };
      },
      focus: (args: CanvasOpArgs) => {
        const id = String(args.card || "");
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node) throw new Error(`没找到卡片 ${id}`);
        const flow = flowRef.current;
        if (!flow) throw new Error("画布视图未就绪");
        const size = dimensionsOf(node);
        const zoom = typeof args.zoom === "number" ? args.zoom : flow.getViewport().zoom;
        void flow.setCenter(node.position.x + size.width / 2, node.position.y + size.height / 2, { zoom, duration: 300 });
        return { focused: id, zoom };
      },
      highlight: (args: CanvasOpArgs) => {
        if (args.clear) {
          applyHighlight(null);
          return { cleared: true };
        }
        const id = String(args.card || "");
        if (!nodesRef.current.some((item) => item.id === id)) throw new Error(`没找到卡片 ${id}`);
        const seconds = typeof args.seconds === "number" ? args.seconds : 6;
        applyHighlight(id, seconds);
        return { highlighted: id, seconds };
      },
      freeze: async (args: CanvasOpArgs) => {
        const id = String(args.card || "");
        const stats = await cardActions.freezeCard(id);
        return { frozen: id, stats };
      },
      unfreeze: (args: CanvasOpArgs) => ({ unfrozen: String(args.card || ""), ...cardActions.unfreezeCard(String(args.card || "")) }),
    });
  }, [storageId, cardActions, pushHistory, setGraph]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    const next = applyEdgeChanges(changes, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (edgesRef.current.some((edge) => edge.source === connection.source && edge.target === connection.target)) return;
    pushHistory();
    const next = addEdge({ ...connection, id: safeRandomId("relation-") }, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
    writeDocument(nodesRef.current, next);
  }, [pushHistory, writeDocument]);

  const deleteSelectedRelations = useCallback(() => {
    if (!edgesRef.current.some((edge) => edge.selected)) return;
    pushHistory();
    const next = edgesRef.current.filter((edge) => !edge.selected);
    edgesRef.current = next;
    setEdges(next);
    writeDocument(nodesRef.current, next);
  }, [pushHistory, writeDocument]);

  const saveLabel = saveState === "empty" ? "空白 · 未保存"
    : saveState === "dirty" ? "待保存"
      : saveState === "saving" ? "保存中…"
        : saveState === "saved" ? "已保存"
          : "保存失败";
  const hasSelectedRelation = edges.some((edge) => edge.selected);
  const fullscreenNode = fullscreenId ? nodes.find((node) => node.id === fullscreenId) : undefined;
  void historyRevision;

  if (booting) {
    return <div className="material-canvas-boot" data-material-canvas="loading"><Loader2 className="spin" />正在打开札记…</div>;
  }
  if (loadError) {
    return (
      <div className="material-canvas-boot error" data-material-canvas="error">
        <strong>札记存储暂时不可用</strong><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}><RotateCcw size={15} />重试</button>
      </div>
    );
  }

  return (
    <InvokeContext.Provider value={invokeCommand}>
      <CardActionsContext.Provider value={cardActions}>
        <SpotlightContext.Provider value={highlightId}>
        <main className="material-notes-workspace" data-material-canvas="ready">
        <header className="material-canvas-toolbar">
          <div className="material-canvas-title"><strong>{session.label}</strong><small>{saveLabel}</small></div>
          <div className="material-toolbar-actions">
            <button type="button" onClick={addText}><FilePlus2 size={15} />文字</button>
            <button type="button" className="primary" onClick={() => { setDialog("material"); setSearchError(""); }}><Link2 size={15} />材料</button>
            <button type="button" onClick={openLegacy}>旧札记</button>
            <span className="material-toolbar-divider" />
            <button type="button" title="撤销" disabled={!past.current.length} onClick={undo}><Undo2 size={15} /></button>
            <button type="button" title="重做" disabled={!future.current.length} onClick={redo}><Redo2 size={15} /></button>
            {hasSelectedRelation && <button type="button" title="移除选中关系" onClick={deleteSelectedRelations}><Trash2 size={15} />关系</button>}
          </div>
        </header>
        <section className="material-canvas-stage">
          <ReactFlow<CanvasNode, CanvasEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => { flowRef.current = instance; }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={() => { dragSnapshot.current = snapshotOf(nodesRef.current, edgesRef.current); }}
            onNodeDragStop={() => {
              if (dragSnapshot.current) pushHistory(dragSnapshot.current);
              dragSnapshot.current = null;
              writeDocument(nodesRef.current, edgesRef.current);
            }}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
            minZoom={0.15}
            maxZoom={2.2}
            panOnScroll
            selectionOnDrag={false}
            deleteKeyCode={null}
            nodesConnectable
            nodesDraggable
            edgesFocusable
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>

        {fullscreenNode && (
          <div className="material-fullscreen-layer" data-testid="material-fullscreen">
            <header className="material-fullscreen-bar">
              {fullscreenNode.data.kind === "text" ? <FileText size={15} /> : <Link2 size={15} />}
              <strong title={fullscreenNode.data.title}>{fullscreenNode.data.title}</strong>
              <small>
                {fullscreenNode.data.kind === "text"
                  ? "文字"
                  : fullscreenNode.data.source?.kind === "legacy-note" ? "旧札记 · 只读" : "材料"}
              </small>
              <button type="button" title="退出全屏（Esc）" onClick={() => setFullscreenId(null)}>
                <Minimize2 size={15} />退出全屏
              </button>
            </header>
            <div className="material-fullscreen-body">
              {fullscreenNode.data.kind === "text"
                ? <EditableText id={fullscreenNode.id} data={fullscreenNode.data} actions={cardActions} />
                : <MaterialBody data={fullscreenNode.data} />}
            </div>
          </div>
        )}

        {dialog === "material" && (
          <CanvasDialog title="加入材料" onClose={() => setDialog(null)}>
            <p className="material-dialog-hint">粘贴链接会直接建立引用；输入文件名或路径片段会搜索本机材料。正文仍留在原文件或链接中。</p>
            <form className="material-search-form" onSubmit={(event) => { event.preventDefault(); submitMaterial(); }}>
              <input autoFocus value={materialInput} onChange={(event) => setMaterialInput(event.target.value)} placeholder="https://… 或 README.md / 文件路径" />
              <button type="submit" disabled={searching || !materialInput.trim()}>{searching ? <Loader2 className="spin" size={16} /> : <Search size={16} />}加入 / 搜索</button>
            </form>
            {searchError && <div className="material-dialog-error">{searchError}</div>}
            <div className="material-picker-list">
              {hits.map((hit) => (
                <button key={`${hit.path}:${hit.open_token}`} type="button" onClick={() => addFile(hit)}>
                  <FileText size={16} /><span><strong>{hit.name}</strong><small>{hit.path}</small></span>
                </button>
              ))}
            </div>
          </CanvasDialog>
        )}

        {dialog === "legacy" && (
          <CanvasDialog title="接入旧札记" onClose={() => setDialog(null)}>
            <p className="material-dialog-hint">这里只建立只读引用，不复制旧正文；旧 BlockSuite 数据不会参与新画布启动。</p>
            {legacyLoading && <div className="material-preview-message"><Loader2 className="spin" size={16} />读取旧札记目录…</div>}
            <div className="material-picker-list legacy-list">
              {legacyNotes.map((note) => (
                <button key={note.id} type="button" disabled={!note.hasMarkdown} onClick={() => addLegacy(note)}>
                  <FileText size={16} /><span><strong>{note.title}</strong><small>{note.hasMarkdown ? note.id : "尚无可展示的 Markdown"}</small></span>
                </button>
              ))}
            </div>
          </CanvasDialog>
        )}
        </main>
        </SpotlightContext.Provider>
      </CardActionsContext.Provider>
    </InvokeContext.Provider>
  );
}
