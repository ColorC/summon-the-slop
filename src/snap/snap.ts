// poof 截图 — a Snipaste-style screen snipper. Freeze the desktop, drag a region (with a
// dimmed-outside mask + magnifier/color-picker), adjust it with handles, annotate, then
// copy (Enter / double-click) / save / pin (F3) / OCR. Every finalized shot is also
// written to a persistent folder so the history list always has a real file path.
// Esc or right-click always cancels — the window is shown+focused while poof still owns
// the foreground (see summon_snap in lib.rs), so keyboard always reaches it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Annotator, Tool, type Shape, type Pt } from "./anno";

interface Capture { width: number; height: number; x: number; y: number; scale: number; }
interface Rect { l: number; t: number; r: number; b: number; }
interface Shot { path: string; name: string; ts_ms: number; w: number; h: number; }

const $ = (id: string) => document.getElementById(id)!;
const scr = $("screen") as HTMLCanvasElement;
const annoEl = $("anno") as HTMLCanvasElement;
const mask = $("mask"), selEl = $("sel"), hot = $("hot"), handlesEl = $("handles");
const toolbar = $("toolbar"), hint = $("hint"), panel = $("panel"), sizebadge = $("sizebadge");
const chx = $("chx"), chy = $("chy");
const loupe = $("loupe"), loupeInfo = $("loupeInfo");
const loupeCanvas = $("loupeCanvas") as HTMLCanvasElement;
const textIn = $("textIn") as HTMLInputElement;
const sctx = scr.getContext("2d", { willReadFrequently: true })!;
const lctx = loupeCanvas.getContext("2d")!;
const annot = new Annotator(annoEl, scr);

let cap: Capture | null = null;
let dpr = 1;
let mode: "idle" | "selected" = "idle";
let action: "none" | "create" | "move" | "resize" | "draw" | "dragshape" = "none";
let dragShapeIdx = -1; // 拖动已画形状时, 被拖的形状下标
let resizeEdge = "";
let tool: Tool | "move" = "move";
let down: { x: number; y: number } | null = null;
let origSel: Rect = { l: 0, t: 0, r: 0, b: 0 };
let sel: Rect = { l: 0, t: 0, r: 0, b: 0 };
let textAt: { x: number; y: number } | null = null;
let recordMode = false; // summoned via Ctrl+Alt+R: pick a WINDOW (or drag a region) to 录制
const HINT_DEFAULT = hint.textContent || "";

interface WinInfo { l: number; t: number; r: number; b: number; hwnd: number; title: string }
let recWindows: WinInfo[] = []; // physical-pixel rects, top of z-order first (captured at summon)
let hoverWin: WinInfo | null = null;
// physical desktop rect <-> snap-canvas CSS coords
const cssToPhys = (rc: Rect): [number, number, number, number] =>
  [cap!.x + Math.round(rc.l * dpr), cap!.y + Math.round(rc.t * dpr), cap!.x + Math.round(rc.r * dpr), cap!.y + Math.round(rc.b * dpr)];
const physToCssRect = (w: WinInfo): Rect =>
  ({ l: (w.l - cap!.x) / dpr, t: (w.t - cap!.y) / dpr, r: (w.r - cap!.x) / dpr, b: (w.b - cap!.y) / dpr });

const esc = (s: string) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const clampX = (x: number) => Math.max(0, Math.min(x, window.innerWidth));
const clampY = (y: number) => Math.max(0, Math.min(y, window.innerHeight));
const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect =>
  ({ l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) });

// ---- capture / lifecycle --------------------------------------------------

// Hide all overlay chrome and clear the canvas so the snap window is fully transparent.
// Critical before capture: the window is on-screen (always-on-top), so DXGI would grab
// our own old screenshot/mask if we left anything painted.
function clearForCapture() {
  for (const el of [mask, selEl, hot, toolbar, panel, sizebadge, loupe, chx, chy, textIn]) el.classList.add("hidden");
  handlesEl.innerHTML = "";
  sctx.clearRect(0, 0, scr.width, scr.height);
  annoEl.getContext("2d")!.clearRect(0, 0, annoEl.width, annoEl.height);
}

