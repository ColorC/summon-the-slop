// 统一捕获 · 画板(点 3B): 把 snap 标注层接到 poof 已在用的 BlockSuite 0.19.5 edgeless 画布。
// 截图当锁定背景图块(画布 0,0, 1:1 像素), 用 edgeless 原生能力标注(移动/缩放/定点删/带背景文字/连线),
// 导出时读 surface 元素映射回图片像素 → 喂回 snap.ts 现有的结构化 MD + omni 解析流。
//
// 复用 NoteSpace.tsx 的实例化方式(AffineEditorContainer + edgeless + effects 注册)与
// blocks/dist/root-block/edgeless/utils/common.js 的加图方式。元素读取走 SurfaceBlockModel.elementModels。
//
// ⚠ 真机行为(画布交互 / 元素抽取 / 视口 fit)需开着 poof 验; 本模块 tsc 过 + 构建过为 headless 上限。
import "@toeverything/theme/style.css";
import { Schema, DocCollection, type Doc } from "@blocksuite/store";
import { AffineSchemas } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { effects as blocksEffects } from "@blocksuite/blocks/effects";
import { effects as presetsEffects } from "@blocksuite/presets/effects";

// 导出的标注: 跟 anno.ts 的 Shape 对齐(snap.ts 的 buildMarkdown 直接复用), pts = 图片像素坐标。
export interface BoardShape {
  tool: "rect" | "ellipse" | "arrow" | "line" | "pen" | "text";
  color: string;
  width: number;
  pts: { x: number; y: number }[];
  text?: string;
}

let registered = false;
function registerEffects() {
  if (registered) return;
  registered = true;
  blocksEffects();
  presetsEffects();
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SnapBoard {
  private collection: DocCollection | null = null;
  private editor: AffineEditorContainer | null = null;
  private doc: Doc | null = null;
  private bgB64 = "";
  imgW = 0;
  imgH = 0;

  /** 挂一个 edgeless 画板到 host, 把截图(base64 PNG)当 1:1 背景图块。 */
  async mount(host: HTMLElement, pngBase64: string, w: number, h: number): Promise<void> {
    registerEffects();
    this.imgW = w;
    this.imgH = h;
    this.bgB64 = pngBase64;
    const schema = new Schema().register(AffineSchemas);
    const collection = new DocCollection({ schema });
    collection.meta.initialize();
    const doc = collection.createDoc({ id: "snap-board" });
    let surfaceId = "";
    doc.load(() => {
      const rootId = doc.addBlock("affine:page", {});
      surfaceId = doc.addBlock("affine:surface", {}, rootId);
      // edgeless 页需要一个 note 块才完整; 放视口外, 不挡截图。
      const noteId = doc.addBlock(
        "affine:note",
        { xywh: `[${w + 200},0,400,80]` } as Record<string, unknown>,
        rootId
      );
      doc.addBlock("affine:paragraph", {}, noteId);
    });

    // 截图当背景图块: 先把 blob 入库拿 sourceId, 再 addBlock(已带 sourceId/尺寸/xywh, 1:1 放在 0,0)。
    try {
      const blob = new Blob([b64ToBytes(pngBase64)], { type: "image/png" });
      const sourceId = await doc.blobSync.set(blob);
      doc.addBlock(
        "affine:image",
        { sourceId, width: w, height: h, xywh: `[0,0,${w},${h}]` } as Record<string, unknown>,
        surfaceId
      );
    } catch (e) {
      console.error("board: add screenshot image failed", e);
    }

    this.collection = collection;
    this.doc = doc;

    const editor = new AffineEditorContainer();
    editor.doc = doc;
    (editor as any).mode = "edgeless"; // 无限画布(同 NoteSpace.tsx)
    host.appendChild(editor);
    this.editor = editor;

    // 视口 fit 到截图(连上 DOM 后再做)。
    setTimeout(() => this.fitToImage(), 200);
  }

  private gfx(): any {
    try {
      const std = (this.editor as any)?.host?.std;
      if (!std) return null;
      // GfxControllerIdentifier 的 key 字符串("std:gfxController") —— 用 std.get 拿控制器。
      return std.get?.(this.gfxIdentifier()) ?? null;
    } catch {
      return null;
    }
  }

  private gfxIdentifier(): any {
    // 延迟取, 避免顶层 import 让 tsc 解析不到该子路径类型。
    // @blocksuite/block-std/gfx 导出 GfxControllerIdentifier。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = (window as any).__bsGfx || null;
      return mod?.GfxControllerIdentifier ?? "gfxController";
    } catch {
      return "gfxController";
    }
  }

  private fitToImage() {
    try {
      const gfx = this.gfx();
      const vp = gfx?.viewport;
      if (vp?.setViewportByBound) {
        // Bound 形如 { x,y,w,h }; viewport 接受 Bound 实例, 这里给个鸭子对象 + padding。
        vp.setViewportByBound({ x: 0, y: 0, w: this.imgW, h: this.imgH }, [40, 40, 40, 40], false);
      }
    } catch (e) {
      console.warn("board: fitToImage skipped", e);
    }
  }

  /** 读 surface 上的标注元素 → 图片像素坐标的 BoardShape[](图块在 0,0 1:1, 故画布坐标即图片像素)。 */
  getShapes(): BoardShape[] {
    const out: BoardShape[] = [];
    try {
      const surface: any = (this.doc as any)?.root?.children?.find?.(
        (c: any) => c.flavour === "affine:surface"
      );
      const els: any[] = surface?.elementModels || [];
      for (const el of els) {
        const x = num(el.x), y = num(el.y), w = num(el.w), h = num(el.h);
        const color = el.strokeColor || el.color || el.stroke || "#ff3b30";
        const width = num(el.strokeWidth) || 3;
        switch (el.type) {
          case "shape":
            out.push({
              tool: el.shapeType === "ellipse" ? "ellipse" : "rect",
              color, width, pts: [{ x, y }, { x: x + w, y: y + h }],
              text: textOf(el.text),
            });
            break;
          case "text":
            out.push({ tool: "text", color, width, pts: [{ x, y }], text: textOf(el.text) });
            break;
          case "brush":
            out.push({ tool: "pen", color, width, pts: pointsOf(el) || [{ x, y }, { x: x + w, y: y + h }] });
            break;
          case "connector":
            out.push({ tool: "arrow", color, width, pts: [{ x, y }, { x: x + w, y: y + h }] });
            break;
          default:
            break; // group/mindmap 等不导出
        }
      }
    } catch (e) {
      console.error("board: getShapes failed", e);
    }
    return out;
  }

  /** 导出: 截图 + 标注合成一张 PNG(base64, 不含 data: 前缀)。自包含, 不依赖 anno.ts。 */
  renderAnnotatedPng(): Promise<string> {
    const shapes = this.getShapes();
    const w = this.imgW, h = this.imgH, b64 = this.bgB64;
    return new Promise((resolve) => {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d")!;
      const finish = () => {
        for (const s of shapes) drawBoardShape(ctx, s);
        resolve(cv.toDataURL("image/png").split(",")[1]);
      };
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, w, h); finish(); };
      img.onerror = () => finish();
      img.src = "data:image/png;base64," + b64;
    });
  }

  unmount() {
    try { this.editor?.remove(); } catch { /* ignore */ }
    try { this.collection?.dispose(); } catch { /* ignore */ }
    this.editor = null;
    this.collection = null;
    this.doc = null;
  }
}

