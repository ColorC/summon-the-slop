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
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeToolbar,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  NodeToolbar,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  reconnectEdge,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
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
  Pencil,
  Redo2,
  RotateCcw,
  Search,
  Send,
  Snowflake,
  Sun,
  Copy,
  Group,
  ChevronDown,
  LayoutGrid,
  Menu as MenuIcon,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./material-notes.css";
import {
  applyCanvasMutation,
  adapterForLink,
  canvasPatchIsEmpty,
  canvasStorageId,
  diffCanvasDocuments,
  emptyCanvasDocument,
  formatCanvasCardReference,
  normalizeLink,
  parseCanvasDocument,
  repairDisplayText,
  safeRandomId,
  type CanvasCardRecord,
  type CanvasMutationPatch,
  type CanvasRelationRecord,
  type CardSubmission,
  type MaterialAdapter,
  type MaterialCanvasDocument,
  type MaterialSource,
  type SubmissionState,
} from "./materialCanvasModel";
import { registerCanvasHandler, type CanvasOpArgs } from "./canvasOps";
import { MaterialDocView, type DocCard, type DocRelation } from "./MaterialDocView";
import { notesReviewEnabled, resolveNotesAppearance } from "./notesAppearance";
import { layoutMaterialCanvas } from "./materialCanvasLayout";
import {
  ReviewThumb,
  SubmissionVerdictBar,
  streamUrl,
  type CanvasHead,
  type CanvasMutationResult,
  type ReviewItemData,
} from "./reviewShared";
import { webNotesInvoke } from "../webNotesInvoke";
import { copyPlainText } from "../webRuntimeCompat";
import { renderMarkdownSafe } from "../lib/sanitizeHtml";

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

type CanvasNode = Node<CardData, "materialCard" | "groupCard">;
interface RelationData extends Record<string, unknown> {
  path: "curve" | "straight" | "orthogonal";
  arrow: "closed" | "open" | "none";
  /** M2 文档投影分类: continues 主线 / references 旁证 / derived 派生; 缺省未定 */
  kind?: "continues" | "references" | "derived";
}
type CanvasEdge = Edge<RelationData, "materialRelation">;

interface CanvasSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 视口(平移/缩放也可撤回); 老快照没有此字段 → restore 时跳过 */
  viewport?: { x: number; y: number; zoom: number };
}

// CanvasHead / CanvasMutationResult / streamUrl / ReviewItemData / ReviewThumb /
// SubmissionVerdictBar 已抽到 ./reviewShared(2026-08-14, dashboard 审阅台同源复用)。

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
  /** 首开聚焦卡(M1b 深链/M4 内嵌宿主跳转); 缺省读 URL ?focus= 参数 */
  focusCardId?: string;
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
  activateCard: (id: string) => void;
  changeText: (id: string, value: string) => void;
  hydrateText: (id: string, material: TextMaterialPayload) => void;
  beginTextEdit: () => void;
  finishTextEdit: (id: string) => void;
  setTextSize: (id: string, fontSize: number) => void;
  removeCard: (id: string) => void;
  toggleFullscreen: (id: string) => void;
  /** 触屏长按等价右键: 在 (x, y) 打开该卡菜单。 */
  openMenu: (id: string, x: number, y: number) => void;
  freezeCard: (id: string) => Promise<unknown>;
  unfreezeCard: (id: string) => { created: string };
  copyCardRef: (id: string) => Promise<string>;
  renameGroup: (id: string, title: string) => void;
  finishGroupRename: (id: string) => void;
  resizeGroup: (id: string, params: { x: number; y: number; width: number; height: number } | null, phase: "start" | "move" | "end") => void;
  submitForReview: (id: string) => void;
  verdictCard: (id: string, pass: boolean, reason?: string) => void;
  reviewEnabled: boolean;
  editGroupBody: (id: string) => void;
  freezingId: string | null;
  beginResize: (
    id: string,
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLDivElement>,
    zoom: number
  ) => void;
}

interface RelationActions {
  update: (id: string, patch: { label?: string; path?: RelationData["path"]; arrow?: RelationData["arrow"]; kind?: RelationData["kind"] | null }) => void;
  select: (id: string) => void;
  finish: (id: string) => void;
  editingId: string | null;
}

interface CardHoverState {
  id: string | null;
  hold: (id: string, active: boolean) => void;
}

const CardActionsContext = createContext<CardActions | null>(null);
const RelationActionsContext = createContext<RelationActions | null>(null);
// omni canvas highlight op 的聚光灯卡 id(不进 node data, 避免渗进持久化文档)
const SpotlightContext = createContext<string | null>(null);
const HoveredCardContext = createContext<CardHoverState | null>(null);
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

function snapshotOf(nodes: CanvasNode[], edges: CanvasEdge[], viewport?: { x: number; y: number; zoom: number }): CanvasSnapshot {
  return {
    nodes: cloneNodes(nodes),
    edges: edges.map((edge) => ({ ...edge, selected: false })),
    ...(viewport ? { viewport: { ...viewport } } : {}),
  };
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
    type: card.kind === "group" ? "groupCard" : "materialCard",
    position: { x: card.x, y: card.y },
    // 子卡: store 里 x/y 已是相对组卡的坐标, 直接进 position; extent=parent 钳在组内
    ...(card.parentId ? { parentId: card.parentId, extent: "parent" as const } : {}),
    style: { width: card.width, height: card.height },
    data: { ...card, draft },
  };
}

function edgeFromRelation(relation: CanvasRelationRecord): CanvasEdge {
  const arrow = relation.arrow || "closed";
  return {
    id: relation.id,
    type: "materialRelation",
    source: relation.source,
    target: relation.target,
    sourceHandle: relation.sourceHandle,
    targetHandle: relation.targetHandle,
    label: relation.label,
    data: { path: relation.path || "curve", arrow, kind: relation.kind },
    markerEnd: relationMarker(arrow),
  };
}

// React Flow 要求父节点在数组里先于子节点(载入与新建组后都要满足)。
// M2: 真正的多层拓扑——祖父先于父先于子; parentId 悬空/成环的节点按 0 层处理不死循环。
function parentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthCache = new Map<string, number>();
  const depthOf = (node: CanvasNode): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    depthCache.set(node.id, 0); // 占位防环
    let depth = 0;
    let current = node;
    const visited = new Set<string>([node.id]);
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      depth += 1;
      current = parent;
    }
    depthCache.set(node.id, depth);
    return depth;
  };
  return [...nodes].sort((a, b) => depthOf(a) - depthOf(b)); // 稳定排序, 同层保持原相对序
}

// 严重退化判定: >80% 节点 x 相同(全默认位/未排布) → 加载后自动排一次
function isDegenerateLayout(nodes: CanvasNode[]): boolean {
  if (nodes.length < 4) return false;
  const byX = new Map<number, number>();
  for (const node of nodes) byX.set(node.position.x, (byX.get(node.position.x) ?? 0) + 1);
  const maxSame = Math.max(...byX.values());
  return maxSame / nodes.length > 0.8;
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
  edges: CanvasEdge[],
  title?: string
): MaterialCanvasDocument {
  // 组卡(kind=group)无 source 也要持久化; draft 与无 source 的文字卡不落盘
  const persistedNodes = parentsFirst(nodes.filter((node) =>
    !node.data.draft && (node.data.kind === "material" || node.data.kind === "group" || Boolean(node.data.source))
  ));
  const ids = new Set(persistedNodes.map((node) => node.id));
  return {
    version: 1,
    sessionId,
    ...(title && title.trim() ? { title: title.trim() } : {}),
    revision: 0,
    updatedAt: new Date().toISOString(),
    cards: persistedNodes.map((node) => {
      const size = dimensionsOf(node);
      const { draft: _draft, text: _text, parentId: _staleParent, ...data } = node.data;
      return {
        ...data,
        // 父子关系以 React Flow 节点上的 parentId 为准(组内坐标本来就是相对的)
        parentId: node.parentId,
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
        sourceHandle: edge.sourceHandle || undefined,
        targetHandle: edge.targetHandle || undefined,
        path: edge.data?.path || "curve",
        arrow: edge.data?.arrow || "closed",
        kind: edge.data?.kind || undefined,
      })),
  };
}

// ---- 图片清晰度换档: 单调棘轮, 只升不降 ----
// 显示永远 = 已加载完成的最清晰档; zoom 停稳后目标档更高才后台预加载+decode 后覆盖;
// 目标档更低时什么都不做(高清版继续显示, 浏览器自行缩小渲染, 绝不切回糊档/绝不发低清请求)。
// tier 序号: 0=基准 480 档(source.token), 1=1200 档(tiers[0]), 2=原图档(tiers[1])
const TIER_UP_MID = 0.65;   // 480 → 1200 升档线
const TIER_UP_RAW = 1.0;    // 1200 → 原图 升档线
const TIER_DEBOUNCE_MS = 350;

function tierSrcAt(source: Extract<MaterialSource, { kind: "file" }>, tier: number): string {
  const tiers = source.tiers ?? [];
  if (tier <= 0 || !tiers.length) return streamUrl(source.token);
  return streamUrl(tiers[Math.min(tier - 1, tiers.length - 1)].token);
}

function maxTierOf(source: Extract<MaterialSource, { kind: "file" }>): number {
  return Math.min(2, (source.tiers ?? []).length);
}

// 只判升档线: zoom 对应的理想档(与当前档无关; 棘轮在调用方取 max)
function tierTargetForZoom(zoom: number, maxTier: number): number {
  return Math.min(zoom >= TIER_UP_RAW ? 2 : zoom >= TIER_UP_MID ? 1 : 0, maxTier);
}

function useTieredImageSrc(source: Extract<MaterialSource, { kind: "file" }>, zoom: number, hd: boolean): string {
  const maxTier = maxTierOf(source);
  // 首帧永远基准档(480): 最小、最快、多半已缓存——绝不在挂载时读 zoom 直接上原图
  // (挂载瞬间 fitView 未跑, zoom 恒为默认值 1 → 会误判 RAW, 73 张卡同时拉 3MB 原图 = 长时间黑屏的根因)
  const [tier, setTier] = useState(0);
  const tierRef = useRef(0); // = 已加载完成的最清晰档(棘轮, 只升不降)
  useEffect(() => {
    // 棘轮: 目标档 = max(已加载档, zoom 理想档); 不更高就什么都不做
    const target = hd ? maxTier : Math.max(tierRef.current, tierTargetForZoom(zoom, maxTier));
    if (target <= tierRef.current) return;
    let dead = false;
    // 全屏立刻预加载(已加载档先铺上, 不黑屏等待); 卡片走防抖, 停稳才判定
    const timer = window.setTimeout(() => {
      const src = tierSrcAt(source, target);
      const probe = new Image();
      probe.onload = () => {
        // onload 只保证下载完; 大图先 decode 再换, 杜绝切换瞬间的解码黑帧
        const done = () => {
          if (dead) return;
          tierRef.current = target;
          setTier(target);
        };
        if (typeof probe.decode === "function") probe.decode().then(done, done);
        else done();
      };
      probe.onerror = () => { /* 加载失败保持当前档 */ };
      probe.src = src;
    }, hd ? 0 : TIER_DEBOUNCE_MS);
    return () => { dead = true; window.clearTimeout(timer); };
  }, [zoom, hd, source, maxTier]);
  return tierSrcAt(source, tier);
}

function FilePreview({ source, zoom = 1, hd = false }: {
  source: Extract<MaterialSource, { kind: "file" }>;
  zoom?: number;
  hd?: boolean;
}) {
  const invokeCommand = useContext(InvokeContext);
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [error, setError] = useState("");
  const imageSrc = useTieredImageSrc(source, zoom, hd);
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
    // 预加载+decode 完成前 src 不变(useTieredImageSrc 保证), 不换 key 不重挂载 → 无白屏无尺寸跳动
    return <img className="material-media-preview" src={imageSrc} alt={inspection.name} decoding="async" />;
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
  // Decode only the visible label.  Navigation keeps the canonical URL byte-for-byte,
  // so a friendlier Chinese path/query can never change where the card opens.
  let displayUrl = repairDisplayText(source.url);
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURI(displayUrl);
      if (decoded === displayUrl) break;
      displayUrl = decoded;
    } catch {
      break;
    }
  }
  if (adapter === "image") return <img className="material-media-preview" src={source.url} alt="链接图片" />;
  if (adapter === "pdf" || adapter === "web") {
    return <iframe className="material-frame-preview" src={source.url} title={displayUrl} />;
  }
  if (adapter === "audio") return <audio className="material-audio-preview" src={source.url} controls />;
  if (adapter === "video") return <video className="material-media-preview" src={source.url} controls />;
  let host = source.url;
  try { host = new URL(source.url).host; } catch { /* keep raw */ }
  return (
    <button className="material-link-preview" type="button" onClick={() => window.open(source.url, "_blank", "noopener") }>
      <Link2 size={24} />
      <strong>{host}</strong>
      <span title={source.url}>{displayUrl}</span>
      <small>在新窗口打开 <ArrowUpRight size={12} /></small>
    </button>
  );
}