async function doCapture() {
  try {
    clearForCapture();
    // 帧已由 summon_snap 在显示 snap、收起 main 之前抓好(含 poof 自己); take_capture 取它。
    const raw = await invoke<ArrayBuffer>("take_capture");
    const dv = new DataView(raw);
    const w = dv.getInt32(0, true), h = dv.getInt32(4, true);
    cap = { width: w, height: h, x: dv.getInt32(8, true), y: dv.getInt32(12, true), scale: dv.getFloat32(16, true) };
    dpr = window.devicePixelRatio || cap.scale || 1;
    scr.width = annoEl.width = w;
    scr.height = annoEl.height = h;
    sctx.putImageData(new ImageData(new Uint8ClampedArray(raw, 20), w, h), 0, 0);
    annot.reset(dpr);
    if (recordMode) {
      try { recWindows = await invoke<WinInfo[]>("list_windows"); } catch { recWindows = []; }
    }
    enterIdle();
  } catch (e) {
    enterIdle();
    showPanel("截图失败", esc(String(e)));
  }
  // ensure the DOM has keyboard focus so Esc/Enter always work
  window.focus();
  try { (document.body as HTMLElement).focus(); } catch {}
}

function enterIdle() {
  mode = "idle"; action = "none"; down = null; hoverWin = null;
  sel = { l: 0, t: 0, r: 0, b: 0 };
  selEl.classList.remove("rec");
  for (const el of [selEl, hot, toolbar, panel, sizebadge, textIn]) el.classList.add("hidden");
  handlesEl.innerHTML = "";
  annot.enabled = false;
  mask.classList.remove("hidden");
  hint.textContent = recordMode ? "悬停高亮窗口 → 点击录制 · 或拖拽选区域 · Esc 取消" : HINT_DEFAULT;
  hint.classList.remove("hidden");
}

async function closeSnap() {
  try { clearForCapture(); } catch {}
  try { await invoke("close_snap"); } catch {}
}

// ---- selection rendering --------------------------------------------------

function paintSel() {
  Object.assign(selEl.style, { left: sel.l + "px", top: sel.t + "px", width: sel.r - sel.l + "px", height: sel.b - sel.t + "px" });
  selEl.classList.remove("hidden");
  const w = Math.round((sel.r - sel.l) * dpr), h = Math.round((sel.b - sel.t) * dpr);
  sizebadge.textContent = `${w} × ${h}`;
  let bx = sel.l, by = sel.t - 24;
  if (by < 2) by = sel.t + 4;
  Object.assign(sizebadge.style, { left: bx + "px", top: by + "px" });
  sizebadge.classList.remove("hidden");
}

const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
function handlePos(dir: string): { x: number; y: number } {
  const cx = (sel.l + sel.r) / 2, cy = (sel.t + sel.b) / 2;
  const x = dir.includes("w") ? sel.l : dir.includes("e") ? sel.r : cx;
  const y = dir.includes("n") ? sel.t : dir.includes("s") ? sel.b : cy;
  return { x, y };
}
function paintHandles() {
  handlesEl.innerHTML = "";
  for (const dir of HANDLE_DIRS) {
    const { x, y } = handlePos(dir);
    const d = document.createElement("div");
    d.className = `handle ${dir}`;
    d.dataset.dir = dir;
    Object.assign(d.style, { left: x + "px", top: y + "px" });
    handlesEl.appendChild(d);
  }
}

function paintHot() {
  Object.assign(hot.style, { left: sel.l + "px", top: sel.t + "px", width: sel.r - sel.l + "px", height: sel.b - sel.t + "px" });
  hot.style.cursor = tool === "move" ? "move" : tool === "text" ? "text" : "crosshair";
  hot.classList.remove("hidden");
}

function commitSelected() {
  sel = { l: clampX(sel.l), t: clampY(sel.t), r: clampX(sel.r), b: clampY(sel.b) };
  if (sel.r - sel.l < 2 || sel.b - sel.t < 2) { enterIdle(); return; }
  mode = "selected";
  mask.classList.add("hidden"); // the sel's box-shadow does the dimming now
  hint.classList.add("hidden");
  loupe.classList.add("hidden"); chx.classList.add("hidden"); chy.classList.add("hidden");
  paintSel(); paintHandles(); paintHot();
  showToolbar();
  setTool(tool); // refresh annot.enabled + cursor
}

function selectFull() {
  sel = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
  commitSelected();
}

