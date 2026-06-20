import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Folder,
  FileText,
  AppWindow,
  SquareTerminal,
  Sparkles,
  FolderOpen,
  Copy,
  Code,
  CornerDownLeft,
  Menu,
  Loader2,
} from "lucide-react";
import {
  search,
  openPath,
  revealPath,
  copyText,
  runShell,
  shellMenu,
  type SearchHit,
} from "../lib";

const HISTORY_KEY = "poof-search-history";
function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}
function pushHistory(q: string) {
  q = q.trim();
  if (!q) return;
  let h = loadHistory().filter((x) => x !== q);
  h.unshift(q);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 50)));
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "folder") return <Folder size={16} />;
  if (kind === "app") return <AppWindow size={16} />;
  if (kind === "exe") return <SquareTerminal size={16} />;
  return <FileText size={16} />;
}

type Item = SearchHit | { kind: "ai"; name: string; path: ""; score: 0 };

export function SearchBar({
  onAskAI,
  onLaunched,
}: {
  onAskAI: (query: string) => void;
  onLaunched: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [composing, setComposing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: SearchHit } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qRef = useRef("");
  const histIdx = useRef(-1);
  qRef.current = q;

  const showResults = q.trim().length > 0;
  const items: Item[] = showResults ? [...hits, { kind: "ai", name: q, path: "", score: 0 }] : [];

  useEffect(() => {
    inputRef.current?.focus();
    // each summon: remember the last input, then clear the box (#5, #6)
    const un = listen("summon", () => {
      pushHistory(qRef.current);
      setQ("");
      setHits([]);
      histIdx.current = -1;
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // search — but never while an IME composition is in progress (#2 pinyin)
  useEffect(() => {
    if (composing || !q.trim()) {
      if (!q.trim()) setHits([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      search(q, 40)
        .then((r) => alive && (setHits(r), setSel(0)))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setSearching(false));
    }, 110);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, composing]);

  function askAI() {
    pushHistory(q);
    onAskAI(q.trim());
    setQ("");
    setHits([]);
  }
  function launch(hit: SearchHit) {
    pushHistory(q);
    openPath(hit.path).catch(() => {});
    setQ("");
    setHits([]);
    onLaunched();
  }
  function activate(item: Item) {
    if (item.kind === "ai") askAI();
    else launch(item as SearchHit);
  }
  function recall(dir: number) {
    const h = loadHistory();
    if (!h.length) return;
    let idx = histIdx.current + dir;
    idx = Math.max(0, Math.min(idx, h.length - 1));
    histIdx.current = idx;
    setQ(h[idx]);
  }

  function onKey(e: React.KeyboardEvent) {
    if (composing) return; // let the IME own the keys
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      askAI();
      return;
    }
    if (!showResults) {
      // empty box → recall input history with ↑/↓ (#6)
      if (e.key === "ArrowUp") {
        e.preventDefault();
        recall(1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        recall(-1);
      } else if (e.key === "Enter" && q.trim()) {
        askAI();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      setSel((s) => Math.min(s + 1, items.length - 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setSel((s) => Math.max(s - 1, 0));
      e.preventDefault();
    } else if (e.key === "Enter" && items[sel]) {
      activate(items[sel]);
    }
  }

  return (
    <div className="searchbar">
      <input
        ref={inputRef}
        className="search-input"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          histIdx.current = -1;
        }}
        onKeyDown={onKey}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(e) => {
          setComposing(false);
          setQ(e.currentTarget.value);
        }}
        placeholder="检索文件 · 文件夹 · 应用…   Ctrl+Enter 问 AI · ↑↓ 历史"
        spellCheck={false}
      />
      {searching && <Loader2 size={16} className="spin search-spin" />}
      {showResults && (
        <div className="search-results">
          {items.map((it, i) =>
            it.kind === "ai" ? (
              <div
                key="ai"
                className={"sr ai" + (i === sel ? " on" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={askAI}
              >
                <span className="sr-kind">
                  <Sparkles size={16} />
                </span>
                <span className="sr-name">询问 AI：{q}</span>
                <span className="sr-path">开 Claude / Codex CLI · Ctrl+Enter</span>
              </div>
            ) : (
              <div
                key={it.path + i}
                className={"sr" + (i === sel ? " on" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => launch(it as SearchHit)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, hit: it as SearchHit });
                }}
              >
                <span className="sr-kind">
                  <KindIcon kind={it.kind} />
                </span>
                <span className="sr-name">{it.name}</span>
                <span className="sr-path">{(it as SearchHit).path}</span>
              </div>
            )
          )}
        </div>
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => { launch(menu.hit); setMenu(null); }}>
              <CornerDownLeft size={15} /> 打开
            </button>
            <button onClick={() => { revealPath(menu.hit.path); setMenu(null); onLaunched(); }}>
              <FolderOpen size={15} /> 打开所在文件夹
            </button>
            <button onClick={() => { copyText(menu.hit.path); setMenu(null); }}>
              <Copy size={15} /> 复制路径
            </button>
            <button onClick={() => { runShell(`code -r "${menu.hit.path}"`); setMenu(null); onLaunched(); }}>
              <Code size={15} /> 在 VS Code 中打开
            </button>
            <div className="ctx-div" />
            <button onClick={() => { shellMenu(menu.hit.path, menu.x, menu.y); setMenu(null); }}>
              <Menu size={15} /> 属性（系统）
            </button>
          </div>
        </>
      )}
    </div>
  );
}
