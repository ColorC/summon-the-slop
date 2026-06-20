import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "../lib";

// modern dark theme (Tokyo Night) — reads well for claude/codex TUIs
const THEME = {
  background: "#0e0f14",
  foreground: "#e6e8ee",
  cursor: "#7aa2f7",
  cursorAccent: "#0e0f14",
  selectionBackground: "#2a3050",
  black: "#1b1d27",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#414868",
  brightRed: "#ff899d",
  brightGreen: "#b9f27c",
  brightYellow: "#ff9e64",
  brightBlue: "#8db0ff",
  brightMagenta: "#c7a9ff",
  brightCyan: "#a4daff",
  brightWhite: "#e6e8ee",
};

/** One xterm.js terminal bound to a Rust PTY session. xterm.js is the industry-standard
 *  TUI host (VSCode/Hyper use it) and is exactly what claude/codex CLIs want. The shell
 *  is launched, then — once up — startCommand (claude/codex) + initialInput are typed in. */
export function TerminalView({
  id,
  startCommand,
  initialInput,
}: {
  id: string;
  startCommand?: string;
  initialInput?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Consolas", monospace',
      fontSize: 15,
      lineHeight: 1.15,
      letterSpacing: 0.3,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    try {
      // crisp GPU rendering; falls back to canvas if WebGL is unavailable
      term.loadAddon(new WebglAddon());
    } catch {
      /* no webgl — canvas renderer is fine */
    }
    try {
      fit.fit();
    } catch {
      /* not sized yet */
    }

    let alive = true;
    let gotData = false;
    const timers: number[] = [];
    const unData = listen<string>(`pty:data:${id}`, (e) => {
      if (!alive) return;
      if (!gotData) {
        gotData = true;
        setLoading(false);
      }
      term.write(e.payload);
    });
    const unExit = listen(`pty:exit:${id}`, () => {
      if (alive) term.write("\r\n\x1b[90m[进程已退出]\x1b[0m\r\n");
    });

    ptySpawn(id, term.cols || 80, term.rows || 24)
      .then(() => {
        if (!alive) return;
        if (startCommand) {
          timers.push(window.setTimeout(() => ptyWrite(id, startCommand + "\r"), 500));
        }
        if (initialInput) {
          // give the CLI time to take over stdin before sending the query
          timers.push(window.setTimeout(() => ptyWrite(id, initialInput + "\r"), 2200));
        }
      })
      .catch((err) => {
        setLoading(false);
        term.write(`\r\n\x1b[31m[PTY 启动失败 — EDR?] ${err}\x1b[0m\r\n`);
      });

    const onData = term.onData((d) => ptyWrite(id, d));
    const doFit = () => {
      try {
        fit.fit();
        ptyResize(id, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(doFit);
    if (ref.current) ro.observe(ref.current);
    // the panel may size up after mount → refit a few times so xterm isn't 0×0
    [60, 250, 600, 1200].forEach((ms) => timers.push(window.setTimeout(doFit, ms)));

    return () => {
      alive = false;
      timers.forEach((t) => clearTimeout(t));
      ro.disconnect();
      onData.dispose();
      unData.then((f) => f());
      unExit.then((f) => f());
      ptyKill(id);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="term-host">
      <div className="term" ref={ref} />
      {loading && (
        <div className="term-loading">
          <Loader2 size={18} className="spin" />
          正在启动 {startCommand || "PowerShell"}…
        </div>
      )}
    </div>
  );
}
