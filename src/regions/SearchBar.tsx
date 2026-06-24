import { useEffect, useRef, useState, useCallback } from "react";
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
  Pin,
  ArrowDownNarrowWide,
  EyeOff,
  Star,
  Tag as TagIcon,
  SlidersHorizontal,
  Clock,
} from "lucide-react";
import {
  search,
  openPath,
  revealPath,
  copyText,
  runShell,
  shellMenu,
  setOverride,
  getOverride,
  toggleImportantFolder,
  isImportantFolder,
  recentTop,
  tagAdd,
  tagRemove,
  tagDefs,
  type SearchHit,
  type TagDef,
} from "../lib";
import { TagChip } from "../lib/tagchip";
import { TagManager } from "./TagManager";

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

// 把浮层钳进视口内 —— 靠右/靠下点击时翻到光标另一侧, 绝不溢出屏幕(原来 left:clientX 会跑到屏外)。
function clampPos(x: number, y: number, w: number, h: number) {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + w + pad > vw ? Math.max(pad, x - w) : x;
  const top = y + h + pad > vh ? Math.max(pad, vh - h - pad) : y;
  return { left: Math.max(pad, left), top };
}

type AiItem = { kind: "ai"; name: string; path: ""; score: 0; tags: []; pinned: false };
type Item = SearchHit | AiItem;
type CtxMenu = { x: number; y: number; hit: SearchHit; ov: number; imp: boolean };
type TagPanel = { x: number; y: number; hit: SearchHit };

