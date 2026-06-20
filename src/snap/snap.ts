// poof 截图 (screenshot/annotate) window. Freeze the screen, drag to select a region,
// annotate it (rect/ellipse/arrow/line/pen/text/highlight/mosaic), then copy / save / pin
// / OCR. No element inspector here — that's the 洞察 mode (native). Esc exits.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Annotator, Tool } from "./anno";

interface Capture { width: number; height: number; x: number; y: number; scale: number; }

const $ = (id: string) => document.getElementById(id)!;
const screen = $("screen") as HTMLCanvasElement;
const anno = $("anno") as HTMLCanvasElement;
const sel = $("sel"), toolbar = $("toolbar"), hint = $("hint"), panel = $("panel");
const sctx = screen.getContext("2d", { willReadFrequently: true })!;
const annot = new Annotator(anno, screen);

let cap: Capture | null = null;
let dpr = 1;
let dragStart: { x: number; y: number } | null = null;
let dragging = false;
let selected = false;
let selRectPhys: [number, number, number, number] = [0, 0, 0, 0];

const toPhys = (cx: number, cy: number) => ({ x: cap!.x + Math.round(cx * dpr), y: cap!.y + Math.round(cy * dpr) });
const esc = (s: string) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function doCapture() {
  const raw = await invoke<ArrayBuffer>("capture_screen");
  const dv = new DataView(raw);
  const w = dv.getInt32(0, true), h = dv.getInt32(4, true);
  cap = { width: w, height: h, x: dv.getInt32(8, true), y: dv.getInt32(12, true), scale: dv.getFloat32(16, true) };
  dpr = window.devicePixelRatio || cap.scale || 1;
  screen.width = anno.width = w;
  screen.height = anno.height = h;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(raw, 20), w, h), 0, 0);
  annot.reset(dpr);
  reset();
  try { await invoke("present_snap"); } catch {}
}

function reset() {
  selected = dragging = false;
  dragStart = null;
  annot.enabled = false;
  for (const el of [sel, toolbar, panel]) el.classList.add("hidden");
  anno.getContext("2d")!.clearRect(0, 0, anno.width, anno.height);
  hint.classList.remove("hidden");
}

function updateSel(a: { x: number; y: number }, b: { x: number; y: number }) {
  const l = Math.min(a.x, b.x), t = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  Object.assign(sel.style, { left: l + "px", top: t + "px", width: w + "px", height: h + "px" });
  sel.classList.remove("hidden");
}

function onDown(e: MouseEvent) {
  if (!cap || e.button !== 0) return;
  if ((e.target as HTMLElement).closest("#toolbar,#panel")) return;
  if (selected) { if (annot.enabled) annot.onDown(e.clientX, e.clientY); return; }
  dragStart = { x: e.clientX, y: e.clientY }; dragging = false;
}

function onMove(e: MouseEvent) {
  if (!cap) return;
  if (selected) { if (annot.enabled) annot.onMove(e.clientX, e.clientY); return; }
  if (dragStart) {
    if (Math.abs(e.clientX - dragStart.x) + Math.abs(e.clientY - dragStart.y) > 4) dragging = true;
    if (dragging) updateSel(dragStart, { x: e.clientX, y: e.clientY });
  }
}

function onUp(e: MouseEvent) {
  if (!cap) return;
  if (selected) { if (annot.enabled) annot.onUp(); return; }
  if (!dragStart) return;
  const s = dragStart; dragStart = null;
  if (dragging) {
    dragging = false;
    selectBox(Math.min(s.x, e.clientX), Math.min(s.y, e.clientY), Math.max(s.x, e.clientX), Math.max(s.y, e.clientY));
  }
}

function selectBox(l: number, t: number, r: number, b: number) {
  const p1 = toPhys(l, t), p2 = toPhys(r, b);
  selRectPhys = [p1.x, p1.y, p2.x, p2.y];
  selected = true;
  annot.enabled = true;
  hint.classList.add("hidden");
  Object.assign(sel.style, { left: l + "px", top: t + "px", width: r - l + "px", height: b - t + "px" });
  sel.classList.remove("hidden");
  showToolbar(l, t, b);
}

function showToolbar(l: number, t: number, b: number) {
  toolbar.classList.remove("hidden");
  let tx = l, ty = b + 8;
  if (ty + 48 > window.innerHeight) ty = Math.max(8, t - 48);
  tx = Math.max(8, Math.min(tx, window.innerWidth - toolbar.offsetWidth - 8));
  Object.assign(toolbar.style, { left: tx + "px", top: ty + "px" });
}

// crop the selection (screenshot + annotations) to a base64 PNG
function compositePng(): string {
  const [l, t, r, b] = selRectPhys;
  const w = r - l, h = b - t;
  const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
  const cx = c.getContext("2d")!;
  const sx = l - cap!.x, sy = t - cap!.y;
  cx.drawImage(screen, sx, sy, w, h, 0, 0, w, h);
  cx.drawImage(anno, sx, sy, w, h, 0, 0, w, h);
  return c.toDataURL("image/png").split(",")[1];
}

function setActive(q: string, btn: HTMLElement) {
  toolbar.querySelectorAll(q).forEach((b) => b.classList.remove("on"));
  btn.classList.add("on");
}

async function close() { try { await invoke("close_snap"); } catch {} reset(); }

toolbar.addEventListener("click", async (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset.tool) { annot.tool = el.dataset.tool as Tool; setActive("[data-tool]", el); return; }
  if (el.dataset.color) { annot.color = el.dataset.color; setActive("[data-color]", el); return; }
  const act = el.dataset.act;
  if (!act) return;
  if (act === "undo") { annot.undo(); return; }
  if (act === "redo2") { reset(); return; }
  const [l, t, r, b] = selRectPhys;
  try {
    if (act === "copy") { await invoke("copy_image", { pngBase64: compositePng() }); await close(); }
    else if (act === "save") { await invoke("save_image", { pngBase64: compositePng() }); await close(); }
    else if (act === "pin") { await invoke("pin_image", { pngBase64: compositePng(), x: l, y: t, w: r - l, h: b - t }); await close(); }
    else if (act === "ocr") {
      const text = await invoke<string>("ocr_region", { pngBase64: compositePng() });
      panel.innerHTML = `<div class="ptitle">OCR 结果</div><div class="pv" style="white-space:pre-wrap">${esc(text) || "(无文字)"}</div>`;
      panel.classList.remove("hidden");
    }
  } catch (err) {
    panel.innerHTML = `<div class="ptitle">提示</div><div class="pv">${esc(String(err))}</div>`;
    panel.classList.remove("hidden");
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (selected) reset(); else close(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === "z" && selected) annot.undo();
});
document.addEventListener("mousedown", onDown);
document.addEventListener("mousemove", onMove);
document.addEventListener("mouseup", onUp);

listen("snap-summon", () => doCapture());
