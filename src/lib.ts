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
