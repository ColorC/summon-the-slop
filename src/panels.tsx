import { Fragment, useRef, useState, type ReactNode, type PointerEvent as RPE } from "react";
import { Pin, PinOff, X, PanelLeft, PanelRight } from "lucide-react";

export type PanelKind = "chat" | "project" | "review" | "notes";
export type DockSide = "left" | "right";

export const PANEL_TITLES: Record<PanelKind, string> = {
  chat: "对话 / 终端",
  project: "项目",
  review: "审阅台",
  notes: "笔记空间",
};

const MIN_DOCK = 240; // a dock column never narrower than this
const MAX_DOCK_FRAC = 0.66; // …nor wider than this fraction of the window
const MIN_H = 140; // a stacked view never shorter than this

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------- persistence ----------------
const sideKey = (k: PanelKind) => `poof-panel-${k}-side`;
const dockWKey = (s: DockSide) => `poof-dock-${s}-w`;

// VSCode-ish defaults: views on the left, the assistant/terminal on the right.
const DEFAULT_SIDE: Record<PanelKind, DockSide> = {
  project: "left",
  review: "left",
  chat: "right",
  notes: "right",
};

function loadSide(k: PanelKind): DockSide {
  const v = localStorage.getItem(sideKey(k));
  return v === "left" || v === "right" ? v : DEFAULT_SIDE[k];
}
function loadDockW(s: DockSide): number {
  const v = Number(localStorage.getItem(dockWKey(s)));
  return v >= MIN_DOCK ? v : 380;
}

// ============================================================================
//  DockStage — owns the middle band. Every open panel is docked to the left or
//  the right: flush to the window edge, FULL height, square against the edge,
//  with a sash on its inner seam (drag to resize width). Multiple panels on one
//  side stack as views with a height-sash between them. A real sidebar — there
//  is no "floating window" mode; a panel is docked or closed.
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
  side: DockSide;
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

// ---------------- shared header (title + dock controls) ----------------
interface HeadProps {
  kind: PanelKind;
  side: DockSide;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  onMove: (s: DockSide) => void;
}
function PanelHead({ kind, side, pinned, onPin, onClose, onMove }: HeadProps) {
  return (
    <div className="pf-panel-head">
      <span className="pf-panel-title">{PANEL_TITLES[kind]}</span>
      <div className="pf-panel-acts">
        {side === "right" ? (
          <button onClick={() => onMove("left")} title="移到左侧栏">
            <PanelLeft size={15} />
          </button>
        ) : (
          <button onClick={() => onMove("right")} title="移到右侧栏">
            <PanelRight size={15} />
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
