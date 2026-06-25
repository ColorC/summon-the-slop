// 快选内容管理 —— 一个面板管 ① 剪贴板历史(文本/图片/HTML, 持久, 预览, 恢复, 删除)
// ② poof 快照(截图 + 诊断) ③ 捕获/圈选(captures 目录)。左列表(行式, 类型图标 + 预览 + 悬浮操作)右预览。
// 视觉参考成熟剪贴板管理器(Windows 剪贴板历史 / Ditto / Raycast)。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { micromark } from "micromark";
import { X } from "lucide-react";
import "./ContentManager.css";
import {
  FileText,
  Code2,
  Image as ImageIcon,
  Camera,
  Stethoscope,
  RotateCcw,
  Trash2,
  RefreshCw,
  FolderOpen,
  Link2,
  Copy,
} from "lucide-react";

type Tab = "clipboard" | "snapshots" | "captures";
const CAPTURES_DIR = "E:/WindowsWorkspace/captures";

interface Item {
  key: string;
  tab: Tab;
  kind: string; // text | html | image | shot | diag | md | png
  title: string;
  sub: string;
  ts: number;
  isImage: boolean;
  clipId?: string;
  path?: string;
  mdPath?: string;
  dir?: string;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "clipboard", label: "剪贴板" },
  { key: "snapshots", label: "快照" },
  { key: "captures", label: "捕获" },
];

function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 类型 → 图标 + 配色键(配色在 CSS .cm-ico[data-k])
function typeIcon(it: Item) {
  const k =
    it.kind === "html"
      ? "html"
      : it.kind === "text"
        ? "text"
        : it.kind === "md"
          ? "md"
          : it.kind === "diag"
            ? "diag"
            : "img";
  const Ico =
    k === "html" ? Code2 : k === "text" ? FileText : k === "md" ? FileText : k === "diag" ? Stethoscope : it.kind === "shot" ? Camera : ImageIcon;
  return { k, Ico };
}

