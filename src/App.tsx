import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Command } from "cmdk";
import { SURFACES } from "./surfaces";
import { runShell } from "./lib";
import "./App.css";

export default function App() {
  const [active, setActive] = useState("find");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [q, setQ] = useState("");
  const [summons, setSummons] = useState(0);
  const [pinned, setPinned] = useState(true);

  const hide = useCallback(() => getCurrentWindow().hide(), []);
  const togglePin = useCallback(async () => {
    const v = !pinned;
    await getCurrentWindow().setAlwaysOnTop(v);
    setPinned(v);
  }, [pinned]);

  useEffect(() => {
    const un = listen("summon", () => setSummons((c) => c + 1));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      un.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen, hide]);

  const ActiveComp = SURFACES.find((s) => s.id === active)!.Component;

  return (
    <div className="overlay">
      <div className="panel">
        <header className="topbar" data-tauri-drag-region>
          <span className="brand">poof ✨</span>
          <button className="cmd-trigger" onClick={() => setPaletteOpen(true)}>
            命令面板 <kbd>Ctrl K</kbd>
          </button>
          <button className="cmd-trigger" onClick={togglePin} title="钉屏（置顶开关）">
            {pinned ? "📌 钉住" : "📍 取消钉"}
          </button>
          <span className="hint">
            double-tap Ctrl 召出/收起 · Esc 隐藏 · 召出×{summons}
          </span>
        </header>
        <div className="layout">
          <nav className="sidebar">
            {SURFACES.map((s) => (
              <button
                key={s.id}
                className={"nav-item" + (s.id === active ? " on" : "")}
                onClick={() => setActive(s.id)}
              >
                <span className="nav-icon">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
          <main className="stage">
            <ActiveComp />
          </main>
        </div>
      </div>

      {paletteOpen && (
        <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <Command label="命令面板">
              <Command.Input
                autoFocus
                value={q}
                onValueChange={setQ}
                placeholder="切换面 / 运行命令 / 问 AI…"
              />
              <Command.List>
                <Command.Empty>无结果</Command.Empty>
                <Command.Group heading="面">
                  {SURFACES.map((s) => (
                    <Command.Item
                      key={s.id}
                      value={"面 " + s.label}
                      onSelect={() => {
                        setActive(s.id);
                        setPaletteOpen(false);
                      }}
                    >
                      <span className="nav-icon">{s.icon}</span> {s.label}
                    </Command.Item>
                  ))}
                </Command.Group>
                {q.trim() && (
                  <Command.Group heading="命令">
                    <Command.Item
                      value={"run " + q}
                      onSelect={async () => {
                        await runShell(q);
                        setPaletteOpen(false);
                      }}
                    >
                      ▶ 运行: <code>{q}</code>
                    </Command.Item>
                    <Command.Item
                      value={"ai " + q}
                      onSelect={() => {
                        setActive("talk");
                        setPaletteOpen(false);
                      }}
                    >
                      💬 切到聊天面问 AI
                    </Command.Item>
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </div>
        </div>
      )}
    </div>
  );
}
