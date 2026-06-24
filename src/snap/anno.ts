// Annotation editor — draws on a canvas over the frozen screenshot.
// Tools: rect, ellipse, arrow, line, pen, text, highlight, mosaic. Undo + color.
export type Tool = "rect" | "ellipse" | "arrow" | "line" | "pen" | "text" | "highlight" | "mosaic";

export interface Pt { x: number; y: number }
export interface Shape {
  tool: Tool;
  color: string;
  width: number;
  pts: Pt[];          // physical-pixel canvas coords (full-frame; origin = captured frame top-left)
  text?: string;
}

export class Annotator {
  private ctx: CanvasRenderingContext2D;
  private shapes: Shape[] = [];
  private draft: Shape | null = null;
  private dpr = 1;
  tool: Tool = "rect";
  color = "#ff3b30";
  width = 3;
  enabled = false;

  constructor(private canvas: HTMLCanvasElement, private screen: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  reset(dpr: number) {
    this.dpr = dpr;
    this.shapes = [];
    this.draft = null;
    this.redoStack = [];
    this.enabled = false;
    this.redraw();
  }

  undo() { const s = this.shapes.pop(); if (s) { this.redoStack.push(s); this.redraw(); } }
  hasInk() { return this.shapes.length > 0; }

  /** 结构化导出: 所有标注形状的深拷贝(snap.ts 序列化成 Markdown 喂 AI 用)。pts 是全帧物理像素坐标。 */
  getShapes(): Shape[] {
    return this.shapes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
  }

  /** 命中测试: 最上层【包围盒含该 CSS 点】的形状下标(-1=没有)。供"画完后像画板一样拖动"用。 */
  hitTest(cssX: number, cssY: number): number {
    const x = cssX * this.dpr, y = cssY * this.dpr;
    const pad = Math.max(8, 6 * this.dpr); // 容差: 细线/文字也好点中
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const ps = this.shapes[i].pts;
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
      for (const p of ps) {
        if (p.x < l) l = p.x;
        if (p.x > r) r = p.x;
        if (p.y < t) t = p.y;
        if (p.y > b) b = p.y;
      }
      if (x >= l - pad && x <= r + pad && y >= t - pad && y <= b + pad) return i;
    }
    return -1;
  }

  /** 把某形状整体平移(CSS 增量),并重绘。 */
  moveShapeBy(idx: number, dCssX: number, dCssY: number) {
    const s = this.shapes[idx];
    if (!s) return;
    const dx = dCssX * this.dpr, dy = dCssY * this.dpr;
    for (const p of s.pts) {
      p.x += dx;
      p.y += dy;
    }
    this.redraw();
  }

  private toCanvas(cssX: number, cssY: number): Pt {
    return { x: Math.round(cssX * this.dpr), y: Math.round(cssY * this.dpr) };
  }

  onDown(cssX: number, cssY: number) {
    if (!this.enabled) return;
    // text is committed by snap.ts via an inline input (window.prompt hangs a borderless
    // always-on-top overlay), so the canvas ignores text-tool mousedowns here.
    if (this.tool === "text") return;
    const p = this.toCanvas(cssX, cssY);
    this.draft = { tool: this.tool, color: this.color, width: this.width, pts: [p] };
  }

  /** Commit a text shape at a CSS point (called by the inline-input flow). */
  addText(cssX: number, cssY: number, text: string, color: string) {
    if (!text) return;
    const p = this.toCanvas(cssX, cssY);
    this.shapes.push({ tool: "text", color, width: this.width, pts: [p], text });
    this.redoStack = [];
    this.redraw();
  }

  /** Redo support: keep popped shapes so Ctrl+Y can restore them. */
  private redoStack: Shape[] = [];
  redo() { const s = this.redoStack.pop(); if (s) { this.shapes.push(s); this.redraw(); } }

  onMove(cssX: number, cssY: number) {
    if (!this.draft) return;
    const p = this.toCanvas(cssX, cssY);
    if (this.tool === "pen" || this.tool === "highlight") this.draft.pts.push(p);
    else this.draft.pts = [this.draft.pts[0], p];
    this.redraw();
  }

  onUp() {
    if (this.draft) { this.shapes.push(this.draft); this.draft = null; this.redoStack = []; this.redraw(); }
  }

  private redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.shapes) this.drawShape(s);
    if (this.draft) this.drawShape(this.draft);
  }

  private drawShape(s: Shape) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width * this.dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    switch (s.tool) {
      case "rect": ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); break;
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        ctx.stroke(); break;
      }
      case "line": ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); break;
      case "arrow": this.arrow(a, b, s.width * this.dpr); break;
      case "pen": this.poly(s.pts); break;
      case "highlight": {
        ctx.globalAlpha = 0.35; ctx.lineWidth = (s.width + 8) * this.dpr; this.poly(s.pts); ctx.globalAlpha = 1; break;
      }
      case "mosaic": this.mosaic(a, b); break;
      case "text": {
        ctx.font = `${Math.round(18 * this.dpr)}px "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(s.text || "", a.x, a.y); break;
      }
    }
    ctx.restore();
  }

  private poly(pts: Pt[]) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  private arrow(a: Pt, b: Pt, w: number) {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(12, w * 4);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath(); ctx.fill();
  }

  private mosaic(a: Pt, b: Pt) {
    const ctx = this.ctx;
    const l = Math.min(a.x, b.x), t = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 4 || h < 4) return;
    const block = Math.max(8, Math.round(10 * this.dpr));
    const sctx = this.screen.getContext("2d", { willReadFrequently: true })!;
    for (let y = t; y < t + h; y += block) {
      for (let x = l; x < l + w; x += block) {
        try {
          const d = sctx.getImageData(x + block / 2, y + block / 2, 1, 1).data;
          ctx.fillStyle = `rgb(${d[0]},${d[1]},${d[2]})`;
          ctx.fillRect(x, y, block, block);
        } catch {}
      }
    }
  }
}