export function SearchBar({
  onAskAI,
  onLaunched,
}: {
  onAskAI: (query: string) => void;
  onLaunched: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [composing, setComposing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [tagPanel, setTagPanel] = useState<TagPanel | null>(null);
  const [tagMgr, setTagMgr] = useState<string | null | false>(false);
  // path → tags 的本地即时覆盖(打/删标签后无需重搜即可刷新 chip)
  const [tagEdits, setTagEdits] = useState<Record<string, string[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const qRef = useRef("");
  const histIdx = useRef(-1);
  qRef.current = q;

  const showResults = q.trim().length > 0;
  const aiItem: AiItem = { kind: "ai", name: q, path: "", score: 0, tags: [], pinned: false };
  const items: Item[] = showResults ? [...hits, aiItem] : recent;
  const tagsOf = (h: SearchHit) => tagEdits[h.path] ?? h.tags;

  const loadRecent = useCallback(() => {
    recentTop(12)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    loadRecent();
    // each summon: remember the last input, then clear the box (#5, #6)
    const un = listen("summon", () => {
      pushHistory(qRef.current);
      setQ("");
      setHits([]);
      setMenu(null);
      setTagPanel(null);
      setTagMgr(false);
      histIdx.current = -1;
      loadRecent();
      setSel(-1);
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => {
      un.then((f) => f());
    };
  }, [loadRecent]);

  // search — but never while an IME composition is in progress (#2 pinyin)
  useEffect(() => {
    const ql = q.trim();
    // 1 个拉丁字符的查询几乎匹配一切、最慢且无意义 → 不搜(单个中文字有意义, 照搜)。
    const tooShort = ql.length === 1 && ql.charCodeAt(0) < 128;
    if (composing || !ql || tooShort) {
      if (!ql || tooShort) setHits([]);
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

  // re-run the current query (after an override/tag change) so the list reflects it
  const refresh = useCallback(() => {
    if (qRef.current.trim()) {
      search(qRef.current, 40).then(setHits).catch(() => {});
    } else {
      loadRecent();
    }
  }, [loadRecent]);

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

  function openMenu(e: React.MouseEvent, hit: SearchHit) {
    e.preventDefault();
    setTagPanel(null);
    setMenu({ x: e.clientX, y: e.clientY, hit, ov: hit.pinned ? 2 : 0, imp: false });
    getOverride(hit.path).then((ov) =>
      setMenu((m) => (m && m.hit.path === hit.path ? { ...m, ov } : m))
    );
    if (hit.kind === "folder") {
      isImportantFolder(hit.path).then((imp) =>
        setMenu((m) => (m && m.hit.path === hit.path ? { ...m, imp } : m))
      );
    }
  }
  async function applyOverride(path: string, level: number) {
    await setOverride(path, level);
    setMenu(null);
    refresh();
  }

  // ---- tag editing panel ----
  const [allDefs, setAllDefs] = useState<TagDef[]>([]);
  const [tagInput, setTagInput] = useState("");
  function openTagPanel(hit: SearchHit, x: number, y: number) {
    setMenu(null);
    setTagInput("");
    tagDefs().then(setAllDefs).catch(() => {});
    setTagPanel({ x, y, hit });
  }
  async function addTagTo(hit: SearchHit, tag: string) {
    const t = tag.trim();
    if (!t) return;
    const tags = await tagAdd(hit.path, t);
    setTagEdits((m) => ({ ...m, [hit.path]: tags }));
    setTagInput("");
    tagDefs().then(setAllDefs).catch(() => {});
  }
  async function removeTagFrom(hit: SearchHit, tag: string) {
    const tags = await tagRemove(hit.path, tag);
    setTagEdits((m) => ({ ...m, [hit.path]: tags }));
  }

  function onKey(e: React.KeyboardEvent) {
    if (composing) return; // let the IME own the keys
    if (menu || tagPanel || tagMgr !== false) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      askAI();
      return;
    }
    // Ctrl+T → 给选中结果打标签(纯键盘流)
    if ((e.ctrlKey || e.metaKey) && (e.key === "t" || e.key === "T")) {
      const it = items[sel];
      if (it && it.kind !== "ai") {
        e.preventDefault();
        const r = inputRef.current?.getBoundingClientRect();
        openTagPanel(it as SearchHit, (r?.left ?? 80) + 40, (r?.bottom ?? 120) + 8);
      }
      return;
    }
    if (!showResults) {
      // 空框 → 常用/置顶面板: ↓ 进列表, ↑(在顶部)回历史输入
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min((s < 0 ? -1 : s) + 1, recent.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => {
          if (s <= 0) {
            recall(1);
            return -1;
          }
          return s - 1;
        });
      } else if (e.key === "Enter") {
        if (sel >= 0 && recent[sel]) launch(recent[sel]);
        else if (q.trim()) askAI();
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

  function HitRow({ it, i }: { it: SearchHit; i: number }) {
    const tags = tagsOf(it);
    return (
      <div
        key={it.path + i}
        className={"sr" + (i === sel ? " on" : "") + (it.pinned ? " pinned" : "")}
        onMouseEnter={() => setSel(i)}
        onClick={() => launch(it)}
        onContextMenu={(e) => openMenu(e, it)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/poof-path", it.path);
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <span className="sr-kind">
          {it.pinned ? <Star size={15} className="sr-pin" /> : <KindIcon kind={it.kind} />}
        </span>
        <span className="sr-name">{it.name}</span>
        {tags.length > 0 && (
          <span className="sr-tags">
            {tags.map((t) => (
              <TagChip key={t} name={t} />
            ))}
          </span>
        )}
        <span className="sr-path">{it.path}</span>
      </div>
    );
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
          setSel(0);
        }}
        onKeyDown={onKey}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(e) => {
          setComposing(false);
          setQ(e.currentTarget.value);
        }}
        placeholder="检索文件 · 文件夹 · 应用…   #标签 过滤 · Ctrl+T 打标签 · Ctrl+Enter 问 AI"
        spellCheck={false}
      />
      {searching && <Loader2 size={16} className="spin search-spin" />}

      {showResults ? (
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
              <HitRow key={(it as SearchHit).path + i} it={it as SearchHit} i={i} />
            )
          )}
        </div>
      ) : (
        recent.length > 0 && (
          <div className="search-results recent">
            <div className="sr-section">
              <Clock size={12} /> 常用 / 置顶
              <button className="sr-managetags" onClick={() => setTagMgr(null)} title="标签管理">
                <SlidersHorizontal size={12} /> 标签
              </button>
            </div>
            {recent.map((it, i) => (
              <HitRow key={it.path + i} it={it} i={i} />
            ))}
          </div>
        )
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="ctx-menu" style={clampPos(menu.x, menu.y, 230, 470)}>
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
            <button className={menu.ov === 2 ? "on" : ""} onClick={() => applyOverride(menu.hit.path, menu.ov === 2 ? 0 : 2)}>
              <Pin size={15} /> {menu.ov === 2 ? "取消置顶" : "置顶（搜索强力上浮）"}
            </button>
            <button className={menu.ov === -1 ? "on" : ""} onClick={() => applyOverride(menu.hit.path, menu.ov === -1 ? 0 : -1)}>
              <ArrowDownNarrowWide size={15} /> {menu.ov === -1 ? "取消降权" : "降权"}
            </button>
            <button onClick={() => applyOverride(menu.hit.path, -2)}>
              <EyeOff size={15} /> 隐藏（从结果剔除）
            </button>
            {menu.hit.kind === "folder" && (
              <button className={menu.imp ? "on" : ""} onClick={async () => { await toggleImportantFolder(menu.hit.path); setMenu(null); refresh(); }}>
                <Star size={15} /> {menu.imp ? "取消重要文件夹" : "标为重要文件夹"}
              </button>
            )}
            <div className="ctx-div" />
            <button onClick={() => openTagPanel(menu.hit, menu.x, menu.y)}>
              <TagIcon size={15} /> 🏷 标签…
            </button>
            <button onClick={() => { setTagMgr(null); setMenu(null); }}>
              <SlidersHorizontal size={15} /> 管理标签 / 纠偏…
            </button>
            <div className="ctx-div" />
            <button onClick={() => { shellMenu(menu.hit.path, menu.x, menu.y); setMenu(null); }}>
              <Menu size={15} /> 属性（系统）
            </button>
          </div>
        </>
      )}

      {tagPanel && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setTagPanel(null)} />
          <div className="tag-panel" style={clampPos(tagPanel.x, tagPanel.y, 280, 220)}>
            <div className="tag-panel-h">
              <TagIcon size={13} /> 标签 · {tagPanel.hit.name}
            </div>
            <div className="tag-panel-chips">
              {tagsOf(tagPanel.hit).length === 0 && <span className="tag-panel-none">还没有标签</span>}
              {tagsOf(tagPanel.hit).map((t) => {
                const def = allDefs.find((d) => d.name.toLowerCase() === t.toLowerCase());
                return (
                  <TagChip
                    key={t}
                    name={t}
                    color={def?.color}
                    pinned={def?.pin}
                    onRemove={() => removeTagFrom(tagPanel.hit, t)}
                  />
                );
              })}
            </div>
            <input
              className="tag-panel-input"
              autoFocus
              value={tagInput}
              placeholder="输入标签，回车新建 / 加上"
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTagTo(tagPanel.hit, tagInput);
                } else if (e.key === "Escape") {
                  setTagPanel(null);
                }
                e.stopPropagation();
              }}
            />
            {(() => {
              const cur = tagsOf(tagPanel.hit).map((x) => x.toLowerCase());
              const ql = tagInput.trim().toLowerCase();
              const sugg = allDefs
                .filter((d) => !cur.includes(d.name.toLowerCase()))
                .filter((d) => !ql || d.name.toLowerCase().includes(ql))
                .slice(0, 8);
              return sugg.length > 0 ? (
                <div className="tag-panel-sugg">
                  {sugg.map((d) => (
                    <TagChip
                      key={d.name}
                      name={d.name}
                      color={d.color}
                      pinned={d.pin}
                      onClick={() => addTagTo(tagPanel.hit, d.name)}
                    />
                  ))}
                </div>
              ) : null;
            })()}
          </div>
        </>
      )}

      {tagMgr !== false && (
        <TagManager initialTag={tagMgr} onClose={() => { setTagMgr(false); refresh(); }} />
      )}
    </div>
  );
}
