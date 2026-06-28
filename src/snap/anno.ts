// Annotation editor — a complete in-place annotator over the frozen screenshot.
// 参照成熟工具(Snipaste/Flameshot/Skitch/Excalidraw)的完整交互集实现, 不再零碎补:
// 画完即选中 · 选中任意元素(含文字)可移动/拖把手改大小/改颜色粗细字号/删除 · 文字双击改内容 ·
// 箭头直线用端点把手 · 框用 8 把手 · 方向键微移 · 快照式撤销重做覆盖所有操作 · 悬停光标反馈。
export type Tool = "rect" | "ellipse" | "arrow" | "line" | "pen" | "text" | "highlight" | "mosaic";

export interface Pt { x: number; y: number }
export interface Shape {
  tool: Tool;
  color: string;
  width: number;
  pts: Pt[];          // physical-pixel canvas coords (full-frame; origin = captured frame top-left)
  text?: string;
  size?: number;      // text 字号(物理像素); 仅 text 用, 默认 18*dpr
}

const TEXT_BASE = 18; // 文字默认字号(CSS px), 实际乘 dpr

export class Annotator {
  private ctx: CanvasRenderingContext2D;
  private shapes: Shape[] = [];
  private draft: Shape | null = null;
  private dpr = 1;
  private selected = -1;
  private history: Shape[][] = [];  // 快照式撤销: 每次改动前压一份
  private future: Shape[][] = [];
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
    this.selected = -1;
    this.history = [];
    this.future = [];
    this.enabled = false;
    this.redraw();
  }

  hasInk() { return this.shapes.length > 0; }

  /** 结构化导出: 所有标注形状的深拷贝。pts 是全帧物理像素坐标。 */
  getShapes(): Shape[] {
    return this.shapes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
  }

  // ── 快照式撤销/重做(覆盖 创建/移动/缩放/改样式/删除/改文字) ──────────────
  /** 改动前调一次, 把当前状态压入历史(snap.ts 在拖动开始时也调一次, 保证一次手势一条历史)。 */
  snapshot() {
    this.history.push(this.shapes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) })));
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }
  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.shapes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) })));
    this.shapes = prev;
    this.selected = -1;
    this.redraw();
  }
  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.shapes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) })));
    this.shapes = next;
    this.selected = -1;
    this.redraw();
  }

  // ── 选中 ─────────────────────────────────────────────────────────────
  getSelected(): number { return this.selected; }
  select(idx: number) { this.selected = idx; if (this.shapes[idx]) this.color = this.shapes[idx].color; this.redraw(); }
  clearSelection() { if (this.selected !== -1) { this.selected = -1; this.redraw(); } }
  /** 点选最上层命中的形状(点空清选)。选中即把它的颜色载入工具(成熟工具的"样式跟随选中")。 */
  selectAt(cssX: number, cssY: number): number {
    const idx = this.hitTest(cssX, cssY);
    this.selected = idx;
    if (idx >= 0) this.color = this.shapes[idx].color;
    this.redraw();
    return idx;
  }

  /** 命中测试: 最上层【包围盒含该 CSS 点(带容差)】的形状下标(-1=没有)。 */
  hitTest(cssX: number, cssY: number): number {
    const x = cssX * this.dpr, y = cssY * this.dpr;
    const pad = Math.max(8, 6 * this.dpr);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const bb = this.bboxCanvas(i);
      if (x >= bb.l - pad && x <= bb.r + pad && y >= bb.t - pad && y <= bb.b + pad) return i;
    }
    return -1;
  }

  /** 文字形状命中(双击改内容用)。返回 text 形状下标或 -1。 */
  textAt(cssX: number, cssY: number): number {
    const i = this.hitTest(cssX, cssY);
    return i >= 0 && this.shapes[i].tool === "text" ? i : -1;
  }

  // ── 移动 / 微移 / 删除 ────────────────────────────────────────────────
  /** 平移某形状(CSS 增量)。连续拖动时 snap.ts 在 onDown 已 snapshot, 这里只改不再压历史。 */
  moveShapeBy(idx: number, dCssX: number, dCssY: number) {
    const s = this.shapes[idx];
    if (!s) return;
    const dx = dCssX * this.dpr, dy = dCssY * this.dpr;
    for (const p of s.pts) { p.x += dx; p.y += dy; }
    this.redraw();
  }
  /** 方向键微移选中(snapshot 后移)。step 为 CSS 像素(普通 1, Shift 10)。 */
  nudgeSelected(dCssX: number, dCssY: number) {
    if (this.selected < 0) return;
    this.snapshot();
    this.moveShapeBy(this.selected, dCssX, dCssY);
  }
  deleteSelected(): boolean {
    if (this.selected < 0 || this.selected >= this.shapes.length) return false;
    this.snapshot();
    this.shapes.splice(this.selected, 1);
    this.selected = -1;
    this.redraw();
    return true;
  }

  // ── 改样式(选中后改颜色/粗细/字号) ──────────────────────────────────
  setSelectedColor(color: string) {
    if (this.selected < 0) return;
    this.snapshot();
    this.shapes[this.selected].color = color;
    this.redraw();
  }
  /** 调整粗细(选中则改选中元素, 否则改后续新建的默认)。delta 步进。 */
  adjustWidth(delta: number) {
    if (this.selected >= 0) {
      const s = this.shapes[this.selected];
      if (s.tool === "text") { this.snapshot(); s.size = Math.max(8, (s.size || TEXT_BASE * this.dpr) + delta * 2 * this.dpr); }
      else { this.snapshot(); s.width = Math.max(1, Math.min(40, s.width + delta)); }
      this.redraw();
    } else {
      this.width = Math.max(1, Math.min(40, this.width + delta));
    }
  }

  // ── 文字 ─────────────────────────────────────────────────────────────
  addText(cssX: number, cssY: number, text: string, color: string) {
    if (!text) return;
    this.snapshot();
    const p = this.toCanvas(cssX, cssY);
    this.shapes.push({ tool: "text", color, width: this.width, pts: [p], text, size: TEXT_BASE * this.dpr });
    this.selected = this.shapes.length - 1;
    this.redraw();
  }
  /** 双击改文字内容: 空内容则删掉该元素。 */
  updateText(idx: number, text: string) {
    const s = this.shapes[idx];
    if (!s || s.tool !== "text") return;
    this.snapshot();
    if (!text.trim()) { this.shapes.splice(idx, 1); this.selected = -1; }
    else { s.text = text; this.selected = idx; }
    this.redraw();
  }
  /** 取某 text 形状的锚点(CSS)+ 现有文字, 供 snap.ts 定位内联输入框。 */
  textInfo(idx: number): { cssX: number; cssY: number; text: string; color: string } | null {
    const s = this.shapes[idx];
    if (!s || s.tool !== "text") return null;
    return { cssX: s.pts[0].x / this.dpr, cssY: s.pts[0].y / this.dpr, text: s.text || "", color: s.color };
  }

  private toCanvas(cssX: number, cssY: number): Pt {
    return { x: Math.round(cssX * this.dpr), y: Math.round(cssY * this.dpr) };
  }

  // ── 画(create) ──────────────────────────────────────────────────────
  onDown(cssX: number, cssY: number) {
    if (!this.enabled) return;
    if (this.tool === "text") return; // 文字走内联输入
    const p = this.toCanvas(cssX, cssY);
    this.draft = { tool: this.tool, color: this.color, width: this.width, pts: [p] };
  }
  onMove(cssX: number, cssY: number, shift = false) {
    if (!this.draft) return;
    let p = this.toCanvas(cssX, cssY);
    const a = this.draft.pts[0];
    if (shift && (this.tool === "rect" || this.tool === "ellipse" || this.tool === "mosaic")) {
      // 正方形/正圆: 取较大边
      const d = Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y));
      p = { x: a.x + Math.sign(p.x - a.x) * d, y: a.y + Math.sign(p.y - a.y) * d };
    } else if (shift && (this.tool === "line" || this.tool === "arrow")) {
      // 直线吸附 0/45/90 度
      const ang = Math.atan2(p.y - a.y, p.x - a.x);
      const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(p.x - a.x, p.y - a.y);
      p = { x: Math.round(a.x + Math.cos(snap) * len), y: Math.round(a.y + Math.sin(snap) * len) };
    }
    if (this.tool === "pen" || this.tool === "highlight") this.draft.pts.push(p);
    else this.draft.pts = [this.draft.pts[0], p];
    this.redraw();
  }
  onUp() {
    if (!this.draft) return;
    const a = this.draft.pts[0], b = this.draft.pts[this.draft.pts.length - 1];
    const tiny = (this.draft.pts.length <= 2) && Math.abs(b.x - a.x) < 4 * this.dpr && Math.abs(b.y - a.y) < 4 * this.dpr;
    if (!tiny) {
      this.snapshot();
      this.shapes.push(this.draft);
      this.selected = this.shapes.length - 1; // 画完即选中
    }
    this.draft = null;
    this.redraw();
  }

  // ── 包围盒 / 把手 / 缩放 ──────────────────────────────────────────────
  private fontPx(s: Shape): number { return s.size || TEXT_BASE * this.dpr; }

  private bboxCanvas(idx: number): { l: number; t: number; r: number; b: number } {
    const s = this.shapes[idx];
    if (s.tool === "text") {
      const a = s.pts[0], fs = this.fontPx(s);
      this.ctx.save();
      this.ctx.font = `${Math.round(fs)}px "Microsoft YaHei", sans-serif`;
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

  /** 选中形状的把手列表(画布坐标 + 方向)。箭头/直线=两端点; 框=8 把手; 笔/文字=4 角。 */
  private handlesFor(idx: number): { dir: string; x: number; y: number }[] {
    const s = this.shapes[idx];
    if (s.tool === "line" || s.tool === "arrow") {
      return [
        { dir: "e0", x: s.pts[0].x, y: s.pts[0].y },
        { dir: "e1", x: s.pts[s.pts.length - 1].x, y: s.pts[s.pts.length - 1].y },
      ];
    }
    const bb = this.bboxCanvas(idx);
    const mx = (bb.l + bb.r) / 2, my = (bb.t + bb.b) / 2;
    if (s.tool === "pen" || s.tool === "highlight" || s.tool === "text") {
      return [
        { dir: "nw", x: bb.l, y: bb.t }, { dir: "ne", x: bb.r, y: bb.t },
        { dir: "sw", x: bb.l, y: bb.b }, { dir: "se", x: bb.r, y: bb.b },
      ];
    }
    // rect/ellipse/mosaic: 8 把手
    return [
      { dir: "nw", x: bb.l, y: bb.t }, { dir: "n", x: mx, y: bb.t }, { dir: "ne", x: bb.r, y: bb.t },
      { dir: "e", x: bb.r, y: my }, { dir: "se", x: bb.r, y: bb.b }, { dir: "s", x: mx, y: bb.b },
      { dir: "sw", x: bb.l, y: bb.b }, { dir: "w", x: bb.l, y: my },
    ];
  }

  /** 把手命中(返回方向 'nw'|'n'|..|'e0'|'e1' 或 null)。 */
  handleAt(cssX: number, cssY: number): string | null {
    if (this.selected < 0) return null;
    const x = cssX * this.dpr, y = cssY * this.dpr;
    const hs = this.handleSize() * 1.8;
    for (const h of this.handlesFor(this.selected)) {
      if (Math.abs(x - h.x) <= hs && Math.abs(y - h.y) <= hs) return h.dir;
    }
    return null;
  }

  /** 拖把手改大小。snap.ts 在 onDown 已 snapshot。箭头/直线移端点; 框按边/角调; 笔/文字按比例缩放。 */
  resizeSelected(handle: string, cssX: number, cssY: number) {
    const i = this.selected;
    if (i < 0) return;
    const s = this.shapes[i];
    const cx = cssX * this.dpr, cy = cssY * this.dpr;
    if (s.tool === "line" || s.tool === "arrow") {
      if (handle === "e0") s.pts[0] = { x: cx, y: cy };
      else s.pts[s.pts.length - 1] = { x: cx, y: cy };
      this.redraw();
      return;
    }
    const bb = this.bboxCanvas(i);
    const minSz = 8 * this.dpr;
    if (s.tool === "rect" || s.tool === "ellipse" || s.tool === "mosaic") {
      // 角=两轴, 边=单轴; 对边为锚。直接重写 bbox 两角。
      let l = bb.l, t = bb.t, r = bb.r, b = bb.b;
      if (handle.includes("w")) l = Math.min(cx, r - minSz);
      if (handle.includes("e")) r = Math.max(cx, l + minSz);
      if (handle.includes("n")) t = Math.min(cy, b - minSz);
      if (handle.includes("s")) b = Math.max(cy, t + minSz);
      s.pts = [{ x: l, y: t }, { x: r, y: b }];
      this.redraw();
      return;
    }
    // pen/highlight/text: 角把手按比例缩放(对角为锚)。text 同时缩字号。
    const ax = handle.includes("w") ? bb.r : bb.l;
    const ay = handle.includes("n") ? bb.b : bb.t;
    const oldW = Math.max(1, bb.r - bb.l), oldH = Math.max(1, bb.b - bb.t);
    const newW = Math.max(minSz, Math.abs(cx - ax)), newH = Math.max(minSz, Math.abs(cy - ay));
    const sx = newW / oldW, sy = newH / oldH;
    if (s.tool === "text") {
      s.size = Math.max(8, this.fontPx(s) * sy);
      s.pts[0] = { x: ax + (s.pts[0].x - ax) * sx, y: ay + (s.pts[0].y - ay) * sy };
    } else {
      for (const p of s.pts) { p.x = ax + (p.x - ax) * sx; p.y = ay + (p.y - ay) * sy; }
    }
    this.redraw();
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────
  private redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.shapes) this.drawShape(s);
    if (this.draft) this.drawShape(this.draft);
    this.drawSelection();
  }

  private drawSelection() {
    if (this.selected < 0 || this.selected >= this.shapes.length) return;
    const ctx = this.ctx;
    const bb = this.bboxCanvas(this.selected);
    ctx.save();
    ctx.strokeStyle = "#0a84ff";
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.setLineDash([5 * this.dpr, 4 * this.dpr]);
    ctx.strokeRect(bb.l, bb.t, bb.r - bb.l, bb.b - bb.t);
    ctx.setLineDash([]);
    const hs = this.handleSize();
    ctx.fillStyle = "#fff";
    for (const h of this.handlesFor(this.selected)) {
      ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
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
        const fs = Math.round(this.fontPx(s));
        ctx.font = `${fs}px "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = "top";
        const txt = s.text || "";
        const tw = ctx.measureText(txt).width;
        const pad = 5 * this.dpr, rad = 5 * this.dpr;
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
        } catch { /* offscreen */ }
      }
    }
  }
}
