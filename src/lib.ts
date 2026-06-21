import { invoke } from "@tauri-apps/api/core";

export interface CmdOut {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run `cmd /C <cmd>` with no console window. */
export const runShell = (cmd: string) => invoke<CmdOut>("run_shell", { cmd });

/** Ask the user's own AI (Claude Code headless). */
export const askAi = (prompt: string) => invoke<string>("ask_ai", { prompt });

/** Copy text to the Windows clipboard. */
export const copyText = (text: string) => invoke<void>("copy_text", { text });

// ---- search ----
export interface SearchHit {
  kind: string; // "app" | "file"
  name: string;
  path: string;
  score: number;
}
export const search = (query: string, limit = 30) =>
  invoke<SearchHit[]>("search", { query, limit });
export const openPath = (path: string) => invoke<void>("open_path", { path });

export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
/** Capture a screen rect (client coords == screen coords; window is fullscreen) to a PNG, returns its path. */
export const snapshotRegion = (x: number, y: number, w: number, h: number) =>
  invoke<string>("snapshot_region", { x, y, w, h });
/** Native Windows Properties dialog (v1 of the standard shell menu). */
export const shellMenu = (path: string, _x?: number, _y?: number) =>
  invoke<void>("shell_props", { path });

// ---- pty (terminal) ----
export const ptySpawn = (id: string, cols: number, rows: number, cwd?: string) =>
  invoke<void>("pty_spawn", { id, cols, rows, cwd: cwd ?? null });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

/** Open a heavy surface (terminal/project/review) as its own normal window. */
export const openView = (view: string) => invoke<void>("open_view", { view });

/** Start a new AI chat (opens/focuses the terminal window; queues provider+query). */
export const newChat = (provider: string, query?: string) =>
  invoke<void>("new_chat", { provider, query: query ?? null });
export const takeChatIntents = () =>
  invoke<[string, string | null][]>("take_chat_intents");
