// poof 贴图 (pin) window — a floating, always-on-top image, Snipaste-style.
// Drag to move · wheel to zoom · Ctrl+wheel or [ ] for opacity · 1/2 rotate · H/V flip
// · Ctrl+C copy · Ctrl+S save · T toggle always-on-top · Esc / double-click close.
// The PNG (base64) and its size are injected by pin_image via an initialization script.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

declare global { interface Window { __pinB64?: string; __pinW?: number; __pinH?: number; } }

const win = getCurrentWindow();
const img = document.getElementById("img") as HTMLImageElement;
const wrap = document.getElementById("wrap")!;
const menu = document.getElementById("menu")!;
const toastEl = document.getElementById("toast")!;

const b64 = window.__pinB64 || "";
const cw0 = window.__pinW || 400; // content size in physical px (un-rotated)
const ch0 = window.__pinH || 300;

let zoom = 1, rot = 0, flipH = false, flipV = false, opacity = 1, aot = true;
const dpr = () => window.devicePixelRatio || 1;

img.src = `data:image/png;base64,${b64}`;

let toastT: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg; toastEl.classList.remove("hidden");
  clearTimeout(toastT); toastT = window.setTimeout(() => toastEl.classList.add("hidden"), 1100);
}

// Re-entrancy + no-op guards. setSize() fires a DOM 'resize'; if apply() ran on resize it
// would loop setSize→resize→setSize forever and peg the thread (freezing the desktop), so
// there is NO resize listener and apply() only calls setSize when the size truly changed.
let applying = false;
let lastW = -1, lastH = -1;
async function apply() {
  if (applying) return;
  applying = true;
  try {
    const swap = rot % 180 !== 0;
    const physW = Math.max(16, Math.round((swap ? ch0 : cw0) * zoom));
    const physH = Math.max(16, Math.round((swap ? cw0 : ch0) * zoom));
    if (physW !== lastW || physH !== lastH) {
      lastW = physW; lastH = physH;
      try { await win.setSize(new PhysicalSize(physW, physH)); } catch {}
    }
    const cssW = physW / dpr(), cssH = physH / dpr();
    // pre-rotation image box (so after rotate it fills the window)
    const baseW = swap ? cssH : cssW, baseH = swap ? cssW : cssH;
    Object.assign(img.style, {
      width: baseW + "px", height: baseH + "px",
      left: (cssW - baseW) / 2 + "px", top: (cssH - baseH) / 2 + "px",
      transform: `rotate(${rot}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
      opacity: String(opacity),
    });
  } finally {
    applying = false;
  }
}

img.addEventListener("load", apply);

// always-available close button (in case keyboard focus is ever lost)
document.getElementById("close")!.addEventListener("click", (e) => { e.stopPropagation(); win.close(); });

// drag to move the whole window
wrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  menu.classList.add("hidden");
  win.startDragging().catch(() => {});
});

// wheel: zoom; Ctrl+wheel: opacity
wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    opacity = Math.min(1, Math.max(0.1, opacity + (e.deltaY < 0 ? 0.08 : -0.08)));
    toast(`不透明度 ${Math.round(opacity * 100)}%`); img.style.opacity = String(opacity);
  } else {
    zoom = Math.min(8, Math.max(0.1, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    toast(`缩放 ${Math.round(zoom * 100)}%`); apply();
  }
}, { passive: false });

async function copy() { try { await invoke("copy_image", { pngBase64: b64 }); toast("已复制到剪贴板"); } catch {} }
async function save() { try { const p = await invoke<string>("save_image", { pngBase64: b64 }); await invoke("copy_text", { text: p }); toast("已保存，路径在剪贴板"); } catch {} }
async function toggleAot() { aot = !aot; try { await win.setAlwaysOnTop(aot); } catch {} toast(aot ? "置顶" : "取消置顶"); }

window.addEventListener("keydown", (e) => {
  const k = e.key;
  if (k === "Escape") { win.close(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "C")) { e.preventDefault(); copy(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === "s" || k === "S")) { e.preventDefault(); save(); return; }
  if (k === "1") { rot = (rot + 270) % 360; apply(); }
  else if (k === "2") { rot = (rot + 90) % 360; apply(); }
  else if (k === "h" || k === "H") { flipH = !flipH; apply(); }
  else if (k === "v" || k === "V") { flipV = !flipV; apply(); }
  else if (k === "t" || k === "T") { toggleAot(); }
  else if (k === "[") { opacity = Math.max(0.1, opacity - 0.08); img.style.opacity = String(opacity); toast(`不透明度 ${Math.round(opacity * 100)}%`); }
  else if (k === "]") { opacity = Math.min(1, opacity + 0.08); img.style.opacity = String(opacity); toast(`不透明度 ${Math.round(opacity * 100)}%`); }
  else if (k === "+" || k === "=") { zoom = Math.min(8, zoom * 1.1); apply(); toast(`缩放 ${Math.round(zoom * 100)}%`); }
  else if (k === "-" || k === "_") { zoom = Math.max(0.1, zoom / 1.1); apply(); toast(`缩放 ${Math.round(zoom * 100)}%`); }
});

window.addEventListener("dblclick", () => win.close());

// right-click context menu
const MENU = [
  ["copy", "复制", "Ctrl+C"], ["save", "保存", "Ctrl+S"], ["sep", "", ""],
  ["rl", "向左旋转", "1"], ["rr", "向右旋转", "2"], ["fh", "水平翻转", "H"], ["fv", "垂直翻转", "V"], ["sep", "", ""],
  ["aot", "置顶开关", "T"], ["reset", "还原", ""], ["sep", "", ""], ["close", "关闭", "Esc"],
];
function buildMenu() {
  menu.innerHTML = MENU.map(([id, label, sc]) =>
    id === "sep" ? `<div class="sep"></div>` : `<div class="mi" data-id="${id}"><span>${label}</span><span class="sc">${sc}</span></div>`).join("");
  menu.querySelectorAll(".mi").forEach((m) => {
    (m as HTMLElement).onclick = () => {
      const id = (m as HTMLElement).dataset.id;
      menu.classList.add("hidden");
      if (id === "copy") copy();
      else if (id === "save") save();
      else if (id === "rl") { rot = (rot + 270) % 360; apply(); }
      else if (id === "rr") { rot = (rot + 90) % 360; apply(); }
      else if (id === "fh") { flipH = !flipH; apply(); }
      else if (id === "fv") { flipV = !flipV; apply(); }
      else if (id === "aot") toggleAot();
      else if (id === "reset") { zoom = 1; rot = 0; flipH = flipV = false; opacity = 1; apply(); }
      else if (id === "close") win.close();
    };
  });
}
buildMenu();
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  let x = Math.min(e.clientX, window.innerWidth - 180), y = Math.min(e.clientY, window.innerHeight - 240);
  Object.assign(menu.style, { left: Math.max(4, x) + "px", top: Math.max(4, y) + "px" });
  menu.classList.remove("hidden");
});
window.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest("#menu")) menu.classList.add("hidden"); });