function showToolbar() {
  toolbar.classList.remove("hidden");
  let tx = sel.l, ty = sel.b + 8;
  if (ty + 46 > window.innerHeight) ty = Math.max(8, sel.t - 46);
  tx = Math.max(8, Math.min(tx, window.innerWidth - toolbar.offsetWidth - 8));
  Object.assign(toolbar.style, { left: tx + "px", top: ty + "px" });
}

function setTool(t: Tool | "move") {
  tool = t;
  toolbar.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.tool === t));
  if (t !== "move" && t !== "text") { annot.tool = t as Tool; annot.enabled = true; }
  else annot.enabled = t === "text"; // text armed but committed via inline input
  if (mode === "selected") paintHot();
}

// ---- magnifier + crosshair ------------------------------------------------

function updateLoupe(cx: number, cy: number) {
  const SIZE = 130, SRC = 22;
  const px = Math.round(cx * dpr), py = Math.round(cy * dpr);
  lctx.imageSmoothingEnabled = false;
  lctx.clearRect(0, 0, SIZE, SIZE);
  lctx.drawImage(scr, px - SRC / 2, py - SRC / 2, SRC, SRC, 0, 0, SIZE, SIZE);
  const cell = SIZE / SRC;
  lctx.strokeStyle = "rgba(74,163,255,.9)"; lctx.lineWidth = 1;
  lctx.strokeRect(SIZE / 2 - cell / 2, SIZE / 2 - cell / 2, cell, cell);
  let hex = "";
  try {
    const d = sctx.getImageData(px, py, 1, 1).data;
    hex = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  } catch {}
  loupeInfo.textContent = `${px}, ${py}  ${hex}`;
  let lx = cx + 16, ly = cy + 16;
  if (lx + SIZE > window.innerWidth) lx = cx - SIZE - 16;
  if (ly + SIZE + 22 > window.innerHeight) ly = cy - SIZE - 40;
  Object.assign(loupe.style, { left: lx + "px", top: ly + "px" });
  loupe.classList.remove("hidden");
}

function updateCross(cx: number, cy: number) {
  Object.assign(chx.style, { top: cy + "px" }); chx.classList.remove("hidden");
  Object.assign(chy.style, { left: cx + "px" }); chy.classList.remove("hidden");
}

// ---- pointer state machine ------------------------------------------------

function onDown(e: MouseEvent) {
  if (!cap || e.button !== 0) return;
  const tgt = e.target as HTMLElement;
  if (tgt.closest("#toolbar,#panel,#textIn")) return; // their own handlers
  commitTextIfOpen();
  if (mode === "selected") {
    if (tgt.classList.contains("handle")) { action = "resize"; resizeEdge = tgt.dataset.dir || ""; origSel = { ...sel }; down = { x: e.clientX, y: e.clientY }; return; }
    const inside = e.clientX >= sel.l && e.clientX <= sel.r && e.clientY >= sel.t && e.clientY <= sel.b;
    if (inside) {
      // 任何工具(文字除外)下: 点中已画形状(像素上/框上)→ 直接拖它, 不必切到移动模式。
      // 移动模式只是没点中形状时移动选区框 = 更顺手, 但不是"想挪就必须切过去"。
      if (tool !== "text") {
        const hit = annot.hitTest(e.clientX, e.clientY);
        if (hit >= 0) { action = "dragshape"; dragShapeIdx = hit; down = { x: e.clientX, y: e.clientY }; return; }
      }
      if (tool === "text") { openTextInput(e.clientX, e.clientY); return; }
      if (tool === "move") { action = "move"; origSel = { ...sel }; down = { x: e.clientX, y: e.clientY }; return; }
      action = "draw"; annot.onDown(e.clientX, e.clientY); return;
    }
    // clicked outside the selection → start a fresh one
    enterIdle();
  }
  action = "create"; down = { x: e.clientX, y: e.clientY };
}