export function ContentManager() {
  const [tab, setTab] = useState<Tab>("clipboard");
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Item | null>(null);
  const [loading, setLoading] = useState(false);
  const thumbs = useRef<Record<string, string>>({});
  const [, force] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [flyout, setFlyout] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setNarrow(entries[0].contentRect.width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 窄(停靠侧栏)时: 预览不堆在列表下面, 而是横向飞出在面板旁边的空白处(哪边宽往哪边飞)。
  const placeFlyout = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const leftRoom = r.left;
    const rightRoom = window.innerWidth - r.right;
    const w = Math.min(540, Math.max(300, Math.max(leftRoom, rightRoom) - 14));
    const onLeft = leftRoom >= rightRoom;
    setFlyout({
      position: "fixed",
      top: Math.round(r.top),
      height: Math.round(r.height),
      width: w,
      left: onLeft ? Math.max(8, Math.round(r.left - w - 6)) : Math.round(r.right + 6),
    });
  }, []);

  const pick = useCallback(
    (it: Item) => {
      setSel(it);
      if (narrow) placeFlyout();
    },
    [narrow, placeFlyout]
  );

  // 飞出时跟随窗口/面板变化重新定位; Esc 收起
  useEffect(() => {
    if (!narrow || !sel) return;
    placeFlyout();
    const onResize = () => placeFlyout();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [narrow, sel, placeFlyout]);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    let out: Item[] = [];
    try {
      if (which === "clipboard") {
        const list: any[] = await invoke("clip_list", { limit: 400 });
        out = list.map((e) => ({
          key: "clip:" + e.id,
          tab: "clipboard",
          kind: e.kind,
          title: e.kind === "image" ? e.preview : e.preview || "(空)",
          sub: fmtTime(e.ts_ms),
          ts: e.ts_ms,
          isImage: e.kind === "image",
          clipId: e.id,
        }));
      } else if (which === "snapshots") {
        const [shots, diags]: [any[], any[]] = await Promise.all([
          invoke<any[]>("list_shots").catch(() => []),
          invoke<any[]>("list_diagnostics").catch(() => []),
        ]);
        const a: Item[] = shots.map((s) => ({
          key: "shot:" + s.path,
          tab: "snapshots" as Tab,
          kind: "shot",
          title: s.name,
          sub: `${s.w}×${s.h} · ${fmtTime(s.ts_ms)}`,
          ts: s.ts_ms,
          isImage: true,
          path: s.path,
        }));
        const b: Item[] = diags.map((d) => ({
          key: "diag:" + d.dir,
          tab: "snapshots" as Tab,
          kind: "diag",
          title: "诊断快照 " + d.name.replace(/^diag-/, ""),
          sub: fmtTime(d.ts_ms),
          ts: d.ts_ms,
          isImage: !!d.screenshot,
          path: d.screenshot || undefined,
          mdPath: d.md || undefined,
          dir: d.dir,
        }));
        out = [...a, ...b].sort((x, y) => y.ts - x.ts);
      } else {
        const files: any[] = await invoke<any[]>("list_dir", { path: CAPTURES_DIR }).catch(() => []);
        out = files
          .filter((f) => !f.is_dir && (f.ext === "md" || f.ext === "png" || f.ext === "jpg"))
          .map((f) => ({
            key: "cap:" + f.path,
            tab: "captures" as Tab,
            kind: f.ext,
            title: f.name,
            sub: fmtTime(f.ts_ms),
            ts: f.ts_ms,
            isImage: f.ext === "png" || f.ext === "jpg",
            path: f.path,
          }));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[content] load", which, e);
    }
    setItems(out);
    setLoading(false);
  }, []);

  useEffect(() => {
    load(tab);
    setSel(null);
  }, [tab, load]);

  useEffect(() => {
    if (tab !== "clipboard") return;
    const iv = setInterval(() => load("clipboard"), 3000);
    return () => clearInterval(iv);
  }, [tab, load]);

  const thumbOf = useCallback((it: Item) => {
    if (!it.isImage) return "";
    if (thumbs.current[it.key] != null) return thumbs.current[it.key];
    thumbs.current[it.key] = "";
    (async () => {
      try {
        let url = "";
        if (it.clipId) url = await invoke<string>("clip_thumb", { id: it.clipId });
        else if (it.kind === "shot" && it.path) url = await invoke<string>("read_image_b64", { path: it.path });
        else if (it.path) {
          const b64 = await invoke<string>("read_file_b64", { path: it.path });
          url = "data:image/png;base64," + b64;
        }
        thumbs.current[it.key] = url;
        force((n) => n + 1);
      } catch {
        /* ignore */
      }
    })();
    return "";
  }, []);

  const restoreItem = useCallback(async (it: Item) => {
    if (!it.clipId) return;
    await invoke("clip_restore", { id: it.clipId }).catch(() => {});
  }, []);

  const deletable = (it: Item) => !!it.clipId || it.kind === "shot" || it.kind === "diag";
  const deleteItem = useCallback(
    async (it: Item) => {
      try {
        if (it.clipId) await invoke("clip_delete", { id: it.clipId });
        else if (it.kind === "shot" && it.path) await invoke("delete_shot", { path: it.path });
        else if (it.kind === "diag" && it.dir) await invoke("delete_diagnostic", { dir: it.dir });
        else return;
      } catch {
        /* ignore */
      }
      if (sel?.key === it.key) setSel(null);
      load(tab);
    },
    [sel, tab, load]
  );

  const filtered = items.filter(
    (it) => !q.trim() || (it.title + " " + it.sub).toLowerCase().includes(q.trim().toLowerCase())
  );

  const runDiag = async () => {
    try {
      await invoke("diagnostic_snapshot", {
        stateJson: JSON.stringify({ time: new Date().toString(), from: "内容面板" }, null, 2),
      });
      setTab("snapshots");
      setTimeout(() => load("snapshots"), 200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={"cm" + (narrow ? " narrow" : "")} ref={rootRef}>
      <div className="cm-head">
        <div className="cm-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={"cm-tab" + (tab === t.key ? " on" : "")} onClick={() => { setTab(t.key); setQ(""); }}>
              {t.label}
            </button>
          ))}
        </div>
        <input className="cm-search" placeholder="过滤…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="cm-icobtn" onClick={() => load(tab)} data-tip="刷新">
          <RefreshCw size={15} />
        </button>
        <button className="cm-icobtn" onClick={runDiag} data-tip="立刻做一次全量诊断快照（= Ctrl+Alt+S）">
          <Stethoscope size={15} />
        </button>
        {tab === "clipboard" && (
          <button
            className="cm-icobtn danger"
            data-tip="清空剪贴板历史"
            onClick={async () => {
              if (confirm("清空全部剪贴板历史?")) {
                await invoke("clip_clear");
                load("clipboard");
                setSel(null);
              }
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="cm-body">
        <div className="cm-list">
          {loading && <div className="cm-empty">加载中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="cm-empty">{tab === "clipboard" ? "复制点东西，这里就会有了" : "暂无内容"}</div>
          )}
          {!loading &&
            filtered.map((it) => {
              const { k, Ico } = typeIcon(it);
              const url = it.isImage ? thumbOf(it) : "";
              return (
                <div key={it.key} className={"cm-row" + (sel?.key === it.key ? " sel" : "")}>
                  <button className="cm-row-main" onClick={() => pick(it)}>
                    <span className="cm-ico" data-k={k}>
                      {url ? <img src={url} alt="" /> : <Ico size={16} />}
                    </span>
                    <span className="cm-row-text">
                      <span className="cm-row-title">{it.title || "(空)"}</span>
                      <span className="cm-row-sub">{it.sub}</span>
                    </span>
                  </button>
                  <div className="cm-row-acts">
                    {it.clipId && (
                      <button data-tip="恢复到剪贴板" onClick={() => restoreItem(it)}>
                        <RotateCcw size={14} />
                      </button>
                    )}
                    {deletable(it) && (
                      <button data-tip="删除" onClick={() => deleteItem(it)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
        {/* 宽(浮窗/拉宽): 预览就在面板右半 */}
        {!narrow && (
          <Preview item={sel} onChanged={() => load(tab)} onDelete={deleteItem} onRestore={restoreItem} />
        )}
      </div>

      {/* 窄(停靠侧栏): 选中后预览横向飞出在面板旁边(portal 到 body 避开 transform 影响定位) */}
      {narrow &&
        sel &&
        flyout &&
        createPortal(
          <div className="cm-flyout" style={flyout}>
            <Preview
              item={sel}
              onChanged={() => load(tab)}
              onDelete={deleteItem}
              onRestore={restoreItem}
              onClose={() => setSel(null)}
            />
          </div>,
          document.body
        )}
    </div>
  );
}

function Preview({
  item,
  onDelete,
  onRestore,
  onClose,
}: {
  item: Item | null;
  onChanged: () => void;
  onDelete: (it: Item) => void;
  onRestore: (it: Item) => void;
  onClose?: () => void;
}) {
  const [text, setText] = useState<string>("");
  const [html, setHtml] = useState<string>("");
  const [img, setImg] = useState<string>("");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setText("");
    setHtml("");
    setImg("");
    setShowRaw(false);
    if (!item) return;
    let alive = true;
    (async () => {
      try {
        if (item.clipId) {
          const full: any = await invoke("clip_get", { id: item.clipId });
          if (!alive) return;
          if (full.image_b64) setImg(full.image_b64);
          if (full.html) setHtml(full.html);
          if (full.text) setText(full.text);
        } else if (item.kind === "md" && item.path) {
          const t = await invoke<string>("read_file_text", { path: item.path });
          if (!alive) return;
          setText(t);
          try {
            setHtml(micromark(t));
          } catch {
            /* ignore */
          }
        } else if (item.isImage && item.path) {
          const b64 = await invoke<string>("read_file_b64", { path: item.path });
          if (!alive) return;
          setImg("data:image/png;base64," + b64);
          if (item.mdPath) {
            const t = await invoke<string>("read_file_text", { path: item.mdPath }).catch(() => "");
            if (alive && t) {
              setText(t);
              try {
                setHtml(micromark(t));
              } catch {
                /* ignore */
              }
            }
          }
        } else if (item.path) {
          const t = await invoke<string>("read_file_text", { path: item.path }).catch(() => "");
          if (alive) setText(t);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[content] preview", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [item]);

  if (!item)
    return (
      <div className="cm-preview cm-empty">
        <div>选一项预览</div>
      </div>
    );

  return (
    <div className="cm-preview">
      <div className="cm-preview-bar">
        <span className="cm-preview-title">{item.title}</span>
        <span className="cm-flex" />
        {item.clipId && (
          <button className="cm-pbtn" onClick={() => onRestore(item)} data-tip="恢复到系统剪贴板">
            <RotateCcw size={14} /> 恢复
          </button>
        )}
        {item.mdPath && (
          <button className="cm-icobtn" onClick={() => invoke("copy_text", { text: `[[${item.mdPath}]]` })} data-tip="复制报告链接">
            <Link2 size={15} />
          </button>
        )}
        {text && (
          <button className="cm-icobtn" onClick={() => invoke("copy_text", { text })} data-tip="复制文本">
            <Copy size={15} />
          </button>
        )}
        {item.path && (
          <button className="cm-icobtn" onClick={() => invoke("open_path", { path: item.path })} data-tip="用默认程序打开">
            <FolderOpen size={15} />
          </button>
        )}
        {html && (
          <button className="cm-icobtn" onClick={() => setShowRaw((r) => !r)} data-tip={showRaw ? "看渲染" : "看源码"}>
            <Code2 size={15} />
          </button>
        )}
        {(item.clipId || item.kind === "shot" || item.kind === "diag") && (
          <button className="cm-icobtn danger" onClick={() => onDelete(item)} data-tip="删除">
            <Trash2 size={15} />
          </button>
        )}
        {onClose && (
          <button className="cm-icobtn" onClick={onClose} data-tip="收起预览">
            <X size={15} />
          </button>
        )}
      </div>
      <div className="cm-preview-body">
        {img && <img className="cm-preview-img" src={img} alt="" />}
        {html && !showRaw && <iframe className="cm-preview-html" sandbox="" srcDoc={html} title="preview" />}
        {((html && showRaw) || (!html && text)) && <pre className="cm-preview-text">{text}</pre>}
        {!img && !html && !text && <div className="cm-empty">（无可预览内容）</div>}
      </div>
    </div>
  );
}
