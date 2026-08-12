import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  applyNodeChanges,
  useViewport,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { FileText, Redo2, Undo2 } from "lucide-react";
import "@xyflow/react/dist/style.css";

export interface SessionNoteCard {
  id: string;
  title: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  editable: boolean;
  detail?: string;
}

export interface CardGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NoteCardData extends Record<string, unknown> {
  title: string;
  text: string;
  editable: boolean;
  detail?: string;
  draft: boolean;
  persistedId?: string;
  onInput: (id: string, value: string) => void;
  onResizePointerDown: (
    id: string,
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLDivElement>
  ) => void;
  onOpenCompatibility: () => void;
}

type NoteFlowNode = Node<NoteCardData, "noteCard">;
type ResizeDirection =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const RESIZE_DIRECTIONS: ResizeDirection[] = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
];
const MIN_CARD_WIDTH = 260;
const MIN_CARD_HEIGHT = 180;

const NoteCard = memo(function NoteCard({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { zoom } = useViewport();
  return (
    <>
      {selected && RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`session-note-resize-control nodrag nopan ${direction}`}
          data-resize-direction={direction}
          aria-label={`调整札记尺寸：${direction}`}
          style={{ scale: `${1 / Math.max(zoom, 0.01)}` }}
          onPointerDown={(event) =>
            data.onResizePointerDown(data.persistedId || id, direction, event)}
        />
      ))}
      <article className={"session-note-card" + (selected ? " selected" : "")}>
        <header className="session-note-card-handle">
          <FileText size={14} />
          <span>{data.title}</span>
          {data.draft && <small>临时</small>}
        </header>
        {data.editable ? (
          <textarea
            className="session-note-editor nodrag nopan nowheel"
            defaultValue={data.text}
            placeholder="写点什么……首次输入后才保存"
            spellCheck
            onInput={(event) => data.onInput(data.persistedId || id, event.currentTarget.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          />
        ) : (
          <div className="session-note-compat nodrag nopan nowheel">
            <pre>{data.text || "这张旧札记含有富文本、附件或其他内容块。"}</pre>
            <small>{data.detail}</small>
            <button type="button" onClick={data.onOpenCompatibility}>
              用兼容写作视图打开
            </button>
          </div>
        )}
      </article>
    </>
  );
});

const nodeTypes = { noteCard: NoteCard };

function geometryOf(node: NoteFlowNode): CardGeometry {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? (Number(node.style?.width) || 420),
    height: node.measured?.height ?? node.height ?? (Number(node.style?.height) || 320),
  };
}

function geometrySnapshot(nodes: NoteFlowNode[]): Map<string, CardGeometry> {
  return new Map(nodes.map((node) => [node.id, geometryOf(node)]));
}

function restoreGeometry(nodes: NoteFlowNode[], snapshot: Map<string, CardGeometry>): NoteFlowNode[] {
  return nodes.map((node) => {
    const geometry = snapshot.get(node.id);
    if (!geometry) return node;
    return {
      ...node,
      position: { x: geometry.x, y: geometry.y },
      width: geometry.width,
      height: geometry.height,
      style: { ...node.style, width: geometry.width, height: geometry.height },
    };
  });
}

export function resizeGeometry(
  start: CardGeometry,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number
): CardGeometry {
  const fromLeft = direction.includes("left");
  const fromRight = direction.includes("right");
  const fromTop = direction.includes("top");
  const fromBottom = direction.includes("bottom");
  const width = fromLeft
    ? Math.max(MIN_CARD_WIDTH, start.width - deltaX)
    : fromRight
      ? Math.max(MIN_CARD_WIDTH, start.width + deltaX)
      : start.width;
  const height = fromTop
    ? Math.max(MIN_CARD_HEIGHT, start.height - deltaY)
    : fromBottom
      ? Math.max(MIN_CARD_HEIGHT, start.height + deltaY)
      : start.height;
  return {
    x: fromLeft ? start.x + start.width - width : start.x,
    y: fromTop ? start.y + start.height - height : start.y,
    width,
    height,
  };
}

