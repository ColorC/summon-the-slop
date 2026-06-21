import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as RPE,
} from "react";
import { Pin, PinOff, X, PanelLeft, PanelRight, AppWindow } from "lucide-react";

export type PanelKind = "chat" | "project" | "review" | "notes";
export type DockSide = "left" | "right" | "float";

export const PANEL_TITLES: Record<PanelKind, string> = {
  chat: "对话 / 终端",
  project: "项目",
  review: "审阅台",
  notes: "笔记空间",
};

const MIN_DOCK = 240; // a dock column never narrower than this
const MAX_DOCK_FRAC = 0.66; // …nor wider than this fraction of the window
const MIN_W = 300; // floating panel mins
const MIN_H = 160;
const FLOAT_SNAP = 30; // drop a floating panel within this of an edge → it docks
const BARS = 168; // top search pill band (84) + bottom action bar band (84)

interface Geom {
  x: number;
  y: number;
  width: number;
  height: number;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function stageSize() {
  return { w: window.innerWidth, h: Math.max(220, window.innerHeight - BARS) };
}

// ---------------- persistence ----------------
const sideKey = (k: PanelKind) => `poof-panel-${k}-side`;
const floatKey = (k: PanelKind) => `poof-panel-${k}-float`;
const dockWKey = (s: "left" | "right") => `poof-dock-${s}-w`;

// VSCode-ish defaults: views on the left, the assistant/terminal on the right.
const DEFAULT_SIDE: Record<PanelKind, DockSide> = {
  project: "left",
  review: "left",
  chat: "right",
  notes: "right",
};

function loadSide(k: PanelKind): DockSide {
  const v = localStorage.getItem(sideKey(k));
  return v === "left" || v === "right" || v === "float" ? v : DEFAULT_SIDE[k];
}
function loadDockW(s: "left" | "right"): number {
  const v = Number(localStorage.getItem(dockWKey(s)));
  return v >= MIN_DOCK ? v : 380;
}
function loadFloat(k: PanelKind): Geom {
  try {
    const v = localStorage.getItem(floatKey(k));
    if (v) return JSON.parse(v) as Geom;
  } catch {
    /* ignore */
  }
  const { w: W, h: H } = stageSize();
  const width = Math.min(720, Math.round(W * 0.5));
  const height = Math.min(560, Math.round(H * 0.78));
  return { x: Math.round((W - width) / 2), y: 24, width, height };
}

// ============================================================================
//  DockStage — owns the whole middle band. Panels live on the left dock, the
//  right dock, or float. A dock is flush to the window edge, full working
//  height, square against the edge, with a sash on its inner seam (drag to
//  resize). Multiple panels on one side stack with sashes between them. This is
//  a real sidebar — not a card parked near the edge.
// ============================================================================
export function DockStage({
  open,
  pinned,
  onPin,
  onClose,
  renderContent,
}: {
  open: PanelKind[];
  pinned: PanelKind[];
  onPin: (k: PanelKind) => void;
  onClose: (k: PanelKind) => void;
  renderContent: (k: PanelKind) => ReactNode;
}) {
  const [sides, setSides] = useState<Record<string, DockSide>>({});
  const sideOf = (k: PanelKind): DockSide => sides[k] ?? loadSide(k);
  const move = (k: PanelKind, s: DockSide) => {
    localStorage.setItem(sideKey(k), s);
    setSides((p) => ({ ...p, [k]: s }));
  };

  const left = open.filter((k) => sideOf(k) === "left");
  const right = open.filter((k) => sideOf(k) === "right");
  const floats = open.filter((k) => sideOf(k) === "float");

  const headFor = (k: PanelKind): HeadProps => ({
    kind: k,
    side: sideOf(k),
    pinned: pinned.includes(k),
    onPin: () => onPin(k),
    onClose: () => onClose(k),
    onMove: (s: DockSide) => move(k, s),
  });

  return (
    <div className="pf-stage">
      {left.length > 0 && (
        <Dock side="left" panels={left} headFor={headFor} renderContent={renderContent} />
      )}
      {right.length > 0 && (
        <Dock side="right" panels={right} headFor={headFor} renderContent={renderContent} />
      )}
      {floats.map((k) => (
        <FloatPanel key={k} head={headFor(k)} renderContent={renderContent} />
      ))}
    </div>
  );
}

// ---------------- a docked side (left or right) ----------------
function Dock({
  side,
  panels,
  headFor,
  renderContent,
}: {
  side: "left" | "right";
  panels: PanelKind[];
  headFor: (k: PanelKind) => HeadProps;
  renderContent: (k: PanelKind) => ReactNode;
}) {
  const [w, setW] = useState(() => loadDockW(side));
  const wRef = useRef(w);
  wRef.current = w;
  const ref = useRef<HTMLDivElement>(null);

  // relative flex weights for the stacked panels; reset to equal when count changes
  const [ratios, setRatios] = useState<number[]>(() => panels.map(() => 1));
  if (ratios.length !== panels.length) setRatios(panels.map(() => 1));

  function startW(e: RPE) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const w0 = wRef.current;
    const max = window.innerWidth * MAX_DOCK_FRAC;
    const mv = (ev: PointerEvent) => {
      const d = side === "left" ? ev.clientX - sx : sx - ev.clientX;
      setW(clamp(w0 + d, MIN_DOCK, max));
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(dockWKey(side), String(Math.round(wRef.current)));
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  // resize the seam between stacked panel i and i+1
  function startH(e: RPE, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const H = ref.current?.clientHeight ?? 1;
    const totalFlex = ratios.reduce((a, b) => a + b, 0);
    const pxPerFlex = H / totalFlex;
    const minFlex = MIN_H / pxPerFlex;
    const r0 = [...ratios];
    const pair = r0[i] + r0[i + 1];
    const sy = e.clientY;
    const mv = (ev: PointerEvent) => {
      const dFlex = (ev.clientY - sy) / pxPerFlex;
      const a = clamp(r0[i] + dFlex, minFlex, pair - minFlex);
      const nr = [...r0];
      nr[i] = a;
      nr[i + 1] = pair - a;
      setRatios(nr);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className={"pf-dock pf-dock-" + side} style={{ width: w }} ref={ref}>
      {panels.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && (
            <div className="pf-sash pf-sash-h" onPointerDown={(e) => startH(e, i - 1)} />
          )}
          <section className="pf-view" style={{ flex: ratios[i] + " 1 0%" }}>
            <PanelHead {...headFor(k)} />
            <div className="pf-panel-body">{renderContent(k)}</div>
          </section>
        </Fragment>
      ))}
      <div className="pf-sash pf-sash-v" onPointerDown={startW} title="拖动调整宽度" />
    </div>
  );
}

