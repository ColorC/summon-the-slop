// 快选内容管理 —— 一个面板管 ① 剪贴板历史(文本/图片/HTML, 持久, 预览, 恢复, 删除)
// ② poof 快照(截图 + 诊断) ③ 捕获/圈选(captures 目录)。左列表(行式, 类型图标 + 预览 + 悬浮操作)右预览。
// 视觉参考成熟剪贴板管理器(Windows 剪贴板历史 / Ditto / Raycast)。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdownSafe, sanitizeHtml } from "../lib/sanitizeHtml";
import { X } from "lucide-react";
import "./ContentManager.css";
import {
  FileText,
  Code2,
  Image as ImageIcon,
  Camera,
  Stethoscope,
  Film,
  RotateCcw,
  Trash2,
  RefreshCw,
  FolderOpen,
  Link2,
  Copy,
  Play,
  Pause,
} from "lucide-react";

type Tab = "clipboard" | "snapshots" | "captures" | "recordings";
const CAPTURES_DIR = "E:/WindowsWorkspace/captures";

// 预览的是外部 HTML(剪贴板复制来的 / markdown 渲染), 跑在 sandbox="" 的 iframe 里 —— poof 的暗色
// 主题与样式都跨不进这个边界, 浏览器会用默认样式渲染里面的原生表单控件。最扎眼的是 <input type=number>
// 右侧那对白底 ▲▼ spinner(用户看到的"莫名其妙的上下箭头")。拼 srcdoc 时前置一段 reset 抹掉它。
const PREVIEW_RESET = `<style>
input::-webkit-inner-spin-button,
input::-webkit-outer-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
</style>`;
const withPreviewReset = (html: string) => PREVIEW_RESET + html;

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
  sid?: string; // 录像会话 id
}

const TABS: { key: Tab; label: string }[] = [
  { key: "clipboard", label: "剪贴板" },
  { key: "snapshots", label: "快照" },
  { key: "recordings", label: "录像" },
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
            : it.kind === "rec"
              ? "rec"
              : "img";
  const Ico =
    k === "html"
      ? Code2
      : k === "text"
        ? FileText
        : k === "md"
          ? FileText
          : k === "diag"
            ? Stethoscope
            : k === "rec"
              ? Film
              : it.kind === "shot"
                ? Camera
                : ImageIcon;
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
      } else if (which === "recordings") {
        const sessions: any[] = await invoke<any[]>("list_sessions").catch(() => []);
        out = sessions.map((s) => ({
          key: "rec:" + s.sid,
          tab: "recordings" as Tab,
          kind: "rec",
          title: s.title || "录像",
          sub: `${s.event_lines ?? 0} 事件 · ${fmtTime(s.start_ms)}`,
          ts: s.start_ms,
          isImage: false,
          sid: s.sid,
          path: s.session_path, // read_session 用
        }));
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

// 内嵌回放: 在主窗口直接读会话 + 用 rrweb 播放(不走 iframe —— Tauri 不给子 frame 注入 IPC, iframe 里 invoke 会失效)。
let rrwebReady: Promise<void> | null = null;
function ensureRrweb(): Promise<void> {
  if ((window as any).rrweb) return Promise.resolve();
  if (rrwebReady) return rrwebReady;
  rrwebReady = new Promise<void>((resolve, reject) => {
    if (!document.querySelector("link[data-rrweb]")) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/rrweb/2.0.0/style.css";
      css.setAttribute("data-rrweb", "1");
      document.head.appendChild(css);
    }
    const s = document.createElement("script");
    s.src = "/vendor/rrweb/2.0.0/rrweb.umd.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("rrweb 加载失败"));
    document.head.appendChild(s);
  });
  return rrwebReady;
}

