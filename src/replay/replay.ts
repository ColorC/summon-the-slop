// poof 回放 — lists recorded sessions and plays the chosen one with rrweb's Replayer.
// Pulls events via read_session, keeps only kind=="rrweb" and feeds the raw p.ev to the
// player (schema §落盘: 抽 kind=="rrweb" 的 p.ev). Vanilla UMD Replayer, no framework bridge.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

declare global { interface Window { rrweb: any } }

interface Session { session_path: string; sid: string; start_ms: number; stop_ms: number | null; title: string; event_lines: number }

const $ = (id: string) => document.getElementById(id)!;
const sel = $("sessions") as HTMLSelectElement;
const playerEl = $("player");
const info = $("info");
let replayer: any = null;

async function loadList() {
  info.textContent = "刷新中…";
  let sessions: Session[] = [];
  try { sessions = await invoke<Session[]>("list_sessions"); } catch (e) { info.textContent = String(e); return; }
  sel.innerHTML = "";
  if (!sessions.length) { info.textContent = "还没有录制 — 去「录制」录一段"; playerEl.innerHTML = ""; return; }
  for (const s of sessions) {
    const o = document.createElement("option");
    o.value = s.session_path;
    o.textContent = `${s.title} · ${new Date(s.start_ms).toLocaleString()} · ${s.event_lines} 事件`;
    sel.appendChild(o);
  }
  info.textContent = `${sessions.length} 段`;
  loadSelected();
}

async function loadSelected() {
  const path = sel.value;
  if (!path) return;
  let text = "";
  try { text = await invoke<string>("read_session", { sessionPath: path }); } catch (e) { info.textContent = String(e); return; }
  const events = text.trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e: any) => e && e.kind === "rrweb")
    .map((e: any) => e.p.ev);
  if (replayer) { try { replayer.pause(); } catch {} }
  playerEl.innerHTML = "";
  if (events.length < 2) { info.textContent = "无交互记录(只有初始快照,未捕获操作变化,无法回放)"; replayer = null; return; }
  try {
    replayer = new window.rrweb.Replayer(events, { root: playerEl, skipInactive: true });
    replayer.play();
    info.textContent = `${events.length} rrweb 事件`;
  } catch (e) { info.textContent = "回放失败: " + String(e); }
}

sel.addEventListener("change", loadSelected);
$("play").addEventListener("click", () => replayer && replayer.play());
$("pause").addEventListener("click", () => replayer && replayer.pause());
$("refresh").addEventListener("click", loadList);
$("close").addEventListener("click", () => { getCurrentWindow().hide().catch(() => {}); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); getCurrentWindow().hide().catch(() => {}); } });
listen("replay-summon", () => loadList());
loadList();