export function SessionNotesCanvas({
  documentKey,
  draftTitle,
  cards,
  onDraftContent,
  onCardText,
  onCardGeometry,
  onOpenCompatibility,
}: {
  documentKey: string;
  draftTitle: string;
  cards: SessionNoteCard[];
  onDraftContent: (text: string, geometry: CardGeometry) => void;
  onCardText: (id: string, text: string) => void;
  onCardGeometry: (id: string, geometry: CardGeometry) => void;
  onOpenCompatibility: () => void;
}) {
  const [nodes, setNodes] = useState<NoteFlowNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const past = useRef<Array<Map<string, CardGeometry>>>([]);
  const future = useRef<Array<Map<string, CardGeometry>>>([]);
  const [historyRevision, setHistoryRevision] = useState(0);

  const refreshHistory = () => setHistoryRevision((value) => value + 1);
  const captureBeforeGeometryChange = useCallback(() => {
    past.current.push(geometrySnapshot(nodesRef.current));
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    refreshHistory();
  }, []);

  const persistAllGeometry = useCallback(
    (next: NoteFlowNode[]) => {
      for (const node of next) {
        onCardGeometry(node.data.persistedId || node.id, geometryOf(node));
      }
    },
    [onCardGeometry]
  );

  const undoGeometry = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(geometrySnapshot(nodesRef.current));
    const next = restoreGeometry(nodesRef.current, previous);
    nodesRef.current = next;
    setNodes(next);
    persistAllGeometry(next);
    refreshHistory();
  }, [persistAllGeometry]);

  const redoGeometry = useCallback(() => {
    const following = future.current.pop();
    if (!following) return;
    past.current.push(geometrySnapshot(nodesRef.current));
    const next = restoreGeometry(nodesRef.current, following);
    nodesRef.current = next;
    setNodes(next);
    persistAllGeometry(next);
    refreshHistory();
  }, [persistAllGeometry]);

  const onInput = useCallback(
    (id: string, value: string) => {
      if (id.startsWith("draft:")) {
        if (!value.trim()) return;
        const node = nodesRef.current.find((item) => item.id === id);
        if (node) onDraftContent(value, geometryOf(node));
        return;
      }
      onCardText(id, value);
    },
    [onCardText, onDraftContent]
  );

  const onResizePointerDown = useCallback(
    (
      id: string,
      direction: ResizeDirection,
      event: ReactPointerEvent<HTMLDivElement>
    ) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const node = nodesRef.current.find(
        (item) => item.id === id || item.data.persistedId === id
      );
      if (!node) return;

      captureBeforeGeometryChange();
      const start = geometryOf(node);
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let lastClientX = startClientX;
      let lastClientY = startClientY;
      let animationFrame = 0;
      let latest = start;
      const viewport = target.closest(".react-flow")?.querySelector<HTMLElement>(
        ".react-flow__viewport"
      );
      const transform = viewport ? getComputedStyle(viewport).transform : "none";
      const zoom = transform === "none" ? 1 : Math.max(0.01, new DOMMatrix(transform).a || 1);

      const render = () => {
        animationFrame = 0;
        latest = resizeGeometry(
          start,
          direction,
          (lastClientX - startClientX) / zoom,
          (lastClientY - startClientY) / zoom
        );
        const next = nodesRef.current.map((item) => {
          if (item.id !== node.id) return item;
          return {
            ...item,
            position: { x: latest.x, y: latest.y },
            width: latest.width,
            height: latest.height,
            style: { ...item.style, width: latest.width, height: latest.height },
          };
        });
        nodesRef.current = next;
        setNodes(next);
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        lastClientX = next.clientX;
        lastClientY = next.clientY;
        if (!animationFrame) animationFrame = window.requestAnimationFrame(render);
      };
      const finish = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        lastClientX = next.clientX;
        lastClientY = next.clientY;
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        render();
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
        onCardGeometry(id, latest);
        refreshHistory();
      };

      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
      try { target.setPointerCapture(pointerId); } catch { /* old WebView */ }
    },
    [captureBeforeGeometryChange, onCardGeometry]
  );

  useEffect(() => {
    // 首字输入会把内存草稿物化成持久文档。保留原 React Flow node id，textarea
    // DOM 就不会被替换，焦点和原生文字撤销栈也能连续保留。
    const draftNodeId = nodesRef.current.find((node) => node.data.draft)?.id;
    const source = cards.length
      ? cards
      : [
          {
            id: `draft:${documentKey}`,
            title: draftTitle,
            text: "",
            x: 80,
            y: 72,
            width: 420,
            height: 320,
            editable: true,
          },
        ];
    const next: NoteFlowNode[] = source.map((card, index) => ({
      id: cards.length && index === 0 && draftNodeId ? draftNodeId : card.id,
      type: "noteCard",
      position: { x: card.x, y: card.y },
      width: card.width,
      height: card.height,
      style: { width: card.width, height: card.height },
      dragHandle: ".session-note-card-handle",
      deletable: false,
      data: {
        title: card.title,
        text: card.text,
        editable: card.editable,
        detail: card.detail,
        draft: !cards.length,
        persistedId: cards.length ? card.id : undefined,
        onInput,
        onResizePointerDown,
        onOpenCompatibility,
      },
    }));
    nodesRef.current = next;
    setNodes(next);
    past.current = [];
    future.current = [];
    refreshHistory();
  }, [documentKey]);

  const onNodesChange = useCallback((changes: NodeChange<NoteFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const status = cards.length ? "已保存" : "临时空札记 · 有内容后保存";
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  void historyRevision;

  const proOptions = useMemo(() => ({ hideAttribution: true }), []);

  return (
    <div
      className="session-notes-canvas"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
        if ((event.target as HTMLElement).closest("textarea,input,[contenteditable=true]")) return;
        event.preventDefault();
        event.shiftKey ? redoGeometry() : undoGeometry();
      }}
    >
      <ReactFlow<NoteFlowNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={captureBeforeGeometryChange}
        onNodeDragStop={(_event, node) =>
          onCardGeometry(node.data.persistedId || node.id, geometryOf(node))
        }
        deleteKeyCode={null}
        nodesConnectable={false}
        edgesFocusable={false}
        onlyRenderVisibleElements
        minZoom={0.25}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        proOptions={proOptions}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(164,177,199,.18)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      <div className="session-flow-toolbar" role="status">
        <span className={cards.length ? "saved" : "draft"}>{status}</span>
        <button type="button" title="撤销画布移动/缩放" disabled={!canUndo} onClick={undoGeometry}>
          <Undo2 size={14} />
        </button>
        <button type="button" title="重做画布移动/缩放" disabled={!canRedo} onClick={redoGeometry}>
          <Redo2 size={14} />
        </button>
      </div>
    </div>
  );
}