function onMove(e: MouseEvent) {
  if (!cap) return;
  const x = e.clientX, y = e.clientY;
  if (action === "create" && down) {
    sel = norm(down, { x, y });
    paintSel();
    loupe.classList.add("hidden");
    return;
  }
  if (action === "move" && down) {
    let dx = x - down.x, dy = y - down.y;
    const w = origSel.r - origSel.l, h = origSel.b - origSel.t;
    let l = clampX(origSel.l + dx), t = clampY(origSel.t + dy);
    l = Math.min(l, window.innerWidth - w); t = Math.min(t, window.innerHeight - h);
    sel = { l, t, r: l + w, b: t + h };
    paintSel(); paintHandles(); paintHot(); positionToolbar();
    return;
  }
  if (action === "resize" && down) {
    const r = { ...origSel };
    if (resizeEdge.includes("w")) r.l = clampX(x);
    if (resizeEdge.includes("e")) r.r = clampX(x);
    if (resizeEdge.includes("n")) r.t = clampY(y);
    if (resizeEdge.includes("s")) r.b = clampY(y);
    sel = { l: Math.min(r.l, r.r), t: Math.min(r.t, r.b), r: Math.max(r.l, r.r), b: Math.max(r.t, r.b) };
    paintSel(); paintHandles(); paintHot(); positionToolbar();
    return;
  }
  if (action === "dragshape" && down) {
    annot.moveShapeBy(dragShapeIdx, x - down.x, y - down.y);
    down = { x, y }; // 增量平移
    return;
  }
  if (action === "draw") { annot.onMove(x, y); return; }
  // idle hover
  if (mode === "idle") {
    if (recordMode) { highlightWindowAt(x, y); return; } // record mode: outline the window under cursor
    updateLoupe(x, y); updateCross(x, y);
  }
}

// In 录制模式, hovering outlines the topmost window under the cursor; clicking it records that window.
function highlightWindowAt(cx: number, cy: number) {
  if (!cap) return;
  const px = cap.x + cx * dpr, py = cap.y + cy * dpr;
  hoverWin = recWindows.find((w) => px >= w.l && px <= w.r && py >= w.t && py <= w.b) || null;
  loupe.classList.add("hidden"); chx.classList.add("hidden"); chy.classList.add("hidden");
  if (hoverWin) {
    sel = physToCssRect(hoverWin);
    selEl.classList.add("rec");
    paintSel();
    sizebadge.textContent = "▶ 点击录制此窗口";
  } else {
    selEl.classList.add("hidden"); sizebadge.classList.add("hidden");
  }
}

function onUp(e: MouseEvent) {
  if (!cap) return;
  if (action === "create" && down) {
    const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
    const dragged = norm(down, { x: e.clientX, y: e.clientY });
    action = "none"; down = null;
    if (recordMode) {
      if (moved < 6 && hoverWin) {
        // a click on a window → record that whole window (recorder follows it if it moves)
        startRegionRecord(hoverWin.l, hoverWin.t, hoverWin.r, hoverWin.b, hoverWin.hwnd);
      } else if (dragged.r - dragged.l >= 6 && dragged.b - dragged.t >= 6) {
        // a dragged custom region → record it (fixed rect, no window follow)
        const [pl, pt, pr, pb] = cssToPhys(dragged);
        startRegionRecord(pl, pt, pr, pb, 0);
      }
      return;
    }
    sel = dragged;
    if (sel.r - sel.l >= 3 && sel.b - sel.t >= 3) commitSelected();
    else enterIdle();
    return;
  }
  if (action === "draw") annot.onUp();
  action = "none"; down = null;
}

function positionToolbar() { if (mode === "selected") showToolbar(); }

// ---- inline text tool -----------------------------------------------------

function openTextInput(cx: number, cy: number) {
  textAt = { x: cx, y: cy };
  textIn.value = "";
  textIn.style.color = annot.color;
  Object.assign(textIn.style, { left: cx + "px", top: cy + "px" });
  textIn.classList.remove("hidden");
  setTimeout(() => textIn.focus(), 0);
}
function commitTextIfOpen() {
  if (textIn.classList.contains("hidden")) return;
  if (textAt && textIn.value) annot.addText(textAt.x, textAt.y, textIn.value, annot.color);
  textIn.classList.add("hidden"); textAt = null;
}
textIn.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { commitTextIfOpen(); window.focus(); }
  else if (e.key === "Escape") { textIn.classList.add("hidden"); textAt = null; window.focus(); }
});
textIn.addEventListener("blur", () => commitTextIfOpen());

// ---- output / crop --------------------------------------------------------

