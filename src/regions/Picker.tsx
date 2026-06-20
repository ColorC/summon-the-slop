import { useEffect, useRef, useState } from "react";
import { X, MessageSquarePlus, Copy, RotateCcw } from "lucide-react";
import { copyText } from "../lib";

interface Picked {
  rect: { left: number; top: number; width: number; height: number };
  label: string;
  text: string;
}

/** 圈选元素 / 检视: hover highlights any DOM element in the overlay (a devtools-style
 *  inspector — exactly what helps when an interaction "feels broken but is hard to
 *  describe"); click captures its info + text, which you can feed to the AI or copy.
 *  Also works over the notes canvas container (canvas shapes use BlockSuite's own select). */
export function Picker({
  onExit,
  onAskAI,
}: {
  onExit: () => void;
  onAskAI: (q: string) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Picked | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  function describe(el: Element): Picked {
    const r = el.getBoundingClientRect();
    const cls =
      typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : "";
    const label = `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} · ${Math.round(
      r.width
    )}×${Math.round(r.height)}`;
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      label,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    };
  }

  function elAt(x: number, y: number): Element | null {
    const l = layer.current;
    if (l) l.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    if (l) l.style.pointerEvents = "auto";
    return el;
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (picked) return;
      const el = elAt(e.clientX, e.clientY);
      if (!el || el === document.body || el === document.documentElement) {
        setHover(null);
        return;
      }
      setHover(describe(el));
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elAt(e.clientX, e.clientY);
      if (el) setPicked(describe(el));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (picked) setPicked(null);
      else onExit();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picked, onExit]);

  const show = picked || hover;

  return (
    <div className="picker" ref={layer}>
      {!picked && (
        <div className="picker-hint">圈选 / 检视：移动高亮 · 点击选中 · Esc 退出</div>
      )}
      {show && (
        <div
          className={"picker-box" + (picked ? " picked" : "")}
          style={{
            left: show.rect.left,
            top: show.rect.top,
            width: show.rect.width,
            height: show.rect.height,
          }}
        />
      )}
      {show && (
        <div
          className="picker-label"
          style={{ left: show.rect.left, top: Math.max(2, show.rect.top - 22) }}
        >
          {show.label}
        </div>
      )}
      {picked && (
        <div
          className="picker-actions"
          style={{
            left: Math.min(picked.rect.left, window.innerWidth - 360),
            top: Math.min(picked.rect.top + picked.rect.height + 8, window.innerHeight - 60),
          }}
        >
          <button
            onClick={() => {
              onAskAI(picked.text || picked.label);
              onExit();
            }}
          >
            <MessageSquarePlus size={14} /> 问 AI
          </button>
          <button onClick={() => copyText(picked.text || picked.label)}>
            <Copy size={14} /> 复制
          </button>
          <button onClick={() => setPicked(null)}>
            <RotateCcw size={14} /> 重选
          </button>
          <button onClick={onExit}>
            <X size={14} /> 退出
          </button>
        </div>
      )}
    </div>
  );
}