function MaterialBody({ data, zoom = 1, hd = false }: { data: CardData; zoom?: number; hd?: boolean }) {
  if (data.frozen && data.source?.kind === "file") return <FrozenPreview source={data.source} frozen={data.frozen} />;
  if (!data.source) return <div className="material-preview-message">材料引用缺失</div>;
  if (data.source.kind === "file") return <FilePreview source={data.source} zoom={zoom} hd={hd} />;
  if (data.source.kind === "legacy-note") return <LegacyPreview source={data.source} />;
  return <LinkPreview source={data.source} adapter={data.adapter} />;
}

/** 冻结快照: 顶部横幅标明"这是死的"(时间+活源), 正文 sandbox 空值=禁脚本禁表单(双保险, 烘焙时已剥 script)。 */
function FrozenPreview({ source, frozen }: {
  source: Extract<MaterialSource, { kind: "file" }>;
  frozen?: CardData["frozen"];
}) {
  const fromUrl = frozen?.from.kind === "link" ? frozen.from.url : "";
  let host = fromUrl;
  try { host = fromUrl ? new URL(fromUrl).host : ""; } catch { /* 保留原始串 */ }
  const when = frozen?.capturedAt ? frozen.capturedAt.replace("T", " ").slice(0, 16) : "";
  return (
    <div className="material-frozen-preview">
      <div className="material-frozen-banner" title={fromUrl ? `活源: ${fromUrl}` : "冻结快照"}>
        <Snowflake size={12} />
        <span>静态快照{when ? ` · ${when}` : ""}{host ? ` · 源 ${host}` : ""}</span>
      </div>
      <iframe className="material-frame-preview" sandbox="" src={streamUrl(source.token)} title="冻结快照" />
    </div>
  );
}

function EditableText({ id, data, actions, zoom = 1 }: { id: string; data: CardData; actions: CardActions; zoom?: number }) {
  const invokeCommand = useContext(InvokeContext);
  const editableId = data.source?.kind === "file" ? data.source.editableId : undefined;
  const [loading, setLoading] = useState(Boolean(editableId && data.text === undefined));
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const fontSize = Math.min(42, (data.fontSize || 14) * Math.max(1, Math.min(3, 0.72 / Math.max(zoom, 0.01))));
  const markdownHtml = useMemo(() => renderMarkdownSafe(data.text || ""), [data.text]);
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
  if (!editing) {
    return (
      <div className="material-markdown-shell">
        <div
          className={`material-markdown-preview${data.text?.trim() ? "" : " empty"}`}
          style={{ fontSize: `${fontSize}px` }}
          onClick={(event) => {
            const anchor = event.target instanceof Element ? event.target.closest("a") : null;
            if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) return;
            event.preventDefault();
            window.open(anchor.href, "_blank", "noopener");
          }}
          dangerouslySetInnerHTML={{ __html: markdownHtml || "<p>写点什么……有内容后才保存</p>" }}
        />
        <button
          className="material-markdown-mode-button"
          type="button"
          title="编辑 Markdown"
          aria-label="编辑 Markdown"
          onClick={() => setEditing(true)}
        >
          <Pencil size={14} /><span>编辑</span>
        </button>
      </div>
    );
  }
  return (
    <div className="material-markdown-shell editing">
      <textarea
        autoFocus
        value={data.text || ""}
        style={{ fontSize: `${fontSize}px` }}
        placeholder="使用 Markdown 写点什么……有内容后才保存"
        spellCheck
        onFocus={actions.beginTextEdit}
        onBlur={() => actions.finishTextEdit(id)}
        onChange={(event) => actions.changeText(id, event.currentTarget.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            actions.finishTextEdit(id);
            setEditing(false);
          } else {
            event.stopPropagation();
          }
        }}
      />
      <button
        className="material-markdown-mode-button done"
        type="button"
        title="完成编辑并预览 Markdown"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          actions.finishTextEdit(id);
          setEditing(false);
        }}
      >
        <FileText size={14} /><span>预览</span>
      </button>
    </div>
  );
}

function relationMarker(arrow: RelationData["arrow"]) {
  if (arrow === "none") return undefined;
  return {
    type: arrow === "open" ? MarkerType.Arrow : MarkerType.ArrowClosed,
    width: 20,
    height: 20,
  };
}

const MaterialRelation = memo(function MaterialRelation(props: EdgeProps<CanvasEdge>) {
  const actions = useContext(RelationActionsContext);
  const { zoom } = useViewport();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(typeof props.label === "string" ? props.label : "");
  useEffect(() => {
    if (!editing) setDraft(typeof props.label === "string" ? props.label : "");
  }, [editing, props.label]);
  const externallyEditing = actions?.editingId === props.id;
  const pathStyle = props.data?.path || "curve";
  const pathResult = pathStyle === "straight"
    ? getStraightPath(props)
    : pathStyle === "orthogonal"
      ? getSmoothStepPath({ ...props, borderRadius: 0 })
      : getBezierPath(props);
  const [edgePath, labelX, labelY] = pathResult;
  const commit = () => {
    setEditing(false);
    actions?.update(props.id, { label: draft.trim() });
    actions?.finish(props.id);
  };
  const labelVisible = Boolean(props.selected || editing || externallyEditing || (draft.trim() && zoom >= 0.28));
  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={24}
      />
      <EdgeToolbar
        edgeId={props.id}
        x={labelX}
        y={labelY}
        isVisible={labelVisible}
        className="material-relation-toolbar nodrag nopan"
      >
        {props.selected || editing || externallyEditing ? (
          <input
            autoFocus={Boolean(editing || externallyEditing)}
            value={draft}
            aria-label="关系文字"
            placeholder="写关系"
            onFocus={() => { setEditing(true); actions?.select(props.id); }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(typeof props.label === "string" ? props.label : "");
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="双击编辑关系文字"
            onClick={() => actions?.select(props.id)}
            onDoubleClick={() => { actions?.select(props.id); setEditing(true); }}
          >
            {draft}
          </button>
        )}
      </EdgeToolbar>
    </>
  );
});

const COMMON_FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];

function FontSizeCombobox({ id, value, actions }: { id: string; value: number; actions: CardActions }) {
  const [draft, setDraft] = useState(String(value));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (nextDraft = draft) => {
    const parsed = Number(nextDraft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const normalized = Math.min(72, Math.max(8, Math.round(parsed)));
    setDraft(String(normalized));
    actions.setTextSize(id, normalized);
  };
  const listId = `material-font-sizes-${id}`;
  return (
    <div
      ref={rootRef}
      className="material-font-size-combobox"
      role="combobox"
      aria-label="字号"
      aria-expanded={open}
      aria-controls={listId}
      title="字号（可输入 8–72，或从列表选择）"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
        commit();
        setOpen(false);
      }}
    >
      <input
        value={draft}
        inputMode="numeric"
        aria-label="字号"
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowDown") setOpen(true);
          if (event.key === "Enter") {
            commit();
            setOpen(false);
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(String(value));
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="material-font-size-toggle"
        aria-label="展开字号列表"
        tabIndex={-1}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div id={listId} className="material-font-size-options" role="listbox">
          {COMMON_FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              role="option"
              aria-selected={size === value}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setDraft(String(size));
                commit(String(size));
                setOpen(false);
              }}
            >
              {size}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


function ReviewPanel({ scope, onScopeChange, items, currentCanvasKey, onOpenCard, onVerdict, fetchText }: {
  scope: "session" | "global";
  onScopeChange: (scope: "session" | "global") => void;
  items: ReviewItemData[];
  currentCanvasKey: string;
  onOpenCard: (item: ReviewItemData) => void;
  onVerdict: (item: ReviewItemData, pass: boolean, reason?: string) => void;
  fetchText: (id: string) => Promise<string>;
}) {
  // 2026-08-14 定稿: 默认本会话未审队列; 「全部会话」小开关切整体列表; 已裁决折叠到底部
  const activeBuckets: [SubmissionState, string][] = [
    ["unreviewed", "未看"],
    ["seen", "已看"],
  ];
  const resolved = items.filter((item) => item.submission.state === "fully-passed" || item.submission.state === "not-fully-passed");
  const renderItem = (item: ReviewItemData) => {
    const external = item.canvasKey !== currentCanvasKey;
    const jumpUrl = `/lofa/overlay/app/?session_id=${encodeURIComponent(item.sessionId)}&focus=${encodeURIComponent(item.cardId)}`;
    return (
      <article key={item.key} className="material-review-item">
        <button type="button" className="material-review-open" onClick={() => onOpenCard(item)} title={external ? "新标签页打开对应画布并聚焦" : "回画布聚焦这张卡"}>
          <ReviewThumb item={item} fetchText={fetchText} />
          <strong>{item.title}</strong>
          <small>
            提审 {item.submission.submittedAt.slice(0, 10)} · {item.submission.submittedBy}
            {scope === "global" ? ` · ${item.sessionLabel}「${item.canvasTitle}」` : ""}
          </small>
          {item.submission.reason ? <small className="reason">{item.submission.reason}</small> : null}
        </button>
        <div className="material-review-item-actions">
          <a
            className="material-review-jump"
            href={jumpUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="跳回来源札记"
            onClick={(event) => event.stopPropagation()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 4h5v5" /><path d="M20 4 10 14" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
            </svg>
            跳回札记
          </a>
          {(item.submission.state === "unreviewed" || item.submission.state === "seen") && (
            <SubmissionVerdictBar submission={item.submission} onVerdict={(pass, reason) => onVerdict(item, pass, reason)} />
          )}
        </div>
      </article>
    );
  };
  return (
    <div>
      <div className="material-review-toolbar">
        <button
          type="button"
          className={`material-review-scope-toggle${scope === "global" ? " active" : ""}`}
          onClick={() => onScopeChange(scope === "session" ? "global" : "session")}
          title={scope === "session" ? "切到整体列表（全部会话的提审卡）" : "切回本会话队列"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.7 2.6 4 5.6 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.6-4-9s1.3-6.4 4-9z" />
          </svg>
          {scope === "session" ? "全部会话" : "本会话"}
        </button>
        <a
          className="material-review-scope-toggle"
          href="/lofa/overlay/app/?review=global"
          target="_blank"
          rel="noopener noreferrer"
          title="新标签页打开全体会话审阅台（深链 ?review=global）"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 4h5v5" /><path d="M20 4 10 14" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
          </svg>
          全体会话审阅台
        </a>
      </div>
      {!items.length && (
        <div className="material-review-empty">
          {scope === "session" ? "这张画布还没有提审卡。悬停卡片工具条或右键菜单 →「提交审阅」。" : "所有画布都没有提审卡。"}
        </div>
      )}
      <div className="material-review-buckets">
        {activeBuckets.map(([state, label]) => {
          const bucketItems = items.filter((item) => item.submission.state === state);
          return (
            <section key={state} className={`material-review-bucket s-${state}`}>
              <header>{label}<small>{bucketItems.length}</small></header>
              {bucketItems.map(renderItem)}
            </section>
          );
        })}
      </div>
      {resolved.length > 0 && (
        <details className="material-review-resolved">
          <summary>已裁决 {resolved.length} 条</summary>
          <div className="material-review-buckets">
            <section className="material-review-bucket">
              {resolved.map(renderItem)}
            </section>
          </div>
        </details>
      )}
    </div>
  );
}

const MaterialCard = memo(function MaterialCard({ id, data, selected }: NodeProps<CanvasNode>) {
  const actions = useContext(CardActionsContext);
  const spotlight = useContext(SpotlightContext);
  const cardHover = useContext(HoveredCardContext);
  const { zoom } = useViewport();
  const [deleteArmed, setDeleteArmed] = useState(false);
  const touchStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const lastTouchTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const ignoreSyntheticDoubleClickUntilRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const touchFiredRef = useRef(0);
  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => clearLongPress, []);
  // 触屏下 click 合成不可靠(工具条按钮单击失灵): pointerup 直接执行, click 若随后补发由守卫去重。
  const fireTool = (event: ReactPointerEvent<HTMLButtonElement>, run: () => void) => {
    if (event.pointerType === "mouse") return;
    touchFiredRef.current = performance.now();
    run();
  };
  const clickTool = (run: () => void) => {
    if (performance.now() - touchFiredRef.current < 400) return;
    run();
  };
  const hovered = cardHover?.id === id;
  useEffect(() => { if (!hovered) setDeleteArmed(false); }, [hovered]);
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
  const isInteractiveTarget = (target: EventTarget | null) => target instanceof Element
    && Boolean(target.closest("button, input, select, a, iframe, audio, video"));
  const onCardPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" || isInteractiveTarget(event.target)) return;
    touchStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    // 触屏长按 600ms = 右键菜单(平板上没有右键; 拖动超过 14px 则取消)
    clearLongPress();
    const startX = event.clientX;
    const startY = event.clientY;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      touchStartRef.current = null;
      actions.openMenu(id, startX, startY);
    }, 600);
  };
  const onCardPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 14) {
      touchStartRef.current = null;
      clearLongPress();
    }
  };
  const onCardPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    clearLongPress();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId || isInteractiveTarget(event.target)) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 14) return;
    const now = performance.now();
    const previous = lastTouchTapRef.current;
    if (previous && now - previous.at <= 440 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 42) {
      lastTouchTapRef.current = null;
      ignoreSyntheticDoubleClickUntilRef.current = now + 800;
      event.preventDefault();
      actions.activateCard(id);
      return;
    }
    lastTouchTapRef.current = { at: now, x: event.clientX, y: event.clientY };
  };
  return (
    <article
      className={`material-canvas-card${selected ? " selected" : ""}${spotlight === id ? " spotlight" : ""}${data.frozen ? " frozen" : ""}${data.submission ? ` submission-${data.submission.state}` : ""}`}
      onPointerDownCapture={onCardPointerDown}
      onPointerMoveCapture={onCardPointerMove}
      onPointerUpCapture={onCardPointerUp}
      onPointerCancelCapture={() => { touchStartRef.current = null; clearLongPress(); }}
      onContextMenuCapture={(event) => {
        if (performance.now() >= ignoreSyntheticDoubleClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        if (isInteractiveTarget(event.target) || performance.now() < ignoreSyntheticDoubleClickUntilRef.current) return;
        actions.activateCard(id);
      }}
    >
      <NodeToolbar
        isVisible={Boolean(selected || hovered)}
        position={Position.Top}
        offset={8}
        className="material-node-toolbar nodrag nopan"
        onMouseEnter={() => cardHover?.hold(id, true)}
        onMouseLeave={() => cardHover?.hold(id, false)}
      >
        <strong title={data.title}>{data.title}</strong>
        {data.kind === "text" && (
          <FontSizeCombobox id={id} value={data.fontSize || 14} actions={actions} />
        )}
        {openUrl && (
          <button
            type="button"
            title="打开源材料"
            onPointerUp={(event) => fireTool(event, () => window.open(openUrl, "_blank", "noopener"))}
            onClick={() => clickTool(() => window.open(openUrl, "_blank", "noopener"))}
          >
            <ArrowUpRight size={15} />
          </button>
        )}
        {!data.frozen && data.kind === "material" && data.source?.kind === "link" && data.adapter === "web" && (
          <button
            type="button" disabled={actions.freezingId === id}
            title="冻结成静态快照"
            onPointerUp={(event) => fireTool(event, () => void actions.freezeCard(id).catch((reason) => console.error("[material-canvas] freeze failed", reason)))}
            onClick={() => clickTool(() => void actions.freezeCard(id).catch((reason) => console.error("[material-canvas] freeze failed", reason)))}
          >
            {actions.freezingId === id ? <Loader2 className="spin" size={15} /> : <Snowflake size={15} />}
          </button>
        )}
        {data.frozen && (
          <button
            type="button"
            title="从活源新建一张卡"
            onPointerUp={(event) => fireTool(event, () => actions.unfreezeCard(id))}
            onClick={() => clickTool(() => actions.unfreezeCard(id))}
          >
            <Sun size={15} />
          </button>
        )}
        <button
          type="button"
          title="全屏查看"
          onPointerUp={(event) => fireTool(event, () => actions.toggleFullscreen(id))}
          onClick={() => clickTool(() => actions.toggleFullscreen(id))}
        >
          <Maximize2 size={15} />
        </button>
        {actions.reviewEnabled && !data.submission && data.kind !== "group" && (
          <button
            type="button"
            title="提交审阅"
            onPointerUp={(event) => fireTool(event, () => actions.submitForReview(id))}
            onClick={() => clickTool(() => actions.submitForReview(id))}
          >
            <Send size={15} />
          </button>
        )}
        <button
          className={`material-delete${deleteArmed ? " armed" : ""}`}
          type="button"
          title={deleteArmed ? "再次点击确认移除" : "从画布移除"}
          onBlur={() => setDeleteArmed(false)}
          onPointerUp={(event) => fireTool(event, () => {
            if (deleteArmed) actions.removeCard(id);
            else {
              setDeleteArmed(true);
              window.setTimeout(() => setDeleteArmed(false), 2500);
            }
          })}
          onClick={() => clickTool(() => {
            if (deleteArmed) actions.removeCard(id);
            else {
              setDeleteArmed(true);
              window.setTimeout(() => setDeleteArmed(false), 2500);
            }
          })}
        >
          {deleteArmed ? <span>确认</span> : <Trash2 size={15} />}
        </button>
      </NodeToolbar>
      <Handle id="left" type="target" position={Position.Left} className="material-card-handle left nodrag nopan" onClick={(event) => event.stopPropagation()} />
      <Handle id="right" type="source" position={Position.Right} className="material-card-handle right nodrag nopan" onClick={(event) => event.stopPropagation()} />
      <Handle id="top" type="source" position={Position.Top} className="material-card-handle top nodrag nopan" onClick={(event) => event.stopPropagation()} />
      <Handle id="bottom" type="target" position={Position.Bottom} className="material-card-handle bottom nodrag nopan" onClick={(event) => event.stopPropagation()} />
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
        {data.submission && (
          <small className={`submission-badge s-${data.submission.state}`} title={data.submission.reason || `提审 ${data.submission.submittedAt.slice(0, 10)}`}>
            {data.submission.state === "unreviewed" ? "待看"
              : data.submission.state === "seen" ? "已看"
              : data.submission.state === "fully-passed" ? "✓ 通过" : "✗ 未过"}
          </small>
        )}
      </header>
      <div className="material-card-body nodrag nopan nowheel">
        {data.kind === "text" ? (
          <EditableText id={id} data={data} actions={actions} zoom={zoom} />
        ) : <MaterialBody data={data} zoom={zoom} />}
      </div>
    </article>
  );
});

