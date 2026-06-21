// poof 录制 — records this very page (poof's own app:// surface) with rrweb, wraps each
// rrweb event in the schema envelope, batches, and ships via Tauri IPC to record_cmd.rs.
// Started by the "record-summon" event (emitted by show_record) so a fresh session begins
// each time the window is summoned — NOT on page load (the window loads hidden at startup).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

declare global {
  interface Window { rrweb: any; __recordTitle?: string }
}

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("status"), dot = $("dot"), stopBtn = $("stop") as HTMLButtonElement;

let sid = "";
let seq = 0;
let buffer: any[] = [];
let stopFn: (() => void) | null = null;
let flushTimer: number | undefined;
let inflight: Promise<void> = Promise.resolve();
let n = 0;

// Serialized, ordered flush: each batch is chained onto `inflight` so record_event lands
// in order and never overlaps, and the batch is only considered sent once the IPC resolves.
// On a write failure we HALT recording (bounded memory + surfaced error) rather than
// silently dropping events or letting the buffer grow forever.
function flush(): Promise<void> {
  if (!buffer.length || !sid) return inflight;
  const batch = buffer;
  buffer = [];
  inflight = inflight.then(async () => {
    try {
      await invoke("record_event", { batch });
    } catch (e) {
      statusEl.textContent = "录制写入失败,已停止:" + String(e);
      try { if (stopFn) stopFn(); } catch {}
      stopFn = null;
      dot.classList.remove("on");
      stopBtn.disabled = true;
    }
  });
  return inflight;
}
function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => { flushTimer = undefined; flush(); }, 250);
}

// Redaction at the injection point (schema §脱敏在注入端做). Password fields are masked;
// fields whose ANY attribute or class hints at a secret are reduced to a length count.
function maskInput(text: string, el: any): string {
  const type = (el && el.getAttribute && el.getAttribute("type")) || "";
  if (type === "password") return "*".repeat(text.length);
  let hay = "";
  try {
    if (el && el.attributes) for (const a of el.attributes) hay += " " + a.name + "=" + a.value;
    if (el && el.className) hay += " " + el.className;
  } catch {}
  if (/secret|password|token|api.?key|auth|credential|otp|cvv|card|私钥|密码|密钥/i.test(hay)) {
    return String(text.length); // schema: 键入默认只记字数
  }
  return text;
}

async function start() {
  if (stopFn) return; // already recording
  if (!window.rrweb || !window.rrweb.record) { statusEl.textContent = "rrweb 未加载,录制不可用"; return; }
  // fresh page state for a clean session
  $("list").innerHTML = ""; n = 0;
  seq = 0; buffer = [];
  try {
    sid = await invoke<string>("record_start", { title: window.__recordTitle || "poof 录制测试面" });
  } catch (e) { statusEl.textContent = "无法开始: " + String(e); return; }
  stopBtn.disabled = false;
  dot.classList.add("on");
  statusEl.textContent = "● 录制中 — 操作这个页面,完事点「停止并保存」";
  stopFn = window.rrweb.record({
    emit(ev: any) {
      buffer.push({ sid, seq: seq++, ts: Date.now(), surface: "poof", src: location.href, kind: "rrweb", p: { ev } });
      if (buffer.length >= 50) flush(); else scheduleFlush();
    },
    maskAllInputs: false,
    maskInputOptions: { password: true },
    maskTextClass: "rr-mask",
    blockClass: "rr-block",
    maskInputFn: maskInput,
    checkoutEveryNth: 100,
  });
}

async function stop() {
  if (!stopFn) return;
  try { stopFn(); } catch {}
  stopFn = null;
  if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = undefined; }
  await flush();   // queue the final batch
  await inflight;  // wait until every batch has actually landed before stopping the session
  try { await invoke("record_stop"); } catch {}
  dot.classList.remove("on");
  statusEl.textContent = "✓ 已保存。Esc / ✕ 关闭,或去「回放」查看";
  stopBtn.disabled = true;
}

// Closing always saves first (so a session is never lost on close); hide() keeps the
// window alive for re-summon. The Rust CloseRequested handler is the backstop for Alt+F4.
async function closeWindow() {
  if (stopFn) { try { await stop(); } catch {} }
  try { await getCurrentWindow().hide(); } catch {}
}

stopBtn.addEventListener("click", () => { stop(); });
$("close").addEventListener("click", () => { closeWindow(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeWindow(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
window.addEventListener("beforeunload", () => flush());

// demo interactions (mutate the DOM so rrweb has something to capture)
$("add").addEventListener("click", () => {
  const li = document.createElement("li");
  li.textContent = "第 " + ++n + " 行 (" + new Date().toLocaleTimeString() + ")";
  $("list").appendChild(li);
});
$("clear").addEventListener("click", () => { $("list").innerHTML = ""; n = 0; });

listen("record-summon", () => start());