// ---------------- a floating panel (draggable card) ----------------
function FloatPanel({
  head,
  renderContent,
}: {
  head: HeadProps;
  renderContent: (k: PanelKind) => ReactNode;
}) {
  const kind = head.kind;
  const [geom, setGeom] = useState<Geom>(() => loadFloat(kind));
  const gref = useRef(geom);
  gref.current = geom;
  useEffect(() => {
    localStorage.setItem(floatKey(kind), JSON.stringify(geom));
  }, [kind, geom]);

  function startDrag(e: RPE) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pf-panel-acts")) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const g0 = { ...gref.current };
    const st = stageSize();
    const mv = (ev: PointerEvent) => {
      const nx = clamp(g0.x + ev.clientX - sx, -g0.width + 80, st.w - 80);
      const ny = clamp(g0.y + ev.clientY - sy, 0, Math.max(0, st.h - 40));
      setGeom({ ...g0, x: nx, y: ny });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      const g = gref.current;
      // drag to an edge → dock there (VSCode dock-on-drop)
      if (g.x <= FLOAT_SNAP) head.onMove("left");
      else if (g.x + g.width >= st.w - FLOAT_SNAP) head.onMove("right");
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  function startResize(e: RPE, dir: Dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const g0 = { ...gref.current };
    const st = stageSize();
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { x, y, width, height } = g0;
      if (dir.includes("e")) width = clamp(g0.width + dx, MIN_W, st.w - g0.x);
      if (dir.includes("s")) height = clamp(g0.height + dy, MIN_H, st.h - g0.y);
      if (dir.includes("w")) {
        width = clamp(g0.width - dx, MIN_W, g0.x + g0.width);
        x = g0.x + g0.width - width;
      }
      if (dir.includes("n")) {
        height = clamp(g0.height - dy, MIN_H, g0.y + g0.height);
        y = g0.y + g0.height - height;
      }
      setGeom({ x, y, width, height });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  return (
    <div
      className="pf-panel"
      style={{ left: geom.x, top: geom.y, width: geom.width, height: geom.height }}
    >
      <div className="pf-panel-inner">
        <PanelHead {...head} draggable onDragStart={startDrag} />
        <div className="pf-panel-body">{renderContent(kind)}</div>
      </div>
      {HANDLES.map((d) => (
        <div key={d} className={"pf-rz pf-rz-" + d} onPointerDown={(e) => startResize(e, d)} />
      ))}
    </div>
  );
}

// ---------------- shared header (title + dock controls) ----------------
interface HeadProps {
  kind: PanelKind;
  side: DockSide;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  onMove: (s: DockSide) => void;
}
function PanelHead({
  kind,
  side,
  pinned,
  onPin,
  onClose,
  onMove,
  draggable,
  onDragStart,
}: HeadProps & { draggable?: boolean; onDragStart?: (e: RPE) => void }) {
  return (
    <div
      className={"pf-panel-head" + (draggable ? " drag" : "")}
      onPointerDown={onDragStart}
    >
      <span className="pf-panel-title">{PANEL_TITLES[kind]}</span>
      <div className="pf-panel-acts">
        {side !== "left" && (
          <button onClick={() => onMove("left")} title="停靠到左侧栏">
            <PanelLeft size={15} />
          </button>
        )}
        {side !== "right" && (
          <button onClick={() => onMove("right")} title="停靠到右侧栏">
            <PanelRight size={15} />
          </button>
        )}
        {side !== "float" && (
          <button onClick={() => onMove("float")} title="浮动窗口">
            <AppWindow size={15} />
          </button>
        )}
        <button onClick={onPin} title={pinned ? "取消钉住" : "钉住（召出时保持）"}>
          {pinned ? <Pin size={15} /> : <PinOff size={15} />}
        </button>
        <button onClick={onClose} title="关闭">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

type Dir = "e" | "w" | "s" | "n" | "se" | "sw" | "ne" | "nw";
const HANDLES: Dir[] = ["e", "w", "s", "n", "se", "sw", "ne", "nw"];