/** 编组容器卡(React Flow subflow 父节点): 半透明底+可改名组名; 子卡 parentId 指向它, 拖组=整组移动。
 *  选中时露 ✎: 编辑组描述(M3c, 正文走 materials/<卡id>.md 分居链)。 */
const GroupCard = memo(function GroupCard({ id, data, selected }: NodeProps<CanvasNode>) {
  const actions = useContext(CardActionsContext);
  if (!actions) return null;
  return (
    <div className={`material-group-card${selected ? " selected" : ""}`}>
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={260}
        minHeight={180}
        onResizeStart={() => actions.resizeGroup(id, null, "start")}
        onResize={(_event, params) => actions.resizeGroup(id, params, "move")}
        onResizeEnd={(_event, params) => actions.resizeGroup(id, params, "end")}
      />
      <input
        className="material-group-name nodrag nopan"
        value={data.title}
        aria-label="编组名(可改, 失焦保存)"
        onChange={(event) => actions.renameGroup(id, event.currentTarget.value)}
        onBlur={() => actions.finishGroupRename(id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key !== "Escape") event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      {selected && (
        <button
          type="button"
          className="material-group-edit nodrag nopan"
          title="编辑组描述"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => actions.editGroupBody(id)}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
});

const nodeTypes = { materialCard: MaterialCard, groupCard: GroupCard };
const edgeTypes = { materialRelation: MaterialRelation };

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
  focusCardId,
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
  const stageRef = useRef<HTMLElement | null>(null);
  const past = useRef<CanvasSnapshot[]>([]);
  const future = useRef<CanvasSnapshot[]>([]);
  const dragSnapshot = useRef<CanvasSnapshot | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveRevision = useRef(0);
  const baseRevision = useRef(0);  // 服务端单调 revision；不再以客户端时间戳排序
  const baseDocument = useRef<MaterialCanvasDocument | null>(null);
  const textWriteTimers = useRef(new Map<string, number>());
  const textWriteRevisions = useRef(new Map<string, number>());
  const [historyRevision, setHistoryRevision] = useState(0);
  const [booting, setBooting] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<"empty" | "dirty" | "saving" | "saved" | "error">("empty");
  const [saveErrorDetail, setSaveErrorDetail] = useState("");
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const [dialog, setDialog] = useState<"material" | "legacy" | null>(null);
  const [materialInput, setMaterialInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hits, setHits] = useState<FileHit[]>([]);
  const [legacyNotes, setLegacyNotes] = useState<LegacyNote[]>([]);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  // M4: ?review=global 深链 —— 直接落在审阅面「全部会话」整体列表(全体会话审阅台深链形态)
  const reviewEnabled = useMemo(() => notesReviewEnabled(resolveNotesAppearance()), []);
  const initialReviewGlobal = useMemo(() => new URLSearchParams(window.location.search).get("review") === "global", []);
  const [view, setView] = useState<"canvas" | "review" | "doc">(initialReviewGlobal && reviewEnabled ? "review" : "canvas");
  const outlineToggleRef = useRef<(() => void) | null>(null); // DocView 挂载时注册的大纲开关
  const [freezingId, setFreezingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "pane" | "card" | "edge"; id?: string } | null>(null);
  // 触屏画布长按 = 画布空白右键菜单(panOnDrag 只吃鼠标键, 单指按住不会平移, 可安全借位给长按)
  // 长按抬起会合成 mousedown: 关闭监听在打开后 500ms 内忽略, 菜单不会被自己关掉。
  const menuOpenedAtRef = useRef(0);
  const paneHoldRef = useRef<{ timer: number; x: number; y: number; pointerId: number } | null>(null);
  const clearPaneHold = () => {
    if (paneHoldRef.current) {
      window.clearTimeout(paneHoldRef.current.timer);
      paneHoldRef.current = null;
    }
  };
  useEffect(() => clearPaneHold, []);
  const onStagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    const target = event.target as Element | null;
    if (target?.closest(".react-flow__node, .react-flow__edge, button, input, select, a, textarea")) return;
    clearPaneHold();
    const x = event.clientX;
    const y = event.clientY;
    const pointerId = event.pointerId;
    paneHoldRef.current = {
      pointerId, x, y,
      timer: window.setTimeout(() => {
        paneHoldRef.current = null;
        menuOpenedAtRef.current = performance.now();
        setCanvasMenuOpen(false);
        setMenu({ x, y, kind: "pane" });
      }, 600),
    };
  };
  const onStagePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const hold = paneHoldRef.current;
    if (!hold || hold.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 14) clearPaneHold();
  };
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const hoverClearTimer = useRef<number | null>(null);
  const [editingRelationId, setEditingRelationId] = useState<string | null>(null);
  const highlightRef = useRef<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const [canvasTitle, setCanvasTitle] = useState("");
  const canvasTitleRef = useRef("");
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [lastMutation, setLastMutation] = useState<MaterialCanvasDocument["lastMutation"]>();
  const [linkFeedback, setLinkFeedback] = useState("");
  const linkFeedbackTimer = useRef<number | null>(null);
  const [layoutState, setLayoutState] = useState<"idle" | "running" | "error">("idle");
  const autoLayoutRef = useRef<(() => void | Promise<void>) | null>(null);
  const moveSnapshot = useRef<CanvasSnapshot | null>(null); // (保留字段, 视口历史改用 stableViewport 方案)
  const skipMoveHistory = useRef(false); // 程序化 setViewport/fitView 不产生历史
  const skipMoveTimer = useRef<number | null>(null);
  // 上一个稳定视口(上一段手势结束时的值)。wheel 平移的 onMoveStart 拿到的已是移动后视口
  // (xyflow panOnScroll 先 translateBy 再发 start), 所以撤销用的 pre 必须来自这里。
  const stableViewport = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // 程序化视口移动(撤回还原/排布后 fitView)不产生撤销历史。
  // 注意: 程序化 setViewport 可能不触发 onMove 事件(目标=当前视口时), 所以不能靠 onMoveEnd 复位, 用兜底定时器
  const markProgrammaticMove = useCallback(() => {
    skipMoveHistory.current = true;
    if (skipMoveTimer.current !== null) window.clearTimeout(skipMoveTimer.current);
    skipMoveTimer.current = window.setTimeout(() => {
      skipMoveHistory.current = false;
      stableViewport.current = flowRef.current?.getViewport() ?? stableViewport.current;
    }, 600);
  }, []);

  // 工具条由 React Flow portal 到卡片外部；离开卡片后延迟收起，让鼠标有时间进入工具条自身。
  const holdCardTools = useCallback((id: string, active: boolean) => {
    if (hoverClearTimer.current !== null) {
      window.clearTimeout(hoverClearTimer.current);
      hoverClearTimer.current = null;
    }
    if (active) {
      setHoveredCardId(id);
      return;
    }
    hoverClearTimer.current = window.setTimeout(() => {
      setHoveredCardId((current) => current === id ? null : current);
      hoverClearTimer.current = null;
    }, 180);
  }, []);
  useEffect(() => () => {
    if (hoverClearTimer.current !== null) window.clearTimeout(hoverClearTimer.current);
  }, []);

  const exitFullscreen = useCallback(() => {
    setFullscreenId(null);
    setFocusedCardId(null);
  }, []);

  // 卡片被移除时退出其全屏/阅读聚焦; Esc 随时退出全屏
  useEffect(() => {
    if (fullscreenId && !nodes.some((node) => node.id === fullscreenId)) setFullscreenId(null);
    if (focusedCardId && !nodes.some((node) => node.id === focusedCardId)) setFocusedCardId(null);
  }, [focusedCardId, fullscreenId, nodes]);
  useEffect(() => {
    if (!fullscreenId) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") exitFullscreen(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitFullscreen, fullscreenId]);

  const refreshHistory = () => setHistoryRevision((value) => value + 1);
  const pushHistory = useCallback((value = snapshotOf(nodesRef.current, edgesRef.current, flowRef.current?.getViewport())) => {
    past.current.push(value);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    refreshHistory();
  }, []);

  // 把 canonical 文档应用到画布。正文是独立 Material，重载布局时保留已读正文与选择态。
  // syncBase=false 用于“服务端已提交 + 本地又有后续输入”的合并渲染；基线仍指向服务端回包。
  const applyDocument = useCallback((document: MaterialCanvasDocument | null, syncBase = true) => {
    const title = document?.title || session.label;
    canvasTitleRef.current = title;
    setCanvasTitle(title);
    if (!document || !document.cards.length) {
      const draft = draftNode();
      nodesRef.current = [draft];
      edgesRef.current = [];
      setNodes([draft]);
      setEdges([]);
      if (syncBase) {
        const empty = emptyCanvasDocument(session.id);
        baseDocument.current = empty;
        baseRevision.current = 0;
        setCanvasRevision(0);
        setLastMutation(undefined);
        setSaveState("empty");
      }
      return;
    }
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    const loadedNodes = parentsFirst(document.cards.map((card) => {
      const node = nodeFromCard(card);
      const before = previous.get(card.id);
      if (!before) return node;
      return {
        ...node,
        selected: before.selected,
        data: {
          ...node.data,
          ...(typeof before.data.text === "string" ? { text: before.data.text } : {}),
        },
      };
    }));
    const loadedEdges = document.relations.map(edgeFromRelation);
    nodesRef.current = loadedNodes;
    edgesRef.current = loadedEdges;
    setNodes(loadedNodes);
    setEdges(loadedEdges);
    if (syncBase) {
      baseDocument.current = document;
      baseRevision.current = document.revision;
      setCanvasRevision(document.revision);
      setLastMutation(document.lastMutation);
      setSaveState("saved");
    }
    // 坐标严重退化(几乎全在同一列) → 自动跑一次分层排布
    if (isDegenerateLayout(loadedNodes)) {
      window.setTimeout(() => autoLayoutRef.current?.(), 0);
    }
  }, [session.label]);

  const writeDocument = useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const revision = ++saveRevision.current;
    // 标题等于会话名回退值时不写 title(避免把缺省值固化进文档, 盖掉外部设置的画布名)
    const titleForDoc = canvasTitleRef.current === session.label ? "" : canvasTitleRef.current;
    const document = persistedDocument(session.id, nextNodes, nextEdges, titleForDoc);
    setSaveState(document.cards.length ? "dirty" : "empty");
    saveTimer.current = window.setTimeout(() => {
      const baseline = baseDocument.current || emptyCanvasDocument(session.id);
      const patch = diffCanvasDocuments(baseline, document);
      if (canvasPatchIsEmpty(patch)) {
        if (saveRevision.current === revision) setSaveState(document.cards.length ? "saved" : "empty");
        return;
      }
      setSaveState("saving");
      const mutationId = safeRandomId("mutation-");
      void invokeCommand<CanvasMutationResult>("notes_canvas_mutate", {
        id: storageId,
        session_id: session.id,
        mutation_id: mutationId,
        actor: `browser:${session.id}`,
        workspace_ref: { kind: "note-session", ref: session.id },
        actor_ref: { kind: "browser", ref: session.id },
        base_revision: baseline.revision,
        patch,
      })
        .then((result) => {
          const canonical = parseCanvasDocument(result.json, session.id);
          if (!canonical) throw new Error("服务端返回了无效画布文档");
          if (saveRevision.current === revision) {
            applyDocument(canonical);
            return;
          }
          // 保存飞行期间又有输入：以 canonical 为新基线，把“发送后新增”的本地差异叠回去。
          const localNow = persistedDocument(
            session.id,
            nodesRef.current,
            edgesRef.current,
            canvasTitleRef.current === session.label ? "" : canvasTitleRef.current,
          );
          const pendingPatch = diffCanvasDocuments(document, localNow);
          baseDocument.current = canonical;
          baseRevision.current = canonical.revision;
          setCanvasRevision(canonical.revision);
          setLastMutation(canonical.lastMutation);
          applyDocument(applyCanvasMutation(canonical, pendingPatch), false);
          setSaveState("dirty");
        })
        .catch((reason) => {
          console.error("[material-canvas] save failed", reason);
          // 同一实体真冲突不自动 last-write-wins；保留本地内容并明确显示失败。
          if (saveRevision.current === revision) {
            setSaveState("error");
            setSaveErrorDetail(String(reason).slice(0, 300));
          }
        });
    }, 180);
  }, [invokeCommand, session.id, storageId, applyDocument]);

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
    const timeout = window.setTimeout(() => {
      if (!live) return;
      setLoadError("札记存储响应超时。请确认笔记桥可用后重试。");
      setBooting(false);
    }, 12_000);
    void invokeCommand<string | null>("notes_canvas_get", { id: storageId })
      .then((raw) => {
        if (!live) return;
        window.clearTimeout(timeout);
        applyDocument(parseCanvasDocument(raw, session.id));
        setBooting(false);
      })
      .catch((reason) => {
        if (!live) return;
        window.clearTimeout(timeout);
        setLoadError(String(reason));
        setBooting(false);
      });
    return () => {
      live = false;
      window.clearTimeout(timeout);
    };
  }, [invokeCommand, session.id, storageId]);

  // 外部 Agent / 另一页面提交后，按服务端 revision 主动追踪；不再等待本页下一次保存撞冲突。
  // 本地 dirty/saving/error 时先不重载，交给原子 mutation 合并或显式冲突，避免吞掉未提交输入。
  useEffect(() => {
    if (booting || loadError) return;
    let disposed = false;
    let running = false;
    const refreshExternal = async () => {
      if (disposed || running || document.visibilityState !== "visible") return;
      if (!new Set(["saved", "empty"]).has(saveStateRef.current)) return;
      running = true;
      try {
        const head = await invokeCommand<CanvasHead | null>("notes_canvas_head", { id: storageId });
        if (!head || head.revision === baseRevision.current || disposed) return;
        const raw = await invokeCommand<string | null>("notes_canvas_get", { id: storageId });
        if (disposed) return;
        const canonical = parseCanvasDocument(raw, session.id);
        if (canonical && canonical.revision !== baseRevision.current) applyDocument(canonical);
      } catch (reason) {
        console.error("[material-canvas] external revision refresh failed", reason);
      } finally {
        running = false;
      }
    };
    void refreshExternal();
    const timer = window.setInterval(() => { void refreshExternal(); }, 1200);
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshExternal(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [applyDocument, booting, invokeCommand, loadError, session.id, storageId]);

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

  // 恢复快照: 节点/边回滚 + 视口(若有)一并还原——「任何移动和放缩」都可撤
  const restoreSnapshot = useCallback((snap: CanvasSnapshot) => {
    for (const node of snap.nodes) {
      if (node.data.kind === "text" && node.data.source?.kind === "file" && node.data.source.editableId && typeof node.data.text === "string") {
        writeTextMaterial(node.data.source.editableId, node.data.text);
      }
    }
    setGraph(cloneNodes(snap.nodes), snap.edges.map((edge) => ({ ...edge })));
    if (snap.viewport) {
      markProgrammaticMove();
      stableViewport.current = snap.viewport;
      window.setTimeout(() => void flowRef.current?.setViewport(snap.viewport!, { duration: 120 }), 0);
    }
  }, [setGraph, writeTextMaterial]);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(snapshotOf(nodesRef.current, edgesRef.current, flowRef.current?.getViewport()));
    restoreSnapshot(previous);
    refreshHistory();
  }, [restoreSnapshot]);

  const redo = useCallback(() => {
    const following = future.current.pop();
    if (!following) return;
    past.current.push(snapshotOf(nodesRef.current, edgesRef.current, flowRef.current?.getViewport()));
    restoreSnapshot(following);
    refreshHistory();
  }, [restoreSnapshot]);

  // Ctrl+Z 撤回 / Ctrl+Y 与 Ctrl+Shift+Z 还原; 焦点在输入框/文本域/可编辑区时不劫持
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      if (key === "y" || (key === "z" && event.shiftKey)) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

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

  // 右键菜单"新建文字卡": 落在右键点的流坐标上(有空 draft 则只选中, 不堆空卡)
  const addTextAt = useCallback((clientX: number, clientY: number) => {
    const currentDraft = nodesRef.current.find((node) => node.data.kind === "text" && node.data.draft);
    if (currentDraft) {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === currentDraft.id })));
      return;
    }
    pushHistory();
    const point = flowRef.current?.screenToFlowPosition({ x: clientX, y: clientY }) || { x: 100, y: 90 };
    setGraph([...nodesRef.current, draftNode(point.x, point.y)], edgesRef.current, false);
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

  const activateCard = useCallback((id: string) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node || node.data.kind === "group") return;
    if (focusedCardId === id) {
      setFullscreenId(id);
      return;
    }
    setFocusedCardId(id);
    const flow = flowRef.current;
    if (!flow) return;
    const size = dimensionsOf(node);
    const stage = stageRef.current?.getBoundingClientRect();
    const zoom = Math.min(
      1.35,
      Math.max(0.45, Math.min(
        ((stage?.width || 1200) * 0.82) / size.width,
        ((stage?.height || 760) * 0.82) / size.height,
      )),
    );
    const absolute = flow.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
    // 触屏浏览器会在 pointerup 后补发 click；若此处立刻移动卡片，click 会落到
    // 已经移到指针下方的画布空白处，进而清掉刚建立的二段聚焦状态。
    window.setTimeout(() => {
      markProgrammaticMove();
      setCanvasZoom(zoom);
      void flow.setCenter(
        absolute.x + size.width / 2,
        absolute.y + size.height / 2,
        { zoom, duration: 280 },
      );
    }, 0);
  }, [focusedCardId, markProgrammaticMove]);

  // ---- 组描述(M3c): 正文走 materials/<组卡id>.md 分居链, 卡上挂 source 引用 ----
  const [groupBodyEdit, setGroupBodyEdit] = useState<{ id: string; text: string; loading: boolean } | null>(null);
  const saveGroupBody = useCallback(async () => {
    const edit = groupBodyEdit;
    if (!edit) return;
    const material = await invokeCommand<TextMaterialPayload>("notes_text_put", { id: edit.id, content: edit.text });
    const source = {
      kind: "file" as const,
      path: material.path,
      token: material.open_token,
      mime: material.mime,
      editableId: edit.id,
    };
    const next = nodesRef.current.map((node) => node.id === edit.id ? { ...node, data: { ...node.data, source } } : node);
    nodesRef.current = next;
    setNodes(next);
    writeDocument(next, edgesRef.current);
    setGroupBodyEdit(null);
  }, [groupBodyEdit, invokeCommand, writeDocument]);

  // ---- 提审(M1a): 提交/裁决都走既有 writeDocument → diff → mutate 链 ----
  const setCardSubmission = useCallback((id: string, submission: CardSubmission) => {
    const next = nodesRef.current.map((node) => node.id === id ? { ...node, data: { ...node.data, submission } } : node);
    nodesRef.current = next;
    setNodes(next);
    writeDocument(next, edgesRef.current);
  }, [writeDocument]);

  const submitForReview = useCallback((id: string) => {
    if (!reviewEnabled) return;
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node || node.data.kind === "group") return;
    const existing = node.data.submission;
    if (existing && (existing.state === "unreviewed" || existing.state === "seen")) return;
    setCardSubmission(id, {
      state: "unreviewed",
      submittedAt: new Date().toISOString(),
      submittedBy: `browser:${session.id}`,
    });
  }, [reviewEnabled, setCardSubmission, session.id]);

  const verdictCard = useCallback((id: string, pass: boolean, reason?: string) => {
    const node = nodesRef.current.find((item) => item.id === id);
    const sub = node?.data.submission;
    if (!node || !sub) return;
    setCardSubmission(id, {
      ...sub,
      state: pass ? "fully-passed" : "not-fully-passed",
      verdictAt: new Date().toISOString(),
      verdictBy: `browser:${session.id}`,
      ...(reason ? { reason } : {}),
    });
  }, [setCardSubmission, session.id]);

  // 「看过」= 点开该卡全屏/详情 → 自动置 seen
  useEffect(() => {
    if (!fullscreenId) return;
    const node = nodesRef.current.find((item) => item.id === fullscreenId);
    const sub = node?.data.submission;
    if (node && sub?.state === "unreviewed") {
      setCardSubmission(fullscreenId, { ...sub, state: "seen", seenAt: new Date().toISOString() });
    }
  }, [fullscreenId, setCardSubmission]);

  const cardActions = useMemo<CardActions>(() => ({
    activateCard,
    openMenu: (id, x, y) => {
      menuOpenedAtRef.current = performance.now();
      setCanvasMenuOpen(false);
      setMenu({ x, y, kind: "card", id });
    },
    submitForReview,
    verdictCard,
    reviewEnabled,
    editGroupBody: (id) => {
      setGroupBodyEdit({ id, text: "", loading: true });
      void invokeCommand<TextMaterialPayload>("notes_text_get", { id })
        .then((material) => setGroupBodyEdit({ id, text: material.content || "", loading: false }))
        .catch(() => setGroupBodyEdit({ id, text: "", loading: false }));
    },
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
    setTextSize: (id, requestedSize) => {
      const current = nodesRef.current.find((node) => node.id === id);
      if (!current || current.data.kind !== "text") return;
      const fontSize = Math.min(72, Math.max(8, Math.round(requestedSize)));
      if (fontSize === (current.data.fontSize || 14)) return;
      pushHistory();
      const next = nodesRef.current.map((node) => node.id === id
        ? { ...node, data: { ...node.data, fontSize } }
        : node);
      nodesRef.current = next;
      setNodes(next);
      writeDocument(next, edgesRef.current);
    },
    removeCard: (id) => {
      pushHistory();
      const target = nodesRef.current.find((node) => node.id === id);
      let nextNodes = nodesRef.current.filter((node) => node.id !== id);
      // 删组卡: 子卡(含子组)parentId 上移一层挂到被删组的父级, 不留悬空 parentId
      if (target?.data.kind === "group") {
        nextNodes = nextNodes.map((node) => {
          if (node.parentId !== id) return node;
          const { parentId: _p, ...restData } = node.data;
          const grandParentId = target.parentId;
          return {
            ...node,
            parentId: grandParentId,
            extent: grandParentId ? node.extent : undefined,
            position: { x: target.position.x + node.position.x, y: target.position.y + node.position.y },
            data: grandParentId ? { ...restData, parentId: grandParentId } : restData,
          };
        });
      }
      const nextEdges = edgesRef.current.filter((edge) => edge.source !== id && edge.target !== id);
      setGraph(nextNodes.length ? nextNodes : [draftNode()], nextEdges);
    },
    toggleFullscreen: (id) => {
      setFocusedCardId(null);
      setFullscreenId((current) => (current === id ? null : id));
    },
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
    copyCardRef: async (id) => {
      // 可被人和 Agent 一眼识别的跨应用引用；保留原始会话/卡片 id 以便精确寻址。
      const raw = session.id.startsWith("external:") ? session.id.slice("external:".length) : session.id;
      const ref = formatCanvasCardReference("omnicompany", raw, id);
      await copyPlainText(ref);
      return ref;
    },
    renameGroup: (id, title) => {
      const next = nodesRef.current.map((node) => node.id === id ? {
        ...node,
        data: { ...node.data, title },
      } : node);
      nodesRef.current = next;
      setNodes(next);
    },
    finishGroupRename: (id) => {
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node || node.data.kind !== "group") return;
      const title = node.data.title.trim() || "编组";
      if (title !== node.data.title) {
        const next = nodesRef.current.map((item) => item.id === id ? { ...item, data: { ...item.data, title } } : item);
        nodesRef.current = next;
        setNodes(next);
      }
      writeDocument(nodesRef.current, edgesRef.current);
    },
    // 组卡缩放(NodeResizer): start 入历史快照, move 实时改 style, end 落盘
    resizeGroup: (id, params, phase) => {
      if (phase === "start") { pushHistory(); return; }
      if (!params) return;
      const next = nodesRef.current.map((node) => node.id === id ? {
        ...node,
        position: { x: params.x, y: params.y },
        style: { ...node.style, width: params.width, height: params.height },
      } : node);
      nodesRef.current = next;
      setNodes(next);
      if (phase === "end") writeDocument(next, edgesRef.current);
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
  }), [activateCard, submitForReview, verdictCard, reviewEnabled, invokeCommand, pushHistory, setGraph, writeDocument, writeTextMaterial, freezingId, session.id]);

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
      say: (args: CanvasOpArgs) => {
        // AI 回写: 新建一块带内容的文字卡(走 changeText 既有落盘链, 标题取首行)
        const text = String(args.text || "").trim();
        if (!text) throw new Error("空内容");
        pushHistory();
        const count = nodesRef.current.length;
        const node = draftNode(80 + (count % 3) * 580, 72 + Math.floor(count / 3) * 460);
        setGraph([...nodesRef.current, node], edgesRef.current, false);
        cardActions.changeText(node.id, text);
        return { created: node.id };
      },
      rewrite: (args: CanvasOpArgs) => {
        // 覆写既有文字卡正文(如 @AI 回应覆写提问卡), 走 changeText 既有链
        const id = String(args.card || "");
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node || node.data.kind !== "text") throw new Error(`不是文字卡或没找到: ${id}`);
        cardActions.beginTextEdit();
        cardActions.changeText(id, String(args.text ?? ""));
        return { rewritten: id };
      },
    });
  }, [storageId, cardActions, pushHistory, setGraph]);

  // Ctrl+滚轮: 只做整体视口缩放(用户口径 2026-08-13: 取消悬停卡级缩放)。
  // React Flow 对 .nowheel 区域(卡体, 保文字滚动)连 pinch 也拦, 这里补一条:
  // ctrl/meta+滚轮落在 nowheel 里时手动 zoomIn/zoomOut(视口中心), 其余位置走 RF 原生 pinch(指针中心)。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const inNoWheel = (event.target as Element | null)?.closest?.(".nowheel");
      if (!inNoWheel) return; // 非 nowheel 区域: RF 原生 pinch, 不碰
      event.preventDefault();
      event.stopPropagation();
      const flow = flowRef.current;
      if (!flow) return;
      if (event.deltaY < 0) void flow.zoomIn({ duration: 80 });
      else void flow.zoomOut({ duration: 80 });
    };
    stage.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => stage.removeEventListener("wheel", onWheel, { capture: true });
  }, [booting]);

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
    const next = addEdge({
      ...connection,
      id: safeRandomId("relation-"),
      type: "materialRelation",
      data: { path: "curve", arrow: "closed" },
      markerEnd: relationMarker("closed"),
    }, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
    writeDocument(nodesRef.current, next);
  }, [pushHistory, writeDocument]);

  const onReconnect = useCallback((oldEdge: CanvasEdge, connection: Connection) => {
    pushHistory();
    const next = reconnectEdge(oldEdge, connection, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
    writeDocument(nodesRef.current, next);
  }, [pushHistory, writeDocument]);

  const removeRelation = useCallback((edgeId: string) => {
    if (!edgesRef.current.some((edge) => edge.id === edgeId)) return;
    pushHistory();
    const next = edgesRef.current.filter((edge) => edge.id !== edgeId);
    edgesRef.current = next;
    setEdges(next);
    writeDocument(nodesRef.current, next);
  }, [pushHistory, writeDocument]);

  const relationActions = useMemo<RelationActions>(() => ({
    update: (id, patch) => {
      const current = edgesRef.current.find((edge) => edge.id === id);
      if (!current) return;
      const label = patch.label !== undefined ? patch.label : current.label;
      const path = patch.path || current.data?.path || "curve";
      const arrow = patch.arrow || current.data?.arrow || "closed";
      const kind = patch.kind !== undefined ? (patch.kind ?? undefined) : current.data?.kind;
      if (label === current.label && path === current.data?.path && arrow === current.data?.arrow && kind === current.data?.kind) return;
      pushHistory();
      const next = edgesRef.current.map((edge) => edge.id === id ? {
        ...edge,
        label,
        data: { path, arrow, kind },
        markerEnd: relationMarker(arrow),
      } : edge);
      edgesRef.current = next;
      setEdges(next);
      writeDocument(nodesRef.current, next);
    },
    select: (id) => {
      setEditingRelationId(id);
      const nextNodes = nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node);
      const nextEdges = edgesRef.current.map((edge) => ({ ...edge, selected: edge.id === id }));
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
    },
    finish: (id) => setEditingRelationId((current) => current === id ? null : current),
    editingId: editingRelationId,
  }), [editingRelationId, pushHistory, writeDocument]);

  // 自动排布交给 ELK：按真实卡片尺寸做分层、交叉最小化、连通分量压缩和编组布局。
  // 只动坐标与组卡包围盒，不改内容、关系及关系文字。
  const runAutoLayout = useCallback(async () => {
    if (!nodesRef.current.length) return;
    if (layoutState === "running") return;
    setLayoutState("running");
    const inputNodes = nodesRef.current;
    const inputEdges = edgesRef.current;
    const layoutInputKey = (graphNodes: CanvasNode[], graphEdges: CanvasEdge[]) => `${graphNodes.map((node) => {
      const size = dimensionsOf(node);
      return `${node.id}:${node.parentId || ""}:${size.width}x${size.height}`;
    }).join("|")}::${graphEdges.map((edge) => `${edge.id}:${edge.source}:${edge.target}`).join("|")}`;
    const structureKey = layoutInputKey(inputNodes, inputEdges);
    try {
      const placements = await layoutMaterialCanvas(
        inputNodes.map((node) => {
          const size = dimensionsOf(node);
          return {
            id: node.id,
            parentId: node.parentId,
            kind: node.data.kind,
            width: size.width,
            height: size.height,
          };
        }),
        inputEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      );
      const currentStructureKey = layoutInputKey(nodesRef.current, edgesRef.current);
      if (currentStructureKey !== structureKey) throw new Error("排布期间画布结构已变化，请重试");
      pushHistory(snapshotOf(inputNodes, inputEdges, flowRef.current?.getViewport()));
      const next = parentsFirst(nodesRef.current.map((node) => {
        const placement = placements.get(node.id);
        if (!placement) return node;
        return {
          ...node,
          position: { x: placement.x, y: placement.y },
          ...(node.data.kind === "group" ? {
            style: { ...node.style, width: placement.width, height: placement.height },
          } : {}),
        };
      }));
      const byId = new Map(next.map((node) => [node.id, node]));
      const absoluteCenter = (id: string) => {
        const node = byId.get(id);
        if (!node) return null;
        const size = dimensionsOf(node);
        let x = node.position.x + size.width / 2;
        let y = node.position.y + size.height / 2;
        let parentId = node.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = byId.get(parentId);
          if (!parent) break;
          x += parent.position.x;
          y += parent.position.y;
          parentId = parent.parentId;
        }
        return { x, y };
      };
      const nextEdges = edgesRef.current.map((edge) => {
        const source = absoluteCenter(edge.source);
        const target = absoluteCenter(edge.target);
        if (!source || !target) return edge;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          return {
            ...edge,
            sourceHandle: dx >= 0 ? "right" : "left",
            targetHandle: dx >= 0 ? "left" : "right",
          };
        }
        return {
          ...edge,
          sourceHandle: dy >= 0 ? "bottom" : "top",
          targetHandle: dy >= 0 ? "top" : "bottom",
        };
      });
      nodesRef.current = next;
      edgesRef.current = nextEdges;
      setNodes(next);
      setEdges(nextEdges);
      writeDocument(next, nextEdges);
      markProgrammaticMove();
      window.setTimeout(() => void flowRef.current?.fitView({ padding: 0.1, maxZoom: 1 }), 60);
      setLayoutState("idle");
    } catch (reason) {
      console.error("[material-canvas] 自动排布失败", reason);
      setLayoutState("error");
      window.setTimeout(() => setLayoutState("idle"), 2400);
    }
  }, [layoutState, markProgrammaticMove, pushHistory, writeDocument]);
  autoLayoutRef.current = runAutoLayout;

  // 复制链接: 当前 origin + 当前页路径 + session_id 参数(sessionIdentity 加载时按参数选画布),
  // 局域网另一块屏打开同一 dashboard 反代地址即可看到同一张画布
  const copyCanvasLink = useCallback(() => {
    const raw = session.id.startsWith("external:") ? session.id.slice("external:".length) : session.id;
    const url = `${window.location.origin}${window.location.pathname}?session_id=${encodeURIComponent(raw)}`;
    void copyPlainText(url)
      .then(() => setLinkFeedback("已复制"))
      .catch(() => setLinkFeedback("复制失败"));
    if (linkFeedbackTimer.current !== null) window.clearTimeout(linkFeedbackTimer.current);
    linkFeedbackTimer.current = window.setTimeout(() => setLinkFeedback(""), 2000);
  }, [session.id]);

  // 画布改名: 失焦/回车提交, 随下次写盘持久化进 store 文档 title 字段
  const commitTitle = useCallback(() => {
    const next = canvasTitleRef.current.trim() || session.label;
    canvasTitleRef.current = next;
    setCanvasTitle(next);
    writeDocument(nodesRef.current, edgesRef.current);
  }, [session.label, writeDocument]);

  // M2: 组内阅读顺序手动覆盖(数字, 升序; 空=清除回退 continues 拓扑/坐标)
  const setCardOrder = useCallback((id: string) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    const current = node.data.order;
    const input = window.prompt("组内阅读顺序（数字，升序；留空清除）", current === undefined ? "" : String(current));
    if (input === null) return;
    const trimmed = input.trim();
    const value = trimmed === "" ? undefined : Number(trimmed);
    if (value !== undefined && !Number.isFinite(value)) return;
    pushHistory();
    const next = nodesRef.current.map((item) => item.id === id ? { ...item, data: { ...item.data, order: value } } : item);
    nodesRef.current = next;
    setNodes(next);
    writeDocument(next, edgesRef.current);
  }, [pushHistory, writeDocument]);

  // 审阅视图点卡: 切回画布并聚焦(只聚焦不进全屏; React Flow 保活未卸载, 视口/选中态不丢)
  const focusCardOnCanvas = useCallback((id: string) => {    setView("canvas");
    window.setTimeout(() => {
      const node = nodesRef.current.find((item) => item.id === id);
      const flow = flowRef.current;
      if (!node || !flow) return;
      const size = dimensionsOf(node);
      const absolute = flow.getInternalNode(id)?.internals.positionAbsolute ?? node.position;
      markProgrammaticMove();
      setFocusedCardId(id);
      void flow.setCenter(absolute.x + size.width / 2, absolute.y + size.height / 2, {
        zoom: Math.max(flow.getViewport().zoom, 0.6),
        duration: 280,
      });
    }, 80);
  }, [markProgrammaticMove]);

  // 深链(M1b): /lofa/overlay/app/?session_id=<pty>&focus=<cardId> —— 加载完成后聚焦目标卡
  const initialFocusCard = useMemo(
    () => focusCardId || new URLSearchParams(window.location.search).get("focus"),
    [focusCardId],
  );
  useEffect(() => {
    if (booting || !initialFocusCard) return;
    if (!nodesRef.current.some((node) => node.id === initialFocusCard)) return;
    focusCardOnCanvas(initialFocusCard);
  }, [booting, initialFocusCard, focusCardOnCanvas]);

  // ---- M2 文档视图: 稳定 props(数组/函数身份变了会让 DocView 预取 effect 空转) ----
  const docCards = useMemo<DocCard[]>(() => nodes.map((node) => {
    const { draft: _draft, text: _text, ...restData } = node.data;
    const size = dimensionsOf(node);
    return {
      id: node.id,
      kind: node.data.kind,
      title: node.data.title,
      parentId: node.parentId,
      order: node.data.order,
      submission: node.data.submission,
      adapter: node.data.adapter,
      source: node.data.source,
      width: size.width,
      height: size.height,
      x: node.position.x,
      y: node.position.y,
      // 无损回填记录: DocView 块编辑(改名/插入/删除)走 mutate upsert 时用
      record: { ...restData, parentId: node.parentId, x: node.position.x, y: node.position.y, width: size.width, height: size.height },
    };
  }), [nodes]);
  const docRelations = useMemo<DocRelation[]>(() => edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: typeof edge.label === "string" ? edge.label : undefined,
    kind: edge.data?.kind,
  })), [edges]);
  const docFetchText = useCallback(async (editableId: string) => {
    const material = await invokeCommand<TextMaterialPayload>("notes_text_get", { id: editableId });
    return material.content ?? "";
  }, [invokeCommand]);
  const docPutText = useCallback(async (editableId: string, content: string) => {
    return invokeCommand<TextMaterialPayload>("notes_text_put", { id: editableId, content });
  }, [invokeCommand]);
  // 文档块编辑直写 mutate(不走 writeDocument 防抖): 提交后按服务端回包重置基线
  const docMutate = useCallback(async (patch: CanvasMutationPatch) => {
    const result = await invokeCommand<CanvasMutationResult>("notes_canvas_mutate", {
      id: storageId,
      session_id: session.id,
      mutation_id: safeRandomId("doc-"),
      actor: `browser:${session.id}`,
      workspace_ref: { kind: "note-session", ref: session.id },
      actor_ref: { kind: "browser", ref: session.id },
      base_revision: baseRevision.current ?? 0,
      patch,
    });
    const canonical = parseCanvasDocument(result.json, session.id);
    if (canonical) applyDocument(canonical);
    return result;
  }, [invokeCommand, session.id, storageId, applyDocument]);

  // ---- 审阅(M1b 定稿): 默认本会话队列; 「全部会话」整体列表走 /lofa/overlay/review-queue 聚合 ----
  const [reviewScope, setReviewScope] = useState<"session" | "global">(initialReviewGlobal ? "global" : "session");
  const [globalReviewItems, setGlobalReviewItems] = useState<ReviewItemData[]>([]);
  const sessionReviewItems: ReviewItemData[] = nodes
    .filter((node) => node.data.kind !== "group" && node.data.submission)
    .map((node) => ({
      key: `${storageId}|${node.id}`,
      cardId: node.id,
      canvasKey: storageId,
      sessionId: session.id.startsWith("external:") ? session.id.slice("external:".length) : session.id,
      sessionLabel: session.label,
      canvasTitle: canvasTitleRef.current || session.label,
      title: node.data.title,
      kind: node.data.kind,
      adapter: node.data.adapter,
      mime: node.data.source?.kind === "file" ? String(node.data.source.mime ?? "") : "",
      fileToken: node.data.kind === "material" && node.data.source?.kind === "file" ? node.data.source.token : null,
      editableId: node.data.source?.kind === "file" ? (node.data.source.editableId ?? null) : null,
      submission: node.data.submission!,
    }))
    .sort((a, b) => String(b.submission.submittedAt).localeCompare(String(a.submission.submittedAt)));

  const loadGlobalReview = useCallback(async () => {
    // 真源: GET /lofa/overlay/review-queue(material 契约聚合); 老进程没这端点(未重启)则 invoke 桥逐画布兜底
    let rows: Record<string, unknown>[] | null = null;
    try {
      const resp = await fetch("/lofa/overlay/review-queue");
      if (resp.ok) {
        const payload = await resp.json();
        if (payload?.ok && Array.isArray(payload.items)) rows = payload.items;
      }
    } catch { /* 落桥兜底 */ }
    const items: ReviewItemData[] = [];
    if (rows) {
      // 端点没随行的 source(老进程): 有媒体预览需求的项回桥补 token
      const tokenCache = new Map<string, Promise<Record<string, unknown> | null>>();
      const canvasDoc = (canvasKey: string) => {
        if (!tokenCache.has(canvasKey)) {
          tokenCache.set(canvasKey, invokeCommand<string | null>("notes_canvas_get", { id: canvasKey })
            .then((raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
            .catch(() => null));
        }
        return tokenCache.get(canvasKey)!;
      };
      for (const row of rows) {
        const submission = row.submission as CardSubmission | undefined;
        if (!submission) continue;
        const source = (row.source ?? null) as { kind?: string; token?: string; mime?: string; editableId?: string } | null;
        let token = source?.kind === "file" && typeof source.token === "string" ? source.token : null;
        const adapter = String(row.adapter ?? "");
        const canvasKey = String(row.canvas ?? "");
        const cardId = String(row.card ?? "");
        if (!token && (adapter === "image" || adapter === "audio" || adapter === "video" || adapter === "pdf")) {
          const doc = await canvasDoc(canvasKey);
          const card = ((doc?.cards ?? []) as Record<string, unknown>[]).find((entry) => entry.id === cardId);
          const cardSource = card?.source as { kind?: string; token?: string } | undefined;
          if (cardSource?.kind === "file" && typeof cardSource.token === "string") token = cardSource.token;
        }
        const pty = String(row.session_id ?? "");
        items.push({
          key: `${canvasKey}|${cardId}`,
          cardId,
          canvasKey,
          sessionId: pty,
          sessionLabel: pty.slice(0, 8),
          canvasTitle: String(row.canvasTitle ?? ""),
          title: String(row.title ?? ""),
          kind: String(row.kind ?? ""),
          adapter,
          mime: String(source?.mime ?? ""),
          fileToken: token,
          editableId: typeof source?.editableId === "string" ? source.editableId : null,
          submission,
        });
      }
    } else {
      // 桥兜底(逐画布 get)
      const keys = await invokeCommand<string[]>("notes_canvas_keys", {});
      for (const key of keys || []) {
        const raw = await invokeCommand<string | null>("notes_canvas_get", { id: key });
        if (!raw) continue;
        let doc: Record<string, unknown>;
        try { doc = JSON.parse(raw); } catch { continue; }
        let pty = key;
        try {
          const decoded = atob(key.slice("session-".length).replace(/-/g, "+").replace(/_/g, "/"));
          if (decoded.startsWith("external:")) pty = decoded.slice("external:".length);
        } catch { /* 保留原 key */ }
        for (const card of (doc.cards as Record<string, unknown>[] | undefined) ?? []) {
          const submission = card.submission as CardSubmission | undefined;
          if (!submission || card.kind === "group") continue;
          const source = card.source as { kind?: string; token?: string; mime?: string; editableId?: string } | undefined;
          items.push({
            key: `${key}|${String(card.id)}`,
            cardId: String(card.id),
            canvasKey: key,
            sessionId: pty,
            sessionLabel: pty.slice(0, 8),
            canvasTitle: typeof doc.title === "string" ? doc.title : "",
            title: String(card.title ?? ""),
            kind: String(card.kind ?? ""),
            adapter: String(card.adapter ?? ""),
            mime: String(source?.mime ?? ""),
            fileToken: card.kind === "material" && source?.kind === "file" && typeof source.token === "string" ? source.token : null,
            editableId: typeof source?.editableId === "string" ? source.editableId : null,
            submission,
          });
        }
      }
    }
    items.sort((a, b) => String(b.submission.submittedAt).localeCompare(String(a.submission.submittedAt)));
    setGlobalReviewItems(items);
  }, [invokeCommand]);

  useEffect(() => {
    if (view === "review" && reviewScope === "global") void loadGlobalReview();
  }, [view, reviewScope, loadGlobalReview]);

  const openReviewItem = useCallback((item: ReviewItemData) => {
    if (item.canvasKey === storageId) {
      focusCardOnCanvas(item.cardId);
    } else {
      window.open(`/lofa/overlay/app/?session_id=${encodeURIComponent(item.sessionId)}&focus=${encodeURIComponent(item.cardId)}`, "_blank", "noopener");
    }
  }, [storageId, focusCardOnCanvas]);

  // 裁决: 本画布走 verdictCard; 外部画布写回【该卡所属源画布】(head 取 revision → 对该 key mutate)
  const verdictReviewItem = useCallback(async (item: ReviewItemData, pass: boolean, reason?: string) => {
    if (item.canvasKey === storageId) {
      verdictCard(item.cardId, pass, reason);
      return;
    }
    const head = await invokeCommand<CanvasHead | null>("notes_canvas_head", { id: item.canvasKey });
    const raw = await invokeCommand<string | null>("notes_canvas_get", { id: item.canvasKey });
    const doc = raw ? JSON.parse(raw) : null;
    const cards = (doc?.cards ?? []) as Record<string, unknown>[];
    const card = cards.find((entry) => entry.id === item.cardId);
    if (!doc || !card || typeof card.submission !== "object" || !card.submission) return;
    card.submission = {
      ...(card.submission as Record<string, unknown>),
      state: pass ? "fully-passed" : "not-fully-passed",
      verdictAt: new Date().toISOString(),
      verdictBy: `browser:${session.id}`,
      ...(reason ? { reason } : {}),
    };
    await invokeCommand("notes_canvas_mutate", {
      id: item.canvasKey,
      session_id: doc.sessionId ?? `external:${item.sessionId}`,
      mutation_id: safeRandomId("web-review-"),
      actor: `browser:${session.id}`,
      workspace_ref: { kind: "note-session", ref: doc.sessionId ?? `external:${item.sessionId}` },
      actor_ref: { kind: "browser", ref: session.id },
      base_revision: head?.revision ?? (typeof doc.revision === "number" ? doc.revision : 0),
      patch: { upsert_cards: [card] },
    });
    await loadGlobalReview();
  }, [storageId, verdictCard, invokeCommand, session.id, loadGlobalReview]);

  // 保存失败(409 真冲突等)的两个恢复动作:
  // 「加载外部版本」放弃本地脏数据直接吃服务端最新; 「保留本地重试」把基线换成服务端最新,
  // 让 writeDocument 的 diff 以新 base 重放成本地 mutation——实体仍冲突则保持 error 并展示冲突清单。
  const reloadExternalVersion = useCallback(async () => {
    try {
      const raw = await invokeCommand<string | null>("notes_canvas_get", { id: storageId });
      applyDocument(parseCanvasDocument(raw, session.id));
      setSaveErrorDetail("");
    } catch (reason) {
      setSaveState("error");
      setSaveErrorDetail(String(reason).slice(0, 300));
    }
  }, [invokeCommand, applyDocument, session.id, storageId]);

  const retryKeepLocal = useCallback(async () => {
    try {
      const raw = await invokeCommand<string | null>("notes_canvas_get", { id: storageId });
      const canonical = parseCanvasDocument(raw, session.id);
      if (!canonical) throw new Error("服务端返回了无效画布文档");
      baseDocument.current = canonical;
      baseRevision.current = canonical.revision;
      setCanvasRevision(canonical.revision);
      setLastMutation(canonical.lastMutation);
      setSaveErrorDetail("");
      writeDocument(nodesRef.current, edgesRef.current); // diff(新基线, 本地) → mutate 重放
    } catch (reason) {
      setSaveState("error");
      setSaveErrorDetail(String(reason).slice(0, 300));
    }
  }, [invokeCommand, session.id, storageId, writeDocument]);

  // ---- 批量选择 / 编组 ----
  const [selection, setSelection] = useState<{ cards: number; groups: number }>({ cards: 0, groups: 0 });

  // 组合: 选中 ≥2 张未编组卡 → 新建组卡(尺寸=包围盒+padding), 子卡 parentId=组、坐标转相对
  const groupSelection = useCallback(() => {
    // M2 组套组: 允许选中已存在的组卡作为成员(新建组没有祖先, 嵌套天然无环);
    // 只圈顶层卡(组内卡先挪出再编); 同一棵子树被重复圈选时只保留最祖先那张
    const selected = nodesRef.current.filter((node) => node.selected && !node.parentId);
    const selectedIds = new Set(selected.map((node) => node.id));
    const byId = new Map(nodesRef.current.map((node) => [node.id, node]));
    const hasSelectedAncestor = (node: CanvasNode): boolean => {
      let cursor = node.parentId;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        if (selectedIds.has(cursor)) return true;
        cursor = byId.get(cursor)?.parentId;
      }
      return false;
    };
    const picked = selected.filter((node) => !hasSelectedAncestor(node));
    if (picked.length < 2) return;
    pushHistory();
    const PAD = 28;
    const HEAD = 34;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of picked) {
      const size = dimensionsOf(node);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + size.width);
      maxY = Math.max(maxY, node.position.y + size.height);
    }
    const gid = safeRandomId("group-");
    const gx = minX - PAD;
    const gy = minY - PAD - HEAD;
    const gw = maxX - minX + PAD * 2;
    const gh = maxY - minY + PAD * 2 + HEAD;
    const groupNode: CanvasNode = {
      id: gid,
      type: "groupCard",
      position: { x: gx, y: gy },
      style: { width: gw, height: gh },
      data: { id: gid, kind: "group", title: "编组", adapter: "auto", x: gx, y: gy, width: gw, height: gh },
      selected: true,
    };
    const pickedIds = new Set(picked.map((node) => node.id));
    const rest = nodesRef.current.map((node) => {
      if (!pickedIds.has(node.id)) return node;
      return {
        ...node,
        parentId: gid,
        extent: "parent" as const,
        selected: false,
        position: { x: node.position.x - gx, y: node.position.y - gy },
        data: { ...node.data, parentId: gid },
      };
    });
    setGraph(parentsFirst([groupNode, ...rest]), edgesRef.current);
  }, [pushHistory, setGraph]);

  // 取消组合: 只解最外层——子卡(含子组)parentId 上移一层(挂到被解组的父级, 坐标换算到其父坐标系), 删组卡
  const ungroup = useCallback((gid?: string) => {
    const targets = gid
      ? [gid]
      : nodesRef.current.filter((node) => node.selected && node.data.kind === "group").map((node) => node.id);
    if (!targets.length) return;
    pushHistory();
    const byId = new Map(nodesRef.current.map((node) => [node.id, node]));
    const next = nodesRef.current
      .filter((node) => !targets.includes(node.id))
      .map((node) => {
        if (!node.parentId || !targets.includes(node.parentId)) return node;
        const parent = byId.get(node.parentId);
        if (!parent) return node;
        const { parentId: _p, ...restData } = node.data;
        const grandParentId = parent.parentId; // 上移一层: 可能仍是组(嵌套)或 undefined(顶层)
        return {
          ...node,
          parentId: grandParentId,
          extent: grandParentId ? node.extent : undefined,
          // parent.position 相对其父, node.position 相对 parent → 相对祖父(或绝对) = 两者相加
          position: { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y },
          data: grandParentId ? { ...restData, parentId: grandParentId } : restData,
        };
      });
    setGraph(next, edgesRef.current);
  }, [pushHistory, setGraph]);

  // Esc 清空选择(全屏/菜单开着时不抢, 它们的 Esc 有既有语义)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || fullscreenId || menu) return;
      if (!nodesRef.current.some((node) => node.selected) && !edgesRef.current.some((edge) => edge.selected)) return;
      const nextNodes = nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node);
      const nextEdges = edgesRef.current.map((edge) => edge.selected ? { ...edge, selected: false } : edge);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenId, menu]);

  const saveLabel = saveState === "empty" ? "空白 · 未保存"
    : saveState === "dirty" ? "待保存"
      : saveState === "saving" ? "保存中…"
        : saveState === "saved" ? "已保存"
          : "保存失败";
  const fullscreenNode = fullscreenId ? nodes.find((node) => node.id === fullscreenId) : undefined;
  const cardHoverState = useMemo<CardHoverState>(() => ({ id: hoveredCardId, hold: holdCardTools }), [holdCardTools, hoveredCardId]);
  void historyRevision;

  // 右键菜单条目(画布空白/卡片/关系三类); 菜单是后续功能的扩展位
  const menuNode = menu?.kind === "card" ? nodesRef.current.find((node) => node.id === menu.id) : undefined;
  const menuItems: ({ label: string; icon?: React.ReactNode; disabled?: boolean; onSelect: () => void } | "divider")[] = [];
  if (menu?.kind === "pane") {
    menuItems.push(
      { label: "新建文字卡", icon: <FilePlus2 size={14} />, onSelect: () => addTextAt(menu.x, menu.y) },
      { label: "加入材料（链接/文件）…", icon: <Link2 size={14} />, onSelect: () => { setDialog("material"); setSearchError(""); } },
      { label: "接入旧札记…", icon: <FileText size={14} />, onSelect: openLegacy },
      "divider",
      { label: selection.cards >= 2 ? `组合选中的 ${selection.cards} 张卡` : "组合选中卡片", icon: <Group size={14} />, disabled: selection.cards < 2, onSelect: groupSelection },
      "divider",
      { label: "撤销", icon: <Undo2 size={14} />, disabled: !past.current.length, onSelect: undo },
      { label: "重做", icon: <Redo2 size={14} />, disabled: !future.current.length, onSelect: redo },
    );
  } else if (menu?.kind === "card" && menuNode && menuNode.data.kind === "group") {
    menuItems.push(
      { label: "取消组合", icon: <Ungroup size={14} />, onSelect: () => ungroup(menuNode.id) },
      "divider",
      { label: "从画布移除(子卡留下)", icon: <Trash2 size={14} />, onSelect: () => cardActions.removeCard(menuNode.id) },
    );
  } else if (menu?.kind === "card" && menuNode) {
    const cardId = menuNode.id;
    if (menuNode.parentId) {
      menuItems.push(
        { label: "取消所在组合", icon: <Ungroup size={14} />, onSelect: () => ungroup(menuNode.parentId) },
        "divider",
      );
    } else if (selection.cards >= 2) {
      menuItems.push(
        { label: `组合选中的 ${selection.cards} 张卡`, icon: <Group size={14} />, onSelect: groupSelection },
        "divider",
      );
    }
    menuItems.push(
      { label: "复制卡片引用", icon: <Copy size={14} />, onSelect: () => void cardActions.copyCardRef(cardId) },
      { label: `设置阅读顺序${menuNode.data.order !== undefined ? `（当前 ${menuNode.data.order}）` : ""}…`, icon: <Pencil size={14} />, onSelect: () => setCardOrder(cardId) },
      { label: "全屏查看", icon: <Maximize2 size={14} />, onSelect: () => cardActions.toggleFullscreen(cardId) },
    );
    if (menuNode.data.frozen) {
      menuItems.push({ label: "解冻出新卡", icon: <Sun size={14} />, onSelect: () => cardActions.unfreezeCard(cardId) });
    } else if (menuNode.data.kind === "material" && menuNode.data.source?.kind === "link" && menuNode.data.adapter === "web") {
      menuItems.push({ label: "冻结成快照", icon: <Snowflake size={14} />, disabled: freezingId === cardId, onSelect: () => void cardActions.freezeCard(cardId).catch(() => {}) });
    }
    if (reviewEnabled && !menuNode.data.submission) {
      menuItems.push({ label: "提交审阅", icon: <Send size={14} />, onSelect: () => cardActions.submitForReview(cardId) });
    }
    menuItems.push(
      "divider",
      { label: "从画布移除", icon: <Trash2 size={14} />, onSelect: () => cardActions.removeCard(cardId) },
    );
  } else if (menu?.kind === "edge" && menu.id) {
    const edgeId = menu.id;
    const relation = edgesRef.current.find((edge) => edge.id === edgeId);
    const path = relation?.data?.path || "curve";
    const arrow = relation?.data?.arrow || "closed";
    const kind = relation?.data?.kind;
    menuItems.push(
      { label: "编辑关系文字", onSelect: () => relationActions.select(edgeId) },
      "divider",
      { label: `${kind === "continues" ? "✓ " : ""}分类：主线串联(continues)`, onSelect: () => relationActions.update(edgeId, { kind: "continues" }) },
      { label: `${kind === "references" ? "✓ " : ""}分类：旁证(references)`, onSelect: () => relationActions.update(edgeId, { kind: "references" }) },
      { label: `${kind === "derived" ? "✓ " : ""}分类：派生(derived)`, onSelect: () => relationActions.update(edgeId, { kind: "derived" }) },
      { label: `${!kind ? "✓ " : ""}分类：未定`, onSelect: () => relationActions.update(edgeId, { kind: null }) },
      "divider",
      { label: `${path === "curve" ? "✓ " : ""}连线：曲线`, onSelect: () => relationActions.update(edgeId, { path: "curve" }) },
      { label: `${path === "straight" ? "✓ " : ""}连线：直线`, onSelect: () => relationActions.update(edgeId, { path: "straight" }) },
      { label: `${path === "orthogonal" ? "✓ " : ""}连线：折线`, onSelect: () => relationActions.update(edgeId, { path: "orthogonal" }) },
      "divider",
      { label: `${arrow === "closed" ? "✓ " : ""}箭头：实心`, onSelect: () => relationActions.update(edgeId, { arrow: "closed" }) },
      { label: `${arrow === "open" ? "✓ " : ""}箭头：线形`, onSelect: () => relationActions.update(edgeId, { arrow: "open" }) },
      { label: `${arrow === "none" ? "✓ " : ""}箭头：无`, onSelect: () => relationActions.update(edgeId, { arrow: "none" }) },
      "divider",
      { label: "移除这条关系", icon: <Trash2 size={14} />, onSelect: () => removeRelation(edgeId) },
    );
  }

  // 菜单全局关闭: 点别处/滚轮/Esc
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    const onDown = () => {
      // 长按抬指合成的 mousedown 在打开后 500ms 内到达: 忽略, 别让菜单自己关掉自己。
      if (performance.now() - menuOpenedAtRef.current < 500) return;
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("wheel", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("wheel", onDown, true);
    };
  }, [menu]);

  useEffect(() => {
    if (!canvasMenuOpen) return;
    const close = () => setCanvasMenuOpen(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [canvasMenuOpen]);

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
        <RelationActionsContext.Provider value={relationActions}>
        <HoveredCardContext.Provider value={cardHoverState}>
        <SpotlightContext.Provider value={highlightId}>
        <main className="material-notes-workspace" data-material-canvas="ready" data-notes-review={reviewEnabled ? "on" : "off"}>
        <header className="material-canvas-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <button
            className="material-canvas-menu-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={canvasMenuOpen}
            onClick={() => setCanvasMenuOpen((current) => !current)}
          >
            <MenuIcon size={15} />
            <strong title={canvasTitle}>{canvasTitle}</strong>
            <ChevronDown size={14} />
          </button>
          <div className="material-view-switch" role="tablist" aria-label="视图切换">
            <button type="button" role="tab" aria-selected={view === "canvas"} className={view === "canvas" ? "active" : ""} onClick={() => setView("canvas")} title="画布">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" />
                <path d="M7 7.5 10 16M17 7.5 14 16M7.4 6h9.2" />
              </svg>
            </button>
            {reviewEnabled && (
            <button type="button" role="tab" aria-selected={view === "review"} className={view === "review" ? "active" : ""} onClick={() => setView("review")}
              title={nodes.filter((n) => n.data.submission?.state === "unreviewed").length > 0
                ? `审阅（未看 ${nodes.filter((n) => n.data.submission?.state === "unreviewed").length}）` : "审阅"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" />
              </svg>
            </button>
            )}
            <button type="button" role="tab" aria-selected={view === "doc"} className={view === "doc" ? "active" : ""} onClick={() => setView("doc")} title="文档">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M5 5h14M5 10h14M5 15h9M5 20h12" />
              </svg>
            </button>
            {view === "doc" && (
              <button type="button" className="material-outline-toggle" onClick={() => outlineToggleRef.current?.()} title="大纲（显示/隐藏）">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M9 5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4" /><path d="M9 3v18" /><path d="M13 8h6M13 12h6M13 16h4" />
                </svg>
              </button>
            )}
          </div>
          {canvasMenuOpen && (
            <div className="material-canvas-menu" role="menu">
              <label className="material-canvas-title-field">
                <span>画布名</span>
                <input
                  className="material-canvas-name"
                  value={canvasTitle}
                  onChange={(event) => {
                    canvasTitleRef.current = event.target.value;
                    setCanvasTitle(event.target.value);
                  }}
                  onBlur={commitTitle}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  }}
                  aria-label="画布名（可改，自动保存）"
                />
              </label>
              <small title={lastMutation ? `${lastMutation.actor} · ${lastMutation.at}` : undefined}>
                r{canvasRevision} · {nodes.length} 卡 · {edges.length} 边 · {saveLabel}
              </small>
              <div className="material-canvas-zoom-row">
                <label htmlFor="material-canvas-zoom">视野</label>
                <input
                  id="material-canvas-zoom"
                  type="range"
                  min="8"
                  max="220"
                  step="1"
                  value={Math.round(canvasZoom * 100)}
                  aria-label="画布缩放比例"
                  onChange={(event) => {
                    const zoom = Number(event.currentTarget.value) / 100;
                    setCanvasZoom(zoom);
                    markProgrammaticMove();
                    void flowRef.current?.zoomTo(zoom, { duration: 0 });
                  }}
                />
                <output htmlFor="material-canvas-zoom">{Math.round(canvasZoom * 100)}%</output>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCanvasMenuOpen(false);
                  markProgrammaticMove();
                  const flow = flowRef.current;
                  if (!flow) return;
                  void flow.fitView({ padding: 0.1, maxZoom: 1, duration: 220 }).then(() => {
                    setCanvasZoom(flow.getViewport().zoom);
                  });
                }}
              >
                <Minimize2 size={15} /><span>显示全部</span>
              </button>
              <div className="material-context-divider" />
              <button
                type="button"
                disabled={layoutState === "running"}
                onClick={() => {
                  setCanvasMenuOpen(false);
                  void runAutoLayout();
                }}
              >
                {layoutState === "running" ? <Loader2 className="spin" size={15} /> : <LayoutGrid size={15} />}
                <span>{layoutState === "error" ? "排布失败，请重试" : layoutState === "running" ? "正在排布…" : "智能排布"}</span>
              </button>
              <button type="button" onClick={copyCanvasLink}>
                <Link2 size={15} /><span>{linkFeedback || "复制画布链接"}</span>
              </button>
            </div>
          )}
          {saveState === "error" && (
            <div className="material-save-recovery" role="alert">
              <span className="material-save-recovery-text" title={saveErrorDetail || undefined}>保存失败</span>
              <button type="button" onClick={() => void reloadExternalVersion()} title="放弃本地未保存改动，载入服务端最新版本">
                <RotateCcw size={14} /><span>加载外部版本</span>
              </button>
              <button type="button" onClick={() => void retryKeepLocal()} title={saveErrorDetail ? `冲突详情: ${saveErrorDetail}` : "以服务端最新为基线重放本地改动；仍冲突会列出冲突卡"}>
                <Redo2 size={14} /><span>保留本地重试</span>
              </button>
            </div>
          )}
        </header>
        <section
          className="material-canvas-stage"
          ref={stageRef}
          hidden={view !== "canvas"}
          onPointerDownCapture={onStagePointerDown}
          onPointerMoveCapture={onStagePointerMove}
          onPointerUpCapture={clearPaneHold}
          onPointerCancelCapture={clearPaneHold}
        >
          <ReactFlow<CanvasNode, CanvasEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(instance) => {
              flowRef.current = instance;
              // 初始 fitView 落定后记录稳定视口(首段用户手势的撤销 pre)
              window.setTimeout(() => {
                stableViewport.current = instance.getViewport();
                setCanvasZoom(instance.getViewport().zoom);
              }, 350);
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeMouseEnter={(_event, node) => holdCardTools(node.id, true)}
            onNodeMouseLeave={(_event, node) => holdCardTools(node.id, false)}
            onNodeClick={(_event, node) => {
              setFocusedCardId((current) => current && current !== node.id ? null : current);
              const nextNodes = nodesRef.current.map((item) => ({ ...item, selected: item.id === node.id }));
              const nextEdges = edgesRef.current.map((edge) => edge.selected ? { ...edge, selected: false } : edge);
              nodesRef.current = nextNodes;
              edgesRef.current = nextEdges;
              setNodes(nextNodes);
              setEdges(nextEdges);
            }}
            onEdgeClick={(_event, edge) => {
              setFocusedCardId(null);
              relationActions.select(edge.id);
            }}
            onNodeDragStart={() => {
              setFocusedCardId(null);
              dragSnapshot.current = snapshotOf(nodesRef.current, edgesRef.current);
            }}
            onNodeDragStop={() => {
              if (dragSnapshot.current) pushHistory(dragSnapshot.current);
              dragSnapshot.current = null;
              writeDocument(nodesRef.current, edgesRef.current);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              setCanvasMenuOpen(false);
              setMenu({ x: event.clientX, y: event.clientY, kind: "pane" });
            }}
            onPaneClick={() => {
              setCanvasMenuOpen(false);
              setFocusedCardId(null);
              setEditingRelationId(null);
            }}
            onMoveEnd={(_event, vp) => {
              // 手势结束: pre 视口=上一段手势结束时的稳定值(onMoveStart 在 wheel 平移下拿到的是移动后的值, 不能用)
              const current = vp ?? flowRef.current?.getViewport() ?? null;
              if (current) setCanvasZoom(current.zoom);
              const pre = stableViewport.current;
              stableViewport.current = current;
              moveSnapshot.current = null;
              if (skipMoveHistory.current || !pre || !current) return;
              if (pre.x === current.x && pre.y === current.y && pre.zoom === current.zoom) return;
              past.current.push(snapshotOf(nodesRef.current, edgesRef.current, pre));
              if (past.current.length > 100) past.current.shift();
              future.current = [];
              refreshHistory();
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setCanvasMenuOpen(false);
              setMenu({ x: event.clientX, y: event.clientY, kind: "card", id: node.id });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setCanvasMenuOpen(false);
              setMenu({ x: event.clientX, y: event.clientY, kind: "edge", id: edge.id });
            }}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
            minZoom={0.08}
            maxZoom={2.2}
            zoomOnDoubleClick={false}
            zoomOnPinch
            panOnScroll
            selectionOnDrag
            panOnDrag={[1, 2]}
            multiSelectionKeyCode={["Shift", "Control", "Meta"]}
            onSelectionChange={({ nodes: picked }) => setSelection({
              cards: picked.filter((node) => node.data?.kind !== "group" && !node.parentId).length,
              groups: picked.filter((node) => node.data?.kind === "group").length,
            })}
            deleteKeyCode={null}
            nodesConnectable
            connectionMode={ConnectionMode.Loose}
            nodesDraggable
            edgesFocusable
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => {
                const kind = (node as CanvasNode).data?.kind;
                // 蓝图 token 字面档(JS 侧无法引 var): --fp-text-3 / --fp-link / --fp-ok
                return kind === "group" ? "#6e8cb8" : kind === "text" ? "#6fa8ff" : "#7fd4a8";
              }}
            />
          </ReactFlow>
        </section>

        {reviewEnabled && view === "review" && (
          <section className="material-review-view">
            <ReviewPanel
              scope={reviewScope}
              onScopeChange={setReviewScope}
              items={reviewScope === "session" ? sessionReviewItems : globalReviewItems}
              currentCanvasKey={storageId}
              onOpenCard={openReviewItem}
              onVerdict={(item, pass, reason) => void verdictReviewItem(item, pass, reason)}
              fetchText={docFetchText}
            />
          </section>
        )}
        {view === "doc" && (
          <section className="material-review-view">
            <MaterialDocView
              cards={docCards}
              relations={docRelations}
              fetchText={docFetchText}
              putText={docPutText}
              mutate={docMutate}
              imageUrl={streamUrl}
              registerOutlineToggle={(fn) => { outlineToggleRef.current = fn; }}
            />
          </section>
        )}

        {menu && menuItems.length > 0 && (
          <div
            className="material-context-menu"
            data-testid="material-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {menuItems.map((item, index) => item === "divider"
              ? <div key={`d${index}`} className="material-context-divider" />
              : (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => { setMenu(null); item.onSelect(); }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
          </div>
        )}

        {fullscreenNode && (          <div className="material-fullscreen-layer" data-testid="material-fullscreen">
            <header className="material-fullscreen-bar">
              {fullscreenNode.data.kind === "text" ? <FileText size={15} /> : <Link2 size={15} />}
              <strong title={fullscreenNode.data.title}>{fullscreenNode.data.title}</strong>
              <small>
                {fullscreenNode.data.kind === "text"
                  ? "文字"
                  : fullscreenNode.data.source?.kind === "legacy-note" ? "旧札记 · 只读" : "材料"}
              </small>
              <button type="button" title="退出全屏（Esc）" onClick={exitFullscreen}>
                <Minimize2 size={15} />退出全屏
              </button>
            </header>
            {reviewEnabled && fullscreenNode.data.submission && (
              <SubmissionVerdictBar
                submission={fullscreenNode.data.submission}
                onVerdict={(pass, reason) => verdictCard(fullscreenNode.id, pass, reason)}
              />
            )}
            <div className="material-fullscreen-body">
              {fullscreenNode.data.kind === "text"
                ? <EditableText id={fullscreenNode.id} data={fullscreenNode.data} actions={cardActions} />
                : <MaterialBody data={fullscreenNode.data} hd />}
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

        {groupBodyEdit && (
          <CanvasDialog title="组描述（正文存 materials 分居链）" onClose={() => setGroupBodyEdit(null)}>
            <textarea
              className="material-group-body-editor"
              value={groupBodyEdit.text}
              disabled={groupBodyEdit.loading}
              placeholder={groupBodyEdit.loading ? "读取中…" : "写在组标题下的引言段…"}
              onChange={(event) => setGroupBodyEdit({ ...groupBodyEdit, text: event.currentTarget.value })}
              onKeyDown={(event) => event.stopPropagation()}
            />
            <div className="material-dialog-actions">
              <button type="button" disabled={groupBodyEdit.loading} onClick={() => void saveGroupBody()}>保存</button>
              <button type="button" onClick={() => setGroupBodyEdit(null)}>取消</button>
            </div>
          </CanvasDialog>
        )}
        </main>
        </SpotlightContext.Provider>
        </HoveredCardContext.Provider>
        </RelationActionsContext.Provider>
      </CardActionsContext.Provider>
    </InvokeContext.Provider>
  );
}
