import { useEffect, useState, type ReactNode } from "react";
import { Rnd } from "react-rnd";
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
const SNAP = 28; // drag within this many px of an edge → dock to that sidebar

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

function panelWidth(k: PanelKind): number {
  const W = window.innerWidth;
  return k === "chat" ? Math.min(660, Math.round(W * 0.42)) : Math.min(820, Math.round(W * 0.52));
}

/** docked to the left or right edge of the stage, full band height */
function dockGeom(k: PanelKind, side: "left" | "right"): Geom {
  const W = window.innerWidth;
  const bandH = Math.max(240, window.innerHeight - TOP - BOTTOM);
  const w = panelWidth(k);
  const x = side === "left" ? 8 : Math.max(8, W - w - 12);
  return { x, y: 0, width: w, height: bandH };
}

/** A draggable + resizable panel that remembers its geometry per kind. Default docks
 *  right; drag the header to float it; dock-left / dock-right buttons snap to a sidebar;
 *  dragging near a screen edge auto-snaps to that sidebar. */
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
  useEffect(() => {
    localStorage.setItem(gkey(kind), JSON.stringify(geom));
  }, [kind, geom]);

  function onDragStop(x: number, y: number) {
    const W = window.innerWidth;
    if (x <= SNAP) setGeom(dockGeom(kind, "left"));
    else if (x + geom.width >= W - SNAP) setGeom(dockGeom(kind, "right"));
    else setGeom((g) => ({ ...g, x, y }));
  }

  return (
    <Rnd
      className="pf-panel"
      bounds="parent"
      size={{ width: geom.width, height: geom.height }}
      position={{ x: geom.x, y: geom.y }}
      minWidth={300}
      minHeight={180}
      dragHandleClassName="pf-panel-head"
      cancel=".pf-panel-acts"
      resizeHandleStyles={{
        right: { width: "12px", right: "-3px", cursor: "ew-resize" },
        left: { width: "12px", left: "-3px", cursor: "ew-resize" },
        top: { height: "12px", top: "-3px", cursor: "ns-resize" },
        bottom: { height: "12px", bottom: "-3px", cursor: "ns-resize" },
        bottomRight: { width: "18px", height: "18px", right: "-4px", bottom: "-4px" },
        bottomLeft: { width: "18px", height: "18px", left: "-4px", bottom: "-4px" },
        topRight: { width: "18px", height: "18px", right: "-4px", top: "-4px" },
        topLeft: { width: "18px", height: "18px", left: "-4px", top: "-4px" },
      }}
      onDragStop={(_, d) => onDragStop(d.x, d.y)}
      onResizeStop={(_, __, ref, ___, pos) =>
        setGeom({ x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight })
      }
    >
      <div className="pf-panel-inner">
        <div className="pf-panel-head">
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
    </Rnd>
  );
}