function cropPhys(): [number, number, number, number] {
  const pl = cap!.x + Math.round(sel.l * dpr), pt = cap!.y + Math.round(sel.t * dpr);
  const pr = cap!.x + Math.round(sel.r * dpr), pb = cap!.y + Math.round(sel.b * dpr);
  return [pl, pt, Math.max(pl + 1, pr), Math.max(pt + 1, pb)];
}
function compositePng(): string {
  const [pl, pt, pr, pb] = cropPhys();
  const w = pr - pl, h = pb - pt;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d")!;
  const sx = pl - cap!.x, sy = pt - cap!.y;
  cx.drawImage(scr, sx, sy, w, h, 0, 0, w, h);
  cx.drawImage(annoEl, sx, sy, w, h, 0, 0, w, h);
  return c.toDataURL("image/png").split(",")[1];
}

// ---- 结构化 Markdown 导出 -------------------------------------------------
// 把冻结图的元信息 + 每个标注形状(类型/坐标/颜色/文字)+ 图片路径拼成一份 Markdown,
// 坐标是"裁剪后图像像素"(原点=裁剪框左上, 与导出的 PNG 一一对应), 便于 AI 直接读懂"箭头从哪到哪、
// 框住哪块区域、写了什么字"。形状的 pts 是全帧画布坐标, 减去裁剪原点(ox,oy)得到裁剪相对坐标。
interface PointAt { name: string; control_type: string; rect: [number, number, number, number]; }
// 统一捕获: 这张结构化截图压在哪个 omni 实体上(material/计划/笔记/项目/任务)。Rust omni_capture 返回。
interface OmniResult { omni_uri: string | null; note_id: string | null; }
const TOOL_CN: Record<string, string> = {
  rect: "矩形", ellipse: "椭圆", arrow: "箭头", line: "直线",
  pen: "画笔", highlight: "荧光标记", mosaic: "马赛克遮挡", text: "文字",
};
// 裁剪原点(全帧画布坐标)+ 尺寸 —— shape 的 pts 减去 (ox,oy) 即裁剪相对像素。
function cropMeta() {
  const [pl, pt, pr, pb] = cropPhys();
  return { ox: pl - cap!.x, oy: pt - cap!.y, w: pr - pl, h: pb - pt };
}
// 每个标注"指向"的解析点 → 屏幕物理坐标(全帧画布坐标 + 显示器原点)。mosaic 返回哨兵不解析。
function resolvePointScreen(s: Shape): [number, number] {
  if (s.tool === "mosaic") return [-1, -1];
  const a = s.pts[0], b = s.pts[s.pts.length - 1];
  let px: number, py: number;
  if (s.tool === "arrow" || s.tool === "line" || s.tool === "pen" || s.tool === "highlight") { px = b.x; py = b.y; }
  else if (s.tool === "text") { px = a.x; py = a.y; }
  else { px = (a.x + b.x) / 2; py = (a.y + b.y) / 2; } // rect / ellipse 中心
  return [Math.round(cap!.x + px), Math.round(cap!.y + py)];
}
// 详细 Markdown —— 存进 .md 文件(详情都在文件里); 剪贴板只放 [[该文件路径]], 粘贴时短。
// 「指向」只在解析出【有名字】的真实元素时才附(否则全是没用的 [Group] (无名))。坐标 = 裁剪相对像素。
function buildMarkdown(imgPath: string, shapes: Shape[], ox: number, oy: number, w: number, h: number, hits: (PointAt | null)[], omni?: OmniResult | null): string {
  const P = (p: Pt) => `(${p.x - ox},${p.y - oy})`;
  const ts = (() => { try { return new Date().toISOString(); } catch { return ""; } })();
  const L: string[] = [];
  L.push("---");
  L.push("kind: annotated-screenshot");
  L.push(`image: ${imgPath}`);
  L.push(`size: ${w}x${h}`);
  L.push(`dpi_scale: ${cap!.scale}`);
  if (ts) L.push(`captured_at: ${ts}`);
  // 统一捕获: 这张截图压在哪个 omni 实体上(自动解析, dashboard 没在跑则不带此行)。
  if (omni && omni.omni_uri) L.push(`omni_target: ${omni.omni_uri}`);
  if (omni && omni.note_id) L.push(`omni_note: ${omni.note_id}`);
  L.push("coord_space: image-pixels  # 裁剪后图像像素, 原点左上, +x 右 / +y 下");
  L.push("---");
  L.push("");
  L.push(`![标注截图](${imgPath})`);
  if (omni && omni.omni_uri) {
    L.push("");
    L.push(`**指向实体**: \`${omni.omni_uri}\`${omni.note_id ? `（已挂札记 ${omni.note_id}）` : ""}`);
  }
  L.push("");
  L.push(`## 标注（${shapes.length}）`);
  if (!shapes.length) L.push("_（无标注，仅截图）_");
  shapes.forEach((s, i) => {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const name = TOOL_CN[s.tool] || s.tool;
    let geo: string;
    if (s.tool === "rect" || s.tool === "ellipse" || s.tool === "mosaic") {
      const l = Math.min(a.x, b.x) - ox, t = Math.min(a.y, b.y) - oy;
      const ww = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
      geo = `区域 (${l},${t}) ${ww}×${hh}，中心 (${Math.round(l + ww / 2)},${Math.round(t + hh / 2)})`;
      if (s.tool === "mosaic") geo += "（已遮挡）";
    } else if (s.tool === "text") {
      geo = `锚点 ${P(a)}，内容 "${(s.text || "").replace(/"/g, '\\"')}"`;
    } else { // arrow / line / pen / highlight
      geo = `${P(a)} → ${P(b)}，${s.pts.length} 点`;
    }
    L.push(`${i + 1}. **${name}** ${s.color}，粗 ${s.width} — ${geo}`);
    const pa = hits[i];
    if (pa && pa.name) L.push(`   - 指向: ${pa.control_type ? pa.control_type + " " : ""}"${pa.name}"`);
  });
  L.push("");
  return L.join("\n");
}
// 只保留与裁剪框有交集的形状(框选小图时, 框外的标注不进 Markdown)。
function shapesInCrop(shapes: Shape[], ox: number, oy: number, w: number, h: number): Shape[] {
  return shapes.filter((s) => {
    const xs = s.pts.map((p) => p.x - ox), ys = s.pts.map((p) => p.y - oy);
    const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
    return r >= 0 && l <= w && b >= 0 && t <= h;
  });
}

