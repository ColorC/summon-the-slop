import { Fragment, useRef, useState, type ReactNode, type PointerEvent as RPE } from "react";
import { Pin, PinOff, X, PanelLeft, PanelRight, PictureInPicture2, PanelBottomClose } from "lucide-react";

export type PanelKind = "chat" | "project" | "review" | "notes" | "goals" | "clips" | "pinned";
export type DockSide = "left" | "right";

export const PANEL_TITLES: Record<PanelKind, string> = {
  chat: "对话 / 终端",
  project: "项目",
  review: "审阅台",
  notes: "笔记空间",
  goals: "目标 / 任务",
  clips: "快选内容（剪贴板 / 快照）",
  pinned: "当前任务",
};

const MIN_DOCK = 240; // a dock column never narrower than this
const MAX_DOCK_FRAC = 0.66; // …nor wider than this fraction of the window
const MIN_H = 140; // a stacked view never shorter than this

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------- persistence ----------------
const sideKey = (k: PanelKind) => `poof-panel-${k}-side`;
const dockWKey = (s: DockSide) => `poof-dock-${s}-w`;
const floatKey = (k: PanelKind) => `poof-panel-${k}-float`;
const geoKey = (k: PanelKind) => `poof-panel-${k}-geo`;

interface Geo { x: number; y: number; w: number; h: number }
function loadFloat(k: PanelKind): boolean {
  return localStorage.getItem(floatKey(k)) === "1";
}
function loadGeo(k: PanelKind, i = 0): Geo {
  try {
    const g = JSON.parse(localStorage.getItem(geoKey(k)) || "null");
    if (g && typeof g.x === "number") return g;
  } catch {}
  const w = 460, h = 420;
  return { x: Math.max(20, (window.innerWidth - w) / 2 + i * 28), y: Math.max(20, (window.innerHeight - h) / 2 + i * 28), w, h };
}

