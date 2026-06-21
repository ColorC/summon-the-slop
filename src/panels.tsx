import { useEffect, useRef, useState, type ReactNode, type PointerEvent as RPE } from "react";
import { Pin, PinOff, X, PanelLeft, PanelRight } from "lucide-react";

export type PanelKind = "chat" | "project" | "review" | "notes";

export const PANEL_TITLES: Record<PanelKind, string> = {
  chat: "对话 / 终端",
  project: "项目",
  review: "审阅台",
  notes: "笔记空间",
};

// the panel stage sits between the top search bar and the bottom action bar
const TOP = 84;
const BOTTOM = 84;
const SNAP = 30; // drop within this many px of an edge → dock to that sidebar
const MIN_W = 300;
const MIN_H = 180;

interface Geom {
  x: number;
  y: number;
  width: number;
  height: number;
}
const gkey = (k: PanelKind) => `poof-panel-${k}-geom`;

function loadGeom(k: PanelKind): Geom | null {
  try {
    const v = localStorage.getItem(gkey(k));
    return v ? (JSON.parse(v) as Geom) : null;
  } catch {
    return null;
  }
}
function stageSize() {
  return { w: window.innerWidth, h: Math.max(240, window.innerHeight - TOP - BOTTOM) };
}
function panelWidth(k: PanelKind) {
  const W = window.innerWidth;
  return k === "chat" ? Math.min(660, Math.round(W * 0.42)) : Math.min(820, Math.round(W * 0.52));
}
function dockGeom(k: PanelKind, side: "left" | "right"): Geom {
  const { w: W, h } = stageSize();
  const w = panelWidth(k);
  return { x: side === "left" ? 8 : Math.max(8, W - w - 12), y: 0, width: w, height: h };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
type Dir = "e" | "w" | "s" | "n" | "se" | "sw" | "ne" | "nw";
const HANDLES: Dir[] = ["e", "w", "s", "n", "se", "sw", "ne", "nw"];

/** Draggable + resizable panel — pure pointer-events (React 19 native). We do NOT use
 *  react-rnd: its react-draggable dep calls ReactDOM.findDOMNode, which React 19 removed,
 *  so drag/resize silently threw. Position is via left/top (no CSS transform → safe to
 *  host coordinate-sensitive content). */
export function PanelFrame({
  kind,
  pinned,
  onPin,
  onClose,
  children,
}: {
  kind: PanelKind;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [geom, setGeom] = useState<Geom>(() => loadGeom(kind) ?? dockGeom(kind, "right"));
  const gref = useRef(geom);
  gref.current = geom;
  useEffect(() => {
    localStorage.setItem(gkey(kind), JSON.stringify(geom));
  }, [kind, geom]);

  function startDrag(e: RPE) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pf-panel-acts")) return; // buttons aren't a drag
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const g0 = { ...gref.current };
    const st = stageSize();
    const move = (ev: PointerEvent) => {
      const nx = clamp(g0.x + ev.clientX - sx, 0, Math.max(0, st.w - g0.width));
      const ny = clamp(g0.y + ev.clientY - sy, 0, Math.max(0, st.h - g0.height));
      setGeom({ ...g0, x: nx, y: ny });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const g = gref.current;
      if (g.x <= SNAP) setGeom(dockGeom(kind, "left"));
      else if (g.x + g.width >= st.w - SNAP) setGeom(dockGeom(kind, "right"));
    };
    window.addEventListener("pointermove", move);
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
    const move = (ev: PointerEvent) => {
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
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div
      className="pf-panel"
      style={{ left: geom.x, top: geom.y, width: geom.width, height: geom.height }}
    >
      <div className="pf-panel-inner">
        <div className="pf-panel-head" onPointerDown={startDrag}>
          <span className="pf-panel-title">{PANEL_TITLES[kind]}</span>
          <div className="pf-panel-acts">
            <button onClick={() => setGeom(dockGeom(kind, "left"))} title="停靠到左侧栏">
              <PanelLeft size={15} />
            </button>
            <button onClick={() => setGeom(dockGeom(kind, "right"))} title="停靠到右侧栏">
              <PanelRight size={15} />
            </button>
            <button onClick={onPin} title={pinned ? "取消钉住" : "钉住（召出时保持）"}>
              {pinned ? <Pin size={15} /> : <PinOff size={15} />}
            </button>
            <button onClick={onClose} title="关闭">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="pf-panel-body">{children}</div>
      </div>
      {HANDLES.map((d) => (
        <div
          key={d}
          className={"pf-rz pf-rz-" + d}
          onPointerDown={(e) => startResize(e, d)}
        />
      ))}
    </div>
  );
}
