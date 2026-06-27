import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
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
  RefreshCw,
} from "lucide-react";
import {
  search,
  openPath,
  fileIcon,
  requestFullReindex,
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

// 真实 Windows 图标缓存(path → data URL, 或 null = 取过但没有)。跨渲染/查询复用, 不重复 IPC。
const iconCache = new Map<string, string | null>();

// 取消"40 条显示上限": 后端取 FETCH 条排好序候选, 前端只画 shown 条, 滚到底再 +PAGE(VS Code Quick Open /
// Everything 式窗口化)。每行图标仍懒取 + 按 path 缓存, 不会一次发几百个 IPC。
const PAGE = 60;
const FETCH = 300;

// 优先显示文件/应用本体图标(Chrome 显示 Chrome 图标, .xlsx 显示 Excel 图标…); 取不到时退回线框占位图。
// 懒取一次按 path 缓存(Rust 侧也缓存), 故同一项不会反复调用。
function HitIcon({ hit }: { hit: SearchHit }) {
  const [src, setSrc] = useState<string | null | undefined>(() =>
    iconCache.get(hit.path)
  );
  useEffect(() => {
    if (iconCache.has(hit.path)) {
      setSrc(iconCache.get(hit.path));
      return;
    }
    let alive = true;
    fileIcon(hit.path)
      .then((url) => {
        iconCache.set(hit.path, url ?? null);
        if (alive) setSrc(url ?? null);
      })
      .catch(() => {
        iconCache.set(hit.path, null);
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [hit.path]);
  if (src) {
    return (
      <img className="sr-ico" src={src} alt="" width={18} height={18} draggable={false} />
    );
  }
  return <KindIcon kind={hit.kind} />;
}

// 紧贴光标弹出的浮层(右键菜单/标签面板)。
// 关键: 必须 portal 到 document.body —— 浮层本体挂在 .pf-top 内, 而 .pf-top 有 transform,
// 会把后代 position:fixed 的定位原点从"视口"变成"该祖先盒子", 用 clientX/Y 当 left/top 就整体甩飞。
// 挂到 body(无 transform)后 fixed 才重新相对视口, clientX/Y 与 getBoundingClientRect 同坐标系。
// 再按"实测尺寸"翻转: 放不下时围绕光标向上/向左展开; 测量前 hidden, useLayoutEffect 绘制前定位完, 无闪烁。
function FloatingPanel({
  x,
  y,
  className,
  onBackdrop,
  children,
}: {
  x: number;
  y: number;
  className: string;
  onBackdrop: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; visibility: "hidden" | "visible" }>({
    left: x,
    top: y,
    visibility: "hidden",
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = x + r.width + pad > vw ? Math.max(pad, x - r.width) : x;
    const top = y + r.height + pad > vh ? Math.max(pad, y - r.height) : y;
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top), visibility: "visible" });
  }, [x, y]);
  return createPortal(
    <>
      <div className="ctx-backdrop" onMouseDown={onBackdrop} />
      <div ref={ref} className={className} style={pos}>
        {children}
      </div>
    </>,
    document.body
  );
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
  const [shown, setShown] = useState(PAGE); // 当前已画的结果行数(滚动加载递增)
  const [reindexMsg, setReindexMsg] = useState(""); // 全量重建状态提示
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qRef = useRef("");
  const histIdx = useRef(-1);
  const autoReindexRef = useRef(false); // 每会话只自动发起一次全量重建检测
  qRef.current = q;

  const showResults = q.trim().length > 0;
  const aiItem: AiItem = { kind: "ai", name: q, path: "", score: 0, tags: [], pinned: false };
  const visibleHits = showResults ? hits.slice(0, shown) : [];
  const items: Item[] = showResults ? [...visibleHits, aiItem] : recent;
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
    // 首次真实搜索 → 自动检测并(据后端 mft_state 状态)发起全量 MFT 重建请求。已成功/被 EDR 拦/取消多次则
    // 静默跳过, 不打扰; 否则弹 UAC, 输管理员凭据后秒级走 MFT 全量, 完成自动热换(reindex-done 事件)。
    if (!autoReindexRef.current) {
      autoReindexRef.current = true;
      requestFullReindex(false)
        .then((m) => {
          if (m === "fired") setReindexMsg("检测到可用管理员重建(MFT 全量),已弹 UAC…");
        })
        .catch(() => {});
    }
    const t = setTimeout(() => {
      search(q, FETCH)
        .then((r) => alive && (setHits(r), setSel(0), setShown(PAGE)))
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
      search(qRef.current, FETCH).then(setHits).catch(() => {});
    } else {
      loadRecent();
    }
  }, [loadRecent]);

  // 滚动到接近底部 → 再画一页(只追加; 已画行与其已解析图标不动, 新行各自懒取图标)。
  const onResultsScroll = useCallback(() => {
    const el = resultsRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setShown((s) => (s < hits.length ? Math.min(s + PAGE, hits.length) : s));
    }
  }, [hits.length]);

  // 键盘下移走出已画窗口时自动多画一页, 让选中行始终可达。
  useEffect(() => {
    if (showResults && sel >= shown - 8 && shown < hits.length) {
      setShown((s) => Math.min(s + PAGE, hits.length));
    }
  }, [sel, shown, hits.length, showResults]);

  // 手动按钮: 无条件弹 UAC → 提权子进程秒级全量(MFT) → 完成后热换 + 提示。
  const doReindex = useCallback(() => {
    setReindexMsg("正在请求管理员权限(UAC)…");
    requestFullReindex(true)
      .then((m) =>
        setReindexMsg(
          m === "fired" ? "已弹 UAC，输入管理员凭据后约 6-25s 完成…" : m
        )
      )
      .catch((e) => setReindexMsg("重建失败：" + String(e)));
  }, []);
  useEffect(() => {
    const un = listen<[number, boolean]>("reindex-done", (e) => {
      const [n, mft] = e.payload;
      setReindexMsg(
        `✓ 全量重建完成：${n.toLocaleString()} 条（${mft ? "MFT · 管理员秒级" : "遍历全盘"}）`
      );
      refresh();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

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
          {it.pinned ? <Star size={15} className="sr-pin" /> : <HitIcon hit={it} />}
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
        <div className="search-results" ref={resultsRef} onScroll={onResultsScroll}>
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
        <div className="search-results recent">
          <div className="sr-section">
            <Clock size={12} /> 常用 / 置顶
            <button className="sr-managetags" onClick={() => setTagMgr(null)} title="标签管理">
              <SlidersHorizontal size={12} /> 标签
            </button>
            <button
              className="sr-managetags"
              onClick={doReindex}
              title="用管理员重建全量索引(NTFS MFT, 秒级全盘, 一个不漏)"
            >
              <RefreshCw size={12} /> 全量重建
            </button>
          </div>
          {recent.map((it, i) => (
            <HitRow key={it.path + i} it={it} i={i} />
          ))}
          {reindexMsg && <div className="sr-more">{reindexMsg}</div>}
        </div>
      )}

      {menu && (
        <FloatingPanel x={menu.x} y={menu.y} className="ctx-menu" onBackdrop={() => setMenu(null)}>
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
        </FloatingPanel>
      )}

      {tagPanel && (
        <FloatingPanel x={tagPanel.x} y={tagPanel.y} className="tag-panel" onBackdrop={() => setTagPanel(null)}>
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
        </FloatingPanel>
      )}

      {tagMgr !== false && (
        <TagManager initialTag={tagMgr} onClose={() => { setTagMgr(false); refresh(); }} />
      )}
    </div>
  );
}