// VSCode-ish defaults: views on the left, the assistant/terminal on the right.
const DEFAULT_SIDE: Record<PanelKind, DockSide> = {
  project: "left",
  review: "left",
  goals: "left",
  pinned: "left",
  chat: "right",
  notes: "right",
  clips: "right",
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
//  PersistentChatDock — the 对话/终端 面板 lives here, ALWAYS mounted, shown/hidden
//  via CSS display. Kept out of DockStage on purpose: DockStage unmounts a panel when
//  it's closed/召出清空, which would tear down the xterm + kill the PTY (TerminalView
//  cleanup 调 ptyKill)。常驻挂载 → 关面板/召出只是隐藏, 对话与终端会话一直保留。
//  代价: 聊天面板不再支持浮动/左右切换, 但换来"永不丢会话"。宽度可拖拽调整并记忆。
// ============================================================================
const chatWKey = () => "poof-chat-dock-w";
function loadChatW(): number {
  const v = Number(localStorage.getItem(chatWKey()));
  return v >= MIN_DOCK ? v : 460;
}

export function PersistentChatDock({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [w, setW] = useState(() => loadChatW());
  const wRef = useRef(w);
  wRef.current = w;

  function startW(e: RPE) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const w0 = wRef.current;
    const max = window.innerWidth * MAX_DOCK_FRAC;
    const mv = (ev: PointerEvent) => setW(clamp(w0 + (sx - ev.clientX), MIN_DOCK, max));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(chatWKey(), String(Math.round(wRef.current)));
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  return (
    <div
      className="pf-dock pf-dock-right pf-chat-dock"
      style={{ width: w, display: open ? "flex" : "none" }}
    >
      <section className="pf-view">
        <div className="pf-panel-head">
          <span className="pf-panel-title">{PANEL_TITLES.chat}</span>
          <div className="pf-panel-acts">
            <button onClick={onClose} title="隐藏（对话 / 终端会话保留）">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="pf-panel-body">{children}</div>
      </section>
      <div className="pf-sash pf-sash-v" onPointerDown={startW} title="拖动调整宽度" />
    </div>
  );
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
  const [floats, setFloats] = useState<Record<string, boolean>>({});
  const sideOf = (k: PanelKind): DockSide => sides[k] ?? loadSide(k);
  const floatOf = (k: PanelKind): boolean => floats[k] ?? loadFloat(k);
  const move = (k: PanelKind, s: DockSide) => {
    localStorage.setItem(sideKey(k), s);
    setSides((p) => ({ ...p, [k]: s }));
  };
  const toggleFloat = (k: PanelKind) => {
    const v = !floatOf(k);
    localStorage.setItem(floatKey(k), v ? "1" : "0");
    setFloats((p) => ({ ...p, [k]: v }));
  };

  const floating = open.filter((k) => floatOf(k));
  const docked = open.filter((k) => !floatOf(k));
  const left = docked.filter((k) => sideOf(k) === "left");
  const right = docked.filter((k) => sideOf(k) === "right");

  const headFor = (k: PanelKind): HeadProps => ({
    kind: k,
    side: sideOf(k),
    floating: floatOf(k),
    pinned: pinned.includes(k),
    onPin: () => onPin(k),
    onClose: () => onClose(k),
    onMove: (s: DockSide) => move(k, s),
    onFloat: () => toggleFloat(k),
  });

  return (
    <div className="pf-stage">
      {left.length > 0 && (
        <Dock side="left" panels={left} headFor={headFor} renderContent={renderContent} />
      )}
      {right.length > 0 && (
        <Dock side="right" panels={right} headFor={headFor} renderContent={renderContent} />
      )}
      {floating.map((k, i) => (
        <FloatingCard key={k} kind={k} idx={i} head={headFor(k)} renderContent={renderContent} />
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
  floating: boolean;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  onMove: (s: DockSide) => void;
  onFloat: () => void;
}
function PanelHead({ kind, side, floating, pinned, onPin, onClose, onMove, onFloat }: HeadProps) {
  return (
    <div className="pf-panel-head">
      <span className="pf-panel-title">{PANEL_TITLES[kind]}</span>
      <div className="pf-panel-acts">
        {floating ? (
          <button onClick={onFloat} title="停靠回侧栏">
            <PanelBottomClose size={15} />
          </button>
        ) : (
          <>
            {side === "right" ? (
              <button onClick={() => onMove("left")} title="移到左侧栏">
                <PanelLeft size={15} />
              </button>
            ) : (
              <button onClick={() => onMove("right")} title="移到右侧栏">
                <PanelRight size={15} />
              </button>
            )}
            <button onClick={onFloat} title="变成浮动窗口">
              <PictureInPicture2 size={15} />
            </button>
          </>
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

// ---------------- a floating card (a panel popped out of the dock into a draggable window) ----
function FloatingCard({
  kind,
  idx,
  head,
  renderContent,
}: {
  kind: PanelKind;
  idx: number;
  head: HeadProps;
  renderContent: (k: PanelKind) => ReactNode;
}) {
  const [geo, setGeo] = useState<Geo>(() => loadGeo(kind, idx));
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const save = () => localStorage.setItem(geoKey(kind), JSON.stringify(geoRef.current));

  function startDrag(e: RPE) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // header buttons keep their own clicks
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, g0 = { ...geoRef.current };
    const mv = (ev: PointerEvent) => {
      setGeo({
        ...geoRef.current,
        x: clamp(g0.x + ev.clientX - sx, 0, window.innerWidth - 80),
        y: clamp(g0.y + ev.clientY - sy, 0, window.innerHeight - 40),
      });
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); save(); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }
  function startResize(e: RPE) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, g0 = { ...geoRef.current };
    const mv = (ev: PointerEvent) => {
      setGeo({
        ...geoRef.current,
        w: clamp(g0.w + ev.clientX - sx, MIN_DOCK, window.innerWidth - g0.x - 8),
        h: clamp(g0.h + ev.clientY - sy, MIN_H, window.innerHeight - g0.y - 8),
      });
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); save(); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="pf-float" style={{ left: geo.x, top: geo.y, width: geo.w, height: geo.h }}>
      <div className="pf-float-grip" onPointerDown={startDrag}>
        <PanelHead {...head} />
      </div>
      <div className="pf-panel-body">{renderContent(kind)}</div>
      <div className="pf-float-resize" onPointerDown={startResize} title="拖动调整大小" />
    </div>
  );
}
