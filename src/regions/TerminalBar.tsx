import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { TerminalView } from "./Terminal";
import { runShell } from "../lib";
import { drainChatIntents, CHAT_EVENT } from "../chatIntents";
import { registerPane, unregisterPane, FOCUS_PANE_EVENT } from "../poofPanes";

interface Tab {
  id: string;
  title: string;
  cmd?: string;
  initialInput?: string;
}
let counter = 0;

function cmdFor(provider: string): { cmd?: string; title: string } {
  if (provider === "codex") return { cmd: "codex", title: "Codex" };
  if (provider === "ps") return { cmd: undefined, title: "PowerShell" };
  return { cmd: "claude", title: "Claude" };
}

function providerOf(cmd?: string): string {
  return cmd === "codex" ? "codex" : cmd === "claude" ? "claude" : "ps";
}

/** AI terminal living inside the overlay's right side panel. New chats arrive as a
 *  window "poof-new-chat" CustomEvent from the shade. Tabs stay mounted so PTY
 *  sessions keep streaming in the background. */
export function TerminalBar() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  const handled = useRef<Set<number>>(new Set());

  function addTab(title: string, cmd?: string, initialInput?: string) {
    const id = "term-" + ++counter;
    setTabs((t) => [...t, { id, title, cmd, initialInput }]);
    setActive(id);
    // 登记进 poof 窗格表, 让总控路由能把消息派给它(case2)。label 用首条输入, 没有就用标题。
    registerPane({ id, provider: providerOf(cmd), label: initialInput || title });
  }
  function close(id: string) {
    setTabs((t) => t.filter((x) => x.id !== id));
    setActive((a) => (a === id ? "" : a));
    unregisterPane(id);
  }

  useEffect(() => {
    const consume = () => {
      for (const i of drainChatIntents()) {
        if (handled.current.has(i.id)) continue;
        handled.current.add(i.id);
        const { cmd, title } = cmdFor(i.provider || "claude");
        addTab(title, cmd, i.query || undefined);
      }
    };
    consume(); // drain anything queued before this bar mounted
    window.addEventListener(CHAT_EVENT, consume);
    // 总控派发命中 send_poof_pane → 切到那个窗格 tab(消息由 dispatch 直接 ptyWrite)
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      if (id) setActive(id);
    };
    window.addEventListener(FOCUS_PANE_EVENT, onFocus);
    return () => {
      window.removeEventListener(CHAT_EVENT, consume);
      window.removeEventListener(FOCUS_PANE_EVENT, onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="termbar">
      <div className="term-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"term-tab" + (t.id === active ? " on" : "")}
            onClick={() => setActive(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              runShell("code -r .").catch(() => {});
            }}
            title="右键：在 VSCode 中打开当前目录"
          >
            {t.title}
            <X
              size={13}
              className="x"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
            />
          </button>
        ))}
        <button className="term-new claude" onClick={() => addTab("Claude", "claude")}>
          <Plus size={13} /> Claude
        </button>
        <button className="term-new codex" onClick={() => addTab("Codex", "codex")}>
          <Plus size={13} /> Codex
        </button>
        <button className="term-new" onClick={() => addTab("PowerShell")}>
          <Plus size={13} /> PS
        </button>
      </div>
      <div className="term-stage">
        {tabs.length === 0 && (
          <div className="term-empty">点「新对话」或上面的 + 开一个对话 / 终端</div>
        )}
        {tabs.map((t) => (
          <div
            key={t.id}
            className="term-pane"
            style={{ display: t.id === active ? "block" : "none" }}
          >
            <TerminalView id={t.id} startCommand={t.cmd} initialInput={t.initialInput} />
          </div>
        ))}
      </div>
    </div>
  );
}