async function doAction(act: string) {
  if (!cap || mode !== "selected") return;
  commitTextIfOpen();
  const [pl, pt, pr, pb] = cropPhys();
  const png = compositePng();
  try {
    if (act === "md") {
      // 复制为 Markdown: 存 PNG → 解析每个标注指向的真实 UI 元素 + 整张截图压在哪个 omni 实体上
      // → 拼【详细】Markdown(含 omni 实体解析) → 写成 .md 文件; 剪贴板只放 [[该 .md 路径]]。
      // 评论不另起输入框: 直接复用截图里的文字标注。omni 解析走 Rust(server-to-server, 无 CORS),
      // best-effort —— dashboard 没在跑就安静跳过, 绝不报错、绝不卡住导出。
      const path = await invoke<string>("save_image", { pngBase64: png });
      const { ox, oy, w: cw, h: ch } = cropMeta();
      const shapes = shapesInCrop(annot.getShapes(), ox, oy, cw, ch);
      const comment = shapes.filter((s) => s.tool === "text" && s.text).map((s) => (s.text || "").trim()).filter(Boolean).join("\n");
      // 并行: 每个标注指向的元素 + 整张截图的 omni 实体(都带超时兜底)。
      const pts = shapes.map(resolvePointScreen);
      const [hits, omni] = await Promise.all([
        Promise.race([
          invoke<(PointAt | null)[]>("resolve_points_at", { points: pts }),
          new Promise<(PointAt | null)[]>((res) => setTimeout(() => res(shapes.map(() => null)), 1500)),
        ]).catch(() => shapes.map(() => null)),
        Promise.race([
          invoke<OmniResult>("omni_capture", { x: Math.round((pl + pr) / 2), y: Math.round((pt + pb) / 2), l: pl, t: pt, r: pr, b: pb, comment, pngBase64: png }),
          new Promise<OmniResult>((res) => setTimeout(() => res({ omni_uri: null, note_id: null }), 3000)),
        ]).catch(() => ({ omni_uri: null, note_id: null }) as OmniResult),
      ]);
      const md = buildMarkdown(path, shapes, ox, oy, cw, ch, hits, omni);
      let mdPath = path.replace(/\.png$/i, ".md"); // fallback
      try { mdPath = await invoke<string>("save_markdown", { md, pngPath: path }); } catch {}
      await invoke("copy_text", { text: `[[${mdPath}]]` }); // 剪贴板 = 文件链接, 不是长内容
      await closeSnap();
    } else if (act === "copy") {
      await invoke("save_image", { pngBase64: png }); // persist to the history folder
      await invoke("copy_image", { pngBase64: png });
      await closeSnap();
    } else if (act === "save") {
      const path = await invoke<string>("save_image", { pngBase64: png });
      await invoke("copy_text", { text: path }); // path on the clipboard, ready to paste
      await closeSnap();
    } else if (act === "pin") {
      await invoke("save_image", { pngBase64: png });
      await invoke("pin_image", { pngBase64: png, x: pl, y: pt, w: pr - pl, h: pb - pt });
      await closeSnap();
    } else if (act === "ocr") {
      const text = await invoke<string>("ocr_region", { pngBase64: png });
      showPanel("OCR 结果", `<div class="pv" style="white-space:pre-wrap">${esc(text) || "(无文字)"}</div>`);
    }
  } catch (err) {
    showPanel("提示", `<div class="pv">${esc(String(err))}</div>`);
  }
}

