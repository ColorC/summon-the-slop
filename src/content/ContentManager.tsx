// 快选内容管理界面 —— 一个窗口管 ① 剪贴板历史(文本/图片/HTML, 持久, 预览, 恢复, 删除)
// ② poof 快照(截图 + 诊断快照) ③ omni/poof 捕获(captures 目录的页面快照/圈选)。左列表 + 右预览。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { micromark } from "micromark";

type Tab = "clipboard" | "snapshots" | "captures";
const CAPTURES_DIR = "E:/WindowsWorkspace/captures";

interface Item {
  key: string;
  tab: Tab;
  kind: string; // text | html | image | shot | diag | md | png | ...
  title: string;
  sub: string;
  ts: number;
  isImage: boolean;
  clipId?: string;
  path?: string; // 图片/文件路径
  mdPath?: string; // 诊断报告路径
  dir?: string; // 诊断目录(删除用)
}

const TABS: { key: Tab; label: string }[] = [
  { key: "clipboard", label: "剪贴板历史" },
  { key: "snapshots", label: "poof 快照" },
  { key: "captures", label: "捕获 / 圈选" },
];

function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

  // 窄(停靠侧栏)时上下堆叠, 宽(浮窗/拉宽)时左右并排
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setNarrow(entries[0].contentRect.width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
          sub: `${e.kind} · ${fmtTime(e.ts_ms)}`,
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
          sub: `截图 ${s.w}×${s.h} · ${fmtTime(s.ts_ms)}`,
          ts: s.ts_ms,
          isImage: true,
          path: s.path,
        }));
        const b: Item[] = diags.map((d) => ({
          key: "diag:" + d.dir,
          tab: "snapshots" as Tab,
          kind: "diag",
          title: "诊断 " + d.name,
          sub: `全量诊断 · ${fmtTime(d.ts_ms)}`,
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
            sub: `${f.ext} · ${fmtTime(f.ts_ms)}`,
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

  // 剪贴板 tab: 轻量轮询(监听线程在后台加新条目)
  useEffect(() => {
    if (tab !== "clipboard") return;
    const iv = setInterval(() => load("clipboard"), 3000);
    return () => clearInterval(iv);
  }, [tab, load]);

  // 懒取缩略图
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

  const filtered = items.filter(
    (it) => !q.trim() || (it.title + " " + it.sub).toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <div className={"cm" + (narrow ? " narrow" : "")} ref={rootRef}>
      <div className="cm-head">
        <div className="cm-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={"cm-tab" + (tab === t.key ? " on" : "")} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="cm-spacer" />
        <input className="cm-search" placeholder="过滤…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="cm-btn" onClick={() => load(tab)} title="刷新">
          ↻
        </button>
        <button
          className="cm-btn"
          title="立刻做一次全量诊断快照(截图 + 状态, 复制链接)。也可按 Ctrl+Alt+D"
          onClick={async () => {
            try {
              const r: any = await invoke("diagnostic_snapshot", {
                stateJson: JSON.stringify({ time: new Date().toString(), from: "内容管理窗口" }, null, 2),
                when: new Date().toString(),
              });
              setTab("snapshots");
              setTimeout(() => load("snapshots"), 200);
              alert(`诊断快照已存(${r.windows} 个窗口截图)· 报告链接已复制剪贴板\n${r.md}`);
            } catch (e) {
              alert("诊断失败: " + e);
            }
          }}
        >
          📸 诊断快照
        </button>
        {tab === "clipboard" && (
          <button
            className="cm-btn danger"
            title="清空剪贴板历史"
            onClick={async () => {
              if (confirm("清空全部剪贴板历史?")) {
                await invoke("clip_clear");
                load("clipboard");
                setSel(null);
              }
            }}
          >
            清空
          </button>
        )}
      </div>
      <div className="cm-body">
        <div className="cm-list">
          {loading && <div className="cm-empty">加载中…</div>}
          {!loading && filtered.length === 0 && <div className="cm-empty">没有内容</div>}
          {filtered.map((it) => (
            <button
              key={it.key}
              className={"cm-item" + (sel?.key === it.key ? " sel" : "")}
              onClick={() => setSel(it)}
            >
              <div className="cm-item-thumb">
                {it.isImage ? (
                  thumbOf(it) ? (
                    <img src={thumbOf(it)} alt="" />
                  ) : (
                    <span className="cm-ph">🖼</span>
                  )
                ) : (
                  <span className="cm-badge">{it.kind.toUpperCase().slice(0, 4)}</span>
                )}
              </div>
              <div className="cm-item-meta">
                <div className="cm-item-title">{it.title || "(空)"}</div>
                <div className="cm-item-sub">{it.sub}</div>
              </div>
            </button>
          ))}
        </div>
        <Preview item={sel} onChanged={() => load(tab)} />
      </div>
    </div>
  );
}

function Preview({ item, onChanged }: { item: Item | null; onChanged: () => void }) {
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
          const t: string = await invoke<string>("read_file_text", { path: item.path });
          if (!alive) return;
          setText(t);
          try {
            setHtml(micromark(t));
          } catch {
            /* ignore */
          }
        } else if (item.isImage && item.path) {
          const b64: string = await invoke<string>("read_file_b64", { path: item.path });
          if (!alive) return;
          setImg("data:image/png;base64," + b64);
          if (item.mdPath) {
            const t: string = await invoke<string>("read_file_text", { path: item.mdPath }).catch(() => "");
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
          const t: string = await invoke<string>("read_file_text", { path: item.path }).catch(() => "");
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

  if (!item) return <div className="cm-preview cm-empty">选一项预览</div>;

  const copy = (s: string) => invoke("copy_text", { text: s });
  const del = async () => {
    if (item.clipId) await invoke("clip_delete", { id: item.clipId });
    else if (item.kind === "shot" && item.path) await invoke("delete_shot", { path: item.path });
    else if (item.kind === "diag" && item.dir) await invoke("delete_diagnostic", { dir: item.dir });
    else return;
    onChanged();
  };

  return (
    <div className="cm-preview">
      <div className="cm-preview-bar">
        <span className="cm-preview-title">{item.title}</span>
        <span className="cm-spacer" />
        {item.clipId && (
          <button className="cm-btn" onClick={async () => { await invoke("clip_restore", { id: item.clipId }); }}>
            恢复到剪贴板
          </button>
        )}
        {item.mdPath && (
          <button className="cm-btn" onClick={() => copy(`[[${item.mdPath}]]`)} title="复制报告链接">
            复制链接
          </button>
        )}
        {item.path && (
          <button className="cm-btn" onClick={() => invoke("open_path", { path: item.path })} title="用默认程序打开">
            打开
          </button>
        )}
        {text && (
          <button className="cm-btn" onClick={() => copy(text)} title="复制文本">
            复制文本
          </button>
        )}
        {html && (
          <button className="cm-btn" onClick={() => setShowRaw((r) => !r)}>
            {showRaw ? "渲染" : "源码"}
          </button>
        )}
        {(item.clipId || item.kind === "shot" || item.kind === "diag") && (
          <button className="cm-btn danger" onClick={del}>
            删除
          </button>
        )}
      </div>
      <div className="cm-preview-body">
        {img && <img className="cm-preview-img" src={img} alt="" />}
        {html && !showRaw && (
          <iframe className="cm-preview-html" sandbox="" srcDoc={html} title="preview" />
        )}
        {((html && showRaw) || (!html && text)) && <pre className="cm-preview-text">{text}</pre>}
        {!img && !html && !text && <div className="cm-empty">（无可预览内容）</div>}
      </div>
    </div>
  );
}