function RecPlayer({ path }: { path: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState("加载中…");
  const [tl, setTl] = useState("");
  const playerRef = useRef<any>(null);
  const envsRef = useRef<any[]>([]);

  useEffect(() => {
    let alive = true;
    let replayer: any = null;
    setMsg("加载中…");
    setTl("");
    (async () => {
      let text = "";
      try {
        text = (await invoke<string>("read_session", { sessionPath: path })) || "";
      } catch (e) {
        if (alive) setMsg("读取失败: " + e);
        return;
      }
      const envs = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as any[];
      envsRef.current = envs;
      const events = envs.filter((e) => e.kind === "rrweb").map((e) => e.p.ev);
      if (events.length < 2) {
        if (alive) setMsg(envs.length ? "此会话无 DOM 回放(vscode/native 等)— 可导出 AI 时间线" : "无交互记录, 无法回放");
        return;
      }
      try {
        await ensureRrweb();
      } catch (e) {
        if (alive) setMsg(String(e));
        return;
      }
      if (!alive || !stage.current) return;
      stage.current.innerHTML = "";
      try {
        replayer = new (window as any).rrweb.Replayer(events, { root: stage.current, skipInactive: true });
        replayer.play();
        playerRef.current = replayer;
        setMsg("");
      } catch (e) {
        if (alive) setMsg("回放失败: " + e);
      }
    })();
    return () => {
      alive = false;
      try {
        replayer?.pause();
      } catch {
        /* ignore */
      }
    };
  }, [path]);

  const exportTl = async () => {
    try {
      const { sessionToTimeline } = await import("../replay/ai_timeline.js");
      const t = sessionToTimeline(envsRef.current);
      setTl(t);
      await navigator.clipboard.writeText(t).catch(() => {});
    } catch (e) {
      setMsg("导出失败: " + e);
    }
  };

  return (
    <div className="cm-rec">
      <div className="cm-rec-bar">
        <button className="cm-icobtn" onClick={() => playerRef.current?.play?.()} data-tip="播放">
          <Play size={15} />
        </button>
        <button className="cm-icobtn" onClick={() => playerRef.current?.pause?.()} data-tip="暂停">
          <Pause size={15} />
        </button>
        <button className="cm-icobtn" onClick={exportTl} data-tip="导出 AI 时间线(并复制)">
          <FileText size={15} />
        </button>
        {msg && <span className="cm-rec-msg">{msg}</span>}
      </div>
      {tl ? (
        <pre className="cm-preview-text" style={{ margin: 12, flex: 1, overflow: "auto" }}>{tl}</pre>
      ) : (
        <div className="cm-rec-stage" ref={stage} />
      )}
    </div>
  );
}

// 从剪贴板文本抠出文件路径: 整体是 [[路径]] 或 单行绝对路径(支持空格/中文)。
function extractFilePath(t: string): string | null {
  const s = (t || "").trim();
  const m = s.match(/^\[\[([^\]]+)\]\]$/);
  const cand = (m ? m[1] : s).trim();
  if ((/^[a-zA-Z]:[\\/]/.test(cand) || /^\\\\/.test(cand)) && !cand.includes("\n") && cand.length < 500) return cand;
  return null;
}
const isImgPath = (p: string) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(p);

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
  const [openPath, setOpenPath] = useState<string>(""); // 解析出来的真实文件(可"打开")

  useEffect(() => {
    setText("");
    setHtml("");
    setImg("");
    setShowRaw(false);
    setOpenPath("");
    if (!item || item.kind === "rec") return; // 录像走 iframe, 不在这里加载
    let alive = true;

    // 预览一个真实文件: 图片→显示图; 诊断报告→连带显示对应截图; md→渲染; 其它→文本。
    const showFile = async (fp: string) => {
      setOpenPath(fp);
      const ext = (fp.split(".").pop() || "").toLowerCase();
      if (isImgPath(fp)) {
        const b64 = await invoke<string>("read_file_b64", { path: fp }).catch(() => "");
        if (alive && b64) setImg("data:image/png;base64," + b64);
        return;
      }
      if (/poof-diagnostics/i.test(fp) && /report\.md$/i.test(fp)) {
        const shot = fp.replace(/report\.md$/i, "screen.png"); // 诊断报告旁的整屏截图
        const b64 = await invoke<string>("read_file_b64", { path: shot }).catch(() => "");
        if (alive && b64) setImg("data:image/png;base64," + b64);
      }
      const t = await invoke<string>("read_file_text", { path: fp }).catch(() => "");
      if (!alive) return;
      setText(t);
      if (ext === "md") {
        try {
          setHtml(renderMarkdownSafe(t));
        } catch {
          /* ignore */
        }
      }
    };

    (async () => {
      try {
        if (item.clipId) {
          const full: any = await invoke("clip_get", { id: item.clipId });
          if (!alive) return;
          if (full.image_b64) {
            setImg(full.image_b64);
            return;
          }
          const fp = full.text ? extractFilePath(full.text) : null;
          if (fp) {
            await showFile(fp); // 剪贴板里是文件链接/路径 → 预览那个文件(而不是只显示链接)
            return;
          }
          if (full.html) setHtml(sanitizeHtml(full.html));
          if (full.text) setText(full.text);
        } else if (item.kind === "md" && item.path) {
          await showFile(item.path);
        } else if (item.isImage && item.path) {
          setOpenPath(item.path);
          const b64 = await invoke<string>("read_file_b64", { path: item.path });
          if (!alive) return;
          setImg("data:image/png;base64," + b64);
          if (item.mdPath) {
            const t = await invoke<string>("read_file_text", { path: item.mdPath }).catch(() => "");
            if (alive && t) {
              setText(t);
              try {
                setHtml(renderMarkdownSafe(t));
              } catch {
                /* ignore */
              }
            }
          }
        } else if (item.path) {
          await showFile(item.path);
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

  const openTarget = openPath || item.mdPath || item.path;
  const isRec = item.kind === "rec" && !!item.sid;

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
        {text && !openPath && (
          <button className="cm-icobtn" onClick={() => invoke("copy_text", { text })} data-tip="复制文本">
            <Copy size={15} />
          </button>
        )}
        {openTarget && (
          <button className="cm-icobtn" onClick={() => invoke("open_path", { path: openTarget })} data-tip="用默认程序打开">
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
        {isRec ? (
          <RecPlayer path={item.path!} />
        ) : (
          <>
            {img && <img className="cm-preview-img" src={img} alt="" />}
            {html && !showRaw && <iframe className="cm-preview-html" sandbox="" srcDoc={withPreviewReset(html)} title="preview" />}
            {((html && showRaw) || (!html && text)) && <pre className="cm-preview-text">{text}</pre>}
            {!img && !html && !text && <div className="cm-empty">（无可预览内容）</div>}
          </>
        )}
      </div>
    </div>
  );
}