// 区域录制: hand the selected PHYSICAL rect to region_rec, then close the frozen overlay so the
// recorder captures the LIVE desktop (a short delay lets the hidden overlay clear before frame 0).
async function startRegionRecord(pl: number, pt: number, pr: number, pb: number, hwnd: number) {
  if (!cap) return;
  // brief confirmation in the snap panel (no extra window) before closing + recording
  showPanel("● 开始录屏", `<div class="pv">${hwnd ? "正在录制选中的<b>窗口</b>(它移动也会跟着录)" : "正在录制选中<b>区域</b>"}。<br>到录制条点 <b>■ 停止</b>,或按 <b>Ctrl + Alt + R</b> 结束。</div>`);
  await new Promise((r) => setTimeout(r, 950));
  await closeSnap();
  await new Promise((r) => setTimeout(r, 220)); // let the hidden overlay clear before frame 0
  try {
    await invoke("region_record_start", { l: Math.round(pl), t: Math.round(pt), r: Math.round(pr), b: Math.round(pb), hwnd: hwnd || 0 });
  } catch {}
}

// ---- history panel --------------------------------------------------------

function showPanel(title: string, bodyHtml: string) {
  panel.innerHTML = `<div class="ptitle"><span>${esc(title)}</span><span class="x" id="px">✕</span></div>${bodyHtml}`;
  panel.classList.remove("hidden");
  const px = document.getElementById("px");
  if (px) px.onclick = () => panel.classList.add("hidden");
  // center-ish
  Object.assign(panel.style, { left: Math.max(12, (window.innerWidth - 520) / 2) + "px", top: "60px" });
}

async function showHistory() {
  let shots: Shot[] = [];
  try { shots = await invoke<Shot[]>("list_shots"); } catch (e) { showPanel("历史", `<div class="pv">${esc(String(e))}</div>`); return; }
  if (!shots.length) { showPanel("截图历史", `<div class="hempty">还没有截图。框选后复制 / 保存 / 贴图都会存进这里。</div>`); return; }
  const cards = shots.slice(0, 60).map((s, i) =>
    `<div class="hcard" data-i="${i}"><img data-thumb="${esc(s.path)}" /><div class="hmeta">${esc(s.name)}　${s.w}×${s.h}</div>` +
    `<div class="hacts">` +
    `<button data-h="copyimg" data-p="${esc(s.path)}">复制图</button>` +
    `<button data-h="copypath" data-p="${esc(s.path)}">复制路径</button>` +
    `<button data-h="reveal" data-p="${esc(s.path)}">打开位置</button>` +
    `<button data-h="del" data-p="${esc(s.path)}">删除</button>` +
    `</div></div>`).join("");
  showPanel(`截图历史 (${shots.length})`, `<div class="hgrid">${cards}</div>`);
  // lazy-load thumbnails
  panel.querySelectorAll("img[data-thumb]").forEach(async (img) => {
    const p = (img as HTMLElement).dataset.thumb!;
    try { (img as HTMLImageElement).src = await invoke<string>("read_image_b64", { path: p }); } catch {}
  });
  panel.querySelectorAll("button[data-h]").forEach((b) => {
    (b as HTMLElement).onclick = async (ev) => {
      ev.stopPropagation();
      const el = b as HTMLElement; const p = el.dataset.p!;
      try {
        if (el.dataset.h === "copyimg") await invoke("copy_image_file", { path: p });
        else if (el.dataset.h === "copypath") await invoke("copy_text", { text: p });
        else if (el.dataset.h === "reveal") await invoke("reveal_shot", { path: p });
        else if (el.dataset.h === "del") { await invoke("delete_shot", { path: p }); showHistory(); }
      } catch {}
    };
  });
}

