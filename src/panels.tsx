import { useEffect, useState, type ReactNode } from "react";
import { Rnd } from "react-rnd";
import { Pin, PinOff, X, PanelRight } from "lucide-react";

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

/** default geometry = docked to the right edge of the stage, full band height */
function defaultGeom(k: PanelKind): Geom {
  const W = window.innerWidth;
  const bandH = Math.max(240, window.innerHeight - TOP - BOTTOM);
  const w =
    k === "notes"
      ? Math.min(1120, Math.round(W * 0.7))
      : k === "chat"
        ? Math.min(720, Math.round(W * 0.46))
        : Math.min(860, Math.round(W * 0.56));
  return { x: Math.max(8, W - w - 12), y: 0, width: w, height: bandH };
}

/** A draggable + resizable panel that remembers its geometry per kind. Default docks
 *  to the right; drag the header to float it anywhere in the band; "归位" snaps back. */
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
  const [geom, setGeom] = useState<Geom>(() => loadGeom(kind) ?? defaultGeom(kind));
  useEffect(() => {
    localStorage.setItem(gkey(kind), JSON.stringify(geom));
  }, [kind, geom]);

  return (
    <Rnd
      className="pf-panel"
      bounds="parent"
      size={{ width: geom.width, height: geom.height }}
      position={{ x: geom.x, y: geom.y }}
      minWidth={320}
      minHeight={200}
      dragHandleClassName="pf-panel-head"
      cancel=".pf-panel-acts"
      onDragStop={(_, d) => setGeom((g) => ({ ...g, x: d.x, y: d.y }))}
      onResizeStop={(_, __, ref, ___, pos) =>
        setGeom({ x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight })
      }
    >
      <div className="pf-panel-inner">
        <div className="pf-panel-head">
          <span className="pf-panel-title">{PANEL_TITLES[kind]}</span>
          <div className="pf-panel-acts">
            <button onClick={() => setGeom(defaultGeom(kind))} title="归位到侧栏">
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
