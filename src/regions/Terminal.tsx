import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "../lib";

/** One xterm.js terminal bound to a Rust PTY session. The shell is launched, then —
 *  once it's up — the startCommand (claude/codex) and optional initialInput (an AI
 *  query) are typed in via pty_write. Writing them at spawn races stdin and is lost. */
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

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0c0d11", foreground: "#d6d8df" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    try {
      fit.fit();
    } catch {
      /* not sized yet */
    }

    let alive = true;
    const timers: number[] = [];
    const unData = listen<string>(`pty:data:${id}`, (e) => {
      if (alive) term.write(e.payload);
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
      .catch((err) => term.write(`\r\n\x1b[31m[PTY 启动失败 — EDR?] ${err}\x1b[0m\r\n`));

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

  return <div className="term" ref={ref} />;
}