// ---- toolbar / keyboard wiring --------------------------------------------

toolbar.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset.tool) { setTool(el.dataset.tool as Tool | "move"); return; }
  if (el.dataset.color) {
    annot.color = el.dataset.color;
    toolbar.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b === el));
    return;
  }
  const act = el.dataset.act;
  if (!act) return;
  if (act === "undo") annot.undo();
  else if (act === "redo") annot.redo();
  else if (act === "history") showHistory();
  else doAction(act);
});

function onEscape() {
  // 一次 Esc 直接退出。只有当前正开着浮层/文字输入时, Esc 先关那个(仍是一次一动作)。
  // 重新框选改用"在选区外点一下"(onDown 会 enterIdle), 不再占用 Esc。
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  if (!textIn.classList.contains("hidden")) { textIn.classList.add("hidden"); textAt = null; return; }
  closeSnap();
}

window.addEventListener("keydown", (e) => {
  if (document.activeElement === textIn) return;
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); onEscape(); return; }
  if (recordMode) {
    // 录制模式: Enter records the hovered window, or the full screen if nothing is highlighted
    if (k === "Enter") {
      e.preventDefault();
      if (hoverWin) startRegionRecord(hoverWin.l, hoverWin.t, hoverWin.r, hoverWin.b, hoverWin.hwnd);
      else { const [pl, pt, pr, pb] = cssToPhys({ l: 0, t: 0, r: window.innerWidth, b: window.innerHeight }); startRegionRecord(pl, pt, pr, pb, 0); }
    }
    return; // record mode has no annotation/copy keys
  }
  if (mode === "selected") {
    // 回车 / 双击 / Ctrl+C = 复制为 Markdown(结构化标注+路径, 喂 AI); Ctrl+Shift+C = 复制纯图片
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "c" || k === "C")) { e.preventDefault(); doAction("copy"); return; }
    if (k === "Enter") { e.preventDefault(); doAction("md"); return; }
    if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "C")) { e.preventDefault(); doAction("md"); return; }
    if ((e.ctrlKey || e.metaKey) && (k === "s" || k === "S")) { e.preventDefault(); doAction("save"); return; }
    if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) { e.preventDefault(); annot.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) { e.preventDefault(); annot.redo(); return; }
    if (k === "F3") { e.preventDefault(); doAction("pin"); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const map: Record<string, Tool | "move"> = { m: "move", r: "rect", o: "ellipse", a: "arrow", l: "line", p: "pen", h: "highlight", k: "mosaic", t: "text" };
      const nt = map[k.toLowerCase()];
      if (nt) { e.preventDefault(); setTool(nt); return; }
    }
  } else {
    if (k === "Enter") { e.preventDefault(); selectFull(); doAction("md"); return; }
    if (k === "F3") { e.preventDefault(); selectFull(); doAction("pin"); return; }
  }
});

// double-click inside the selection copies as Markdown (record mode records on single click)
document.addEventListener("dblclick", (e) => {
  if (recordMode || mode !== "selected") return;
  const inside = e.clientX >= sel.l && e.clientX <= sel.r && e.clientY >= sel.t && e.clientY <= sel.b;
  if (inside) doAction("md");
});

// right-click anywhere cancels (selection first, then the whole snip)
window.addEventListener("contextmenu", (e) => { e.preventDefault(); onEscape(); });

document.addEventListener("mousedown", onDown);
document.addEventListener("mousemove", onMove);
document.addEventListener("mouseup", onUp);

listen<boolean>("snap-summon", (e) => { recordMode = e.payload === true; doCapture(); });