/** 把一个 BoardShape 画到 ctx(图片像素坐标)。导出合成 PNG 用, 自包含。 */
function drawBoardShape(ctx: CanvasRenderingContext2D, s: BoardShape) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(2, s.width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const a = s.pts[0], b = s.pts[s.pts.length - 1];
  switch (s.tool) {
    case "rect": ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke(); break;
    case "line": ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); break;
    case "arrow": {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(12, ctx.lineWidth * 4);
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fill(); break;
    }
    case "pen":
      ctx.beginPath(); ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
      ctx.stroke(); break;
    case "text": {
      const fs = 18;
      ctx.font = `${fs}px "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = "top";
      const txt = s.text || "", tw = ctx.measureText(txt).width, pad = 5;
      ctx.fillStyle = "rgba(20,18,16,0.72)";
      ctx.fillRect(a.x - pad, a.y - pad, tw + pad * 2, fs * 1.35 + pad * 2);
      ctx.fillStyle = s.color;
      ctx.fillText(txt, a.x, a.y); break;
    }
  }
  ctx.restore();
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
function textOf(t: any): string | undefined {
  if (t == null) return undefined;
  if (typeof t === "string") return t;
  try { return String(t.toString?.() ?? t); } catch { return undefined; }
}
/** brush 等多点元素: 尽力取它的点序列(相对位置 + 元素原点)映射到画布像素。 */
function pointsOf(el: any): { x: number; y: number }[] | null {
  const raw = el.points || el.commands;
  if (!Array.isArray(raw) || !raw.length) return null;
  const ox = num(el.x), oy = num(el.y);
  const pts: { x: number; y: number }[] = [];
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2) pts.push({ x: ox + num(p[0]), y: oy + num(p[1]) });
    else if (p && typeof p === "object") pts.push({ x: ox + num(p.x), y: oy + num(p.y) });
  }
  return pts.length ? pts : null;
}
