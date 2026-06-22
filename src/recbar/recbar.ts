// poof 录制条 — the always-on-top recording control. Shows a pulsing dot, elapsed time, and a
// 停止 button so you ALWAYS know it's recording and can stop with a click (not only the hotkey).
// Shown by region_record_start (positioned just outside the recorded rect) and hidden on stop.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const $ = (id: string) => document.getElementById(id)!;
const timeEl = $("time");
let startMs = 0;
let timer: number | undefined;

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function tick() {
  timeEl.textContent = fmt(Date.now() - startMs);
}

// region_record_start emits this with the session start time
listen<number>("rec-started", (e) => {
  startMs = e.payload || Date.now();
  tick();
  if (timer == null) timer = window.setInterval(tick, 500);
});
listen("rec-stopped", () => {
  if (timer != null) { clearInterval(timer); timer = undefined; }
});

$("stop").addEventListener("click", async () => {
  try { await invoke("region_record_stop"); } catch {}
});

// self-heal: if recording ends by ANY route (button / Ctrl+Alt+R / the window closing), vanish
setInterval(async () => {
  try {
    if (!(await invoke<boolean>("region_is_recording"))) {
      if (timer != null) { clearInterval(timer); timer = undefined; }
      getCurrentWindow().hide().catch(() => {});
    }
  } catch {}
}, 1000);

