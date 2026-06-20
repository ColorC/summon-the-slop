import { TerminalBar } from "../regions/TerminalBar";

/** Terminal (multi-tab, PowerShell / Claude / Codex over PTY) as its own window. */
export function TerminalWindow() {
  return (
    <div className="win win-term">
      <TerminalBar />
    </div>
  );
}
