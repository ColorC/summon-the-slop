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
    this.selected = -1;
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

  // ── 画板能力: 选中 / 改大小 / 删除(文字背景见 drawShape) ──────────────
  /** 当前选中的形状下标(-1=无)。选中后画虚框 + 四角把手, 可改大小、可删。 */
  selected = -1;

  /** 选中某形状(点中就选, 点空清选)。返回选中下标。 */
  selectAt(cssX: number, cssY: number): number {
    this.selected = this.hitTest(cssX, cssY);
    this.redraw();
    return this.selected;
  }
  select(idx: number) { this.selected = idx; this.redraw(); }
  clearSelection() { if (this.selected !== -1) { this.selected = -1; this.redraw(); } }
  getSelected(): number { return this.selected; }

  /** 删掉选中的形状(定点删, 不必整体撤销)。返回是否删了。 */
  deleteSelected(): boolean {
    if (this.selected < 0 || this.selected >= this.shapes.length) return false;
    const [removed] = this.shapes.splice(this.selected, 1);
    if (removed) this.redoStack.push(removed);
    this.selected = -1;
    this.redraw();
    return true;
  }

  /** 形状包围盒(画布物理像素)。文字按字体实测宽高。 */
  private bboxCanvas(idx: number): { l: number; t: number; r: number; b: number } {
    const s = this.shapes[idx];
    if (s.tool === "text") {
      const a = s.pts[0];
      const fs = Math.round(18 * this.dpr);
      this.ctx.save();
      this.ctx.font = `${fs}px "Microsoft YaHei", sans-serif`;
      const w = Math.max(this.ctx.measureText(s.text || "").width, fs);
      this.ctx.restore();
      const pad = 4 * this.dpr;
      return { l: a.x - pad, t: a.y - pad, r: a.x + w + pad, b: a.y + fs * 1.35 + pad };
    }
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const p of s.pts) { l = Math.min(l, p.x); r = Math.max(r, p.x); t = Math.min(t, p.y); b = Math.max(b, p.y); }
    return { l, t, r, b };
  }

  private handleSize() { return Math.max(7, 5 * this.dpr); }

  /** 选中形状的四角把手命中(返回 'nw'|'ne'|'sw'|'se' 或 null)。供 snap.ts 判断点到把手就改大小。 */
  handleAt(cssX: number, cssY: number): string | null {
    if (this.selected < 0) return null;
    const s = this.shapes[this.selected];
    if (s.tool === "text") return null; // 文字只移动不改大小(改字号意义不大)
    const x = cssX * this.dpr, y = cssY * this.dpr;
    const bb = this.bboxCanvas(this.selected);
    const hs = this.handleSize() * 1.8;
    const corners: [string, number, number][] = [
      ["nw", bb.l, bb.t], ["ne", bb.r, bb.t], ["sw", bb.l, bb.b], ["se", bb.r, bb.b],
    ];
    for (const [dir, hx, hy] of corners) {
      if (Math.abs(x - hx) <= hs && Math.abs(y - hy) <= hs) return dir;
    }
    return null;
  }

  /** 拖一个角把手改大小: 对边为锚, 整形按比例缩放(rect/椭圆/线/箭头/笔/荧光/马赛克统一适用)。 */
  resizeSelected(handle: string, cssX: number, cssY: number) {
    const i = this.selected;
    if (i < 0) return;
    const s = this.shapes[i];
    if (s.tool === "text") return;
    const bb = this.bboxCanvas(i);
    const ax = handle.includes("w") ? bb.r : bb.l;   // 拖西边 → 东边为锚
    const ay = handle.includes("n") ? bb.b : bb.t;
    const cx = cssX * this.dpr, cy = cssY * this.dpr;
    const oldW = Math.max(1, bb.r - bb.l), oldH = Math.max(1, bb.b - bb.t);
    const newW = Math.max(8 * this.dpr, Math.abs(cx - ax)), newH = Math.max(8 * this.dpr, Math.abs(cy - ay));
    const sx = newW / oldW, sy = newH / oldH;
    for (const p of s.pts) { p.x = ax + (p.x - ax) * sx; p.y = ay + (p.y - ay) * sy; }
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
    this.drawSelection();
  }

  /** 选中的形状画虚线框 + 四角把手, 像画板一样可拖角改大小。文字只画移动框(不改大小)。 */
  private drawSelection() {
    if (this.selected < 0 || this.selected >= this.shapes.length) return;
    const ctx = this.ctx;
    const bb = this.bboxCanvas(this.selected);
    const isText = this.shapes[this.selected].tool === "text";
    ctx.save();
    ctx.strokeStyle = "#0a84ff";
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.setLineDash([5 * this.dpr, 4 * this.dpr]);
    ctx.strokeRect(bb.l, bb.t, bb.r - bb.l, bb.b - bb.t);
    ctx.setLineDash([]);
    if (!isText) {
      const hs = this.handleSize();
      ctx.fillStyle = "#fff";
      for (const [hx, hy] of [[bb.l, bb.t], [bb.r, bb.t], [bb.l, bb.b], [bb.r, bb.b]] as [number, number][]) {
        ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        ctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
      }
    }
    ctx.restore();
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
        const fs = Math.round(18 * this.dpr);
        ctx.font = `${fs}px "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = "top";
        const txt = s.text || "";
        const tw = ctx.measureText(txt).width;
        const pad = 5 * this.dpr, rad = 5 * this.dpr;
        // 文字背景: 半透明深底 + 细描边, 让任意截图上文字都看得清(用户: 文字没背景)。
        this.roundRect(a.x - pad, a.y - pad, tw + pad * 2, fs * 1.35 + pad * 2, rad);
        ctx.fillStyle = "rgba(20,18,16,0.72)";
        ctx.fill();
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.stroke();
        ctx.fillStyle = s.color;
        ctx.fillText(txt, a.x, a.y);
        break;
      }
    }
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
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
