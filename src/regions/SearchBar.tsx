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
} from "lucide-react";
import { search, openPath, revealPath, copyText, runShell, type SearchHit } from "../lib";

function KindIcon({ kind }: { kind: string }) {
  if (kind === "folder") return <Folder size={16} />;
  if (kind === "app") return <AppWindow size={16} />;
  if (kind === "exe") return <SquareTerminal size={16} />;
  return <FileText size={16} />;
}

type Item = SearchHit | { kind: "ai"; name: string; path: ""; score: 0 };

/** Top search bar — the ONLY input. Files / folders / apps / exes ranked in-process.
 *  Ctrl+Enter (or no result) → 询问 AI = open a claude/codex CLI. Right-click a result
 *  for file actions (open / reveal / copy path / VSCode). */
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
  const [menu, setMenu] = useState<{ x: number; y: number; hit: SearchHit } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showResults = q.trim().length > 0;
  // "ask AI" is always the last item, and the only item when nothing matches
  const items: Item[] = showResults
    ? [...hits, { kind: "ai", name: q, path: "", score: 0 }]
    : [];

  useEffect(() => {
    inputRef.current?.focus();
    const un = listen("summon", () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      search(q, 40)
        .then((r) => alive && (setHits(r), setSel(0)))
        .catch(() => alive && setHits([]));
    }, 110);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  function askAI() {
    onAskAI(q.trim());
    setQ("");
    setHits([]);
  }
  function launch(hit: SearchHit) {
    openPath(hit.path).catch(() => {});
    setQ("");
    setHits([]);
    onLaunched();
  }
  function activate(item: Item) {
    if (item.kind === "ai") askAI();
    else launch(item as SearchHit);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      askAI();
    } else if (e.key === "ArrowDown") {
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
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
        placeholder="检索文件 · 文件夹 · 应用…   Ctrl+Enter 问 AI"
        spellCheck={false}
      />
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
            <button
              onClick={() => {
                launch(menu.hit);
                setMenu(null);
              }}
            >
              <CornerDownLeft size={15} /> 打开
            </button>
            <button
              onClick={() => {
                revealPath(menu.hit.path);
                setMenu(null);
                onLaunched();
              }}
            >
              <FolderOpen size={15} /> 打开所在文件夹
            </button>
            <button
              onClick={() => {
                copyText(menu.hit.path);
                setMenu(null);
              }}
            >
              <Copy size={15} /> 复制路径
            </button>
            <button
              onClick={() => {
                runShell(`code -r "${menu.hit.path}"`);
                setMenu(null);
                onLaunched();
              }}
            >
              <Code size={15} /> 在 VS Code 中打开
            </button>
          </div>
        </>
      )}
    </div>
  );
}
