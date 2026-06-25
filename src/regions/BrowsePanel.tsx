// 浏览/插入面板 —— 取代"全是图标"的模板面板。四个源: 文件(Everything) / 计划 / 任务(进度) / 审阅材料。
// 网格视图显示文本内容(不是文件图标), 可切列表视图; 大窗; 选中即作为同步源块插进当前笔记。
import { useEffect, useRef, useState } from "react";
import "./BrowsePanel.css";
import { search, readFileText } from "../lib";
import { insertFileIntoNote } from "./fileInsert";
import {
  omniPlanList,
  omniProgressList,
  omniReviewList,
  insertOmniSource,
  type OmniListItem,
} from "./omniSources";

type Tab = "file" | "plan" | "progress" | "review";
type ViewMode = "grid" | "list";

interface Result {
  kind: "file" | "plan" | "progress" | "review";
  ref: string;
  title: string;
  preview: string;
  meta?: string;
  path?: string;
  ext?: string;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "file", label: "文件" },
  { key: "plan", label: "计划" },
  { key: "progress", label: "任务/进度" },
  { key: "review", label: "审阅材料" },
];

const TEXT_EXTS = new Set([
  "md", "markdown", "mdx", "txt", "text", "log", "json", "yaml", "yml", "toml",
  "ini", "csv", "tsv", "js", "ts", "tsx", "jsx", "py", "rs", "go", "java",
  "html", "css", "scss", "sh", "bash", "sql", "xml", "vue",
]);

export function BrowsePanel({
  getDoc,
  onClose,
  onInserted,
}: {
  getDoc: () => any;
  onClose: () => void;
  onInserted?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("file");
  const [view, setView] = useState<ViewMode>("grid");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [, forceRender] = useState(0);
  const previewCache = useRef<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tab]);

  // 拉结果(tab / 查询变)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      let rs: Result[] = [];
      if (tab === "file") {
        if (q.trim()) {
          const hits = (await search(q.trim(), 30).catch(() => [])) as Array<{
            name: string;
            path: string;
          }>;
          rs = hits.map((h) => ({
            kind: "file" as const,
            ref: h.path,
            title: h.name,
            preview: h.path,
            path: h.path,
            ext: (h.name.split(".").pop() || "").toLowerCase(),
          }));
        }
      } else {
        const list: OmniListItem[] =
          tab === "plan"
            ? await omniPlanList()
            : tab === "progress"
              ? await omniProgressList()
              : await omniReviewList();
        const ql = q.trim().toLowerCase();
        rs = list
          .filter(
            (it) =>
              !ql ||
              it.title.toLowerCase().includes(ql) ||
              it.preview.toLowerCase().includes(ql)
          )
          .map((it) => ({
            kind: it.kind,
            ref: it.ref,
            title: it.title,
            preview: it.preview,
            meta: it.meta,
          }));
      }
      if (!cancelled) {
        setResults(rs);
        setLoading(false);
      }
    };
    const t = setTimeout(run, tab === "file" ? 250 : 0); // 文件搜索防抖
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tab, q]);

  // 文件: 懒取文本预览(前若干个文本文件)
  useEffect(() => {
    if (tab !== "file") return;
    let alive = true;
    results.slice(0, 16).forEach(async (r) => {
      if (!r.path || !TEXT_EXTS.has(r.ext || "")) return;
      if (previewCache.current[r.path] != null) return;
      previewCache.current[r.path] = ""; // 占位防重复拉
      try {
        const txt = await readFileText(r.path);
        previewCache.current[r.path] = txt.replace(/\s+/g, " ").trim().slice(0, 220);
      } catch {
        previewCache.current[r.path] = "";
      }
      if (alive) forceRender((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [results, tab]);

  const doInsert = async (r: Result) => {
    const doc = getDoc();
    if (!doc) return;
    setBusy(r.ref);
    try {
      if (r.kind === "file") {
        await insertFileIntoNote(doc, r.path!, r.title);
      } else {
        await insertOmniSource(doc, {
          kind: r.kind,
          ref: r.ref,
          title: r.title,
          preview: r.preview,
          meta: r.meta,
        });
      }
      onInserted?.();
      onClose();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[browse] 插入失败", e);
      setBusy("");
    }
  };

  const textOf = (r: Result): string => {
    if (r.kind === "file") return r.path ? previewCache.current[r.path] || "" : "";
    return r.preview;
  };

  return (
    <div className="poof-browse-overlay" onClick={onClose}>
      <div className="poof-browse" onClick={(e) => e.stopPropagation()}>
        <div className="pb-head">
          <span className="pb-title">插入内容</span>
          <div className="pb-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={"pb-tab" + (tab === t.key ? " on" : "")}
                onClick={() => {
                  setTab(t.key);
                  setQ(""); // 换源清过滤, 否则上一个 tab 的关键词会把新源筛空
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="pb-spacer" />
          <button
            className="pb-view"
            title={view === "grid" ? "切列表视图" : "切网格视图"}
            onClick={() => setView((v) => (v === "grid" ? "list" : "grid"))}
          >
            {view === "grid" ? "☰ 列表" : "▦ 网格"}
          </button>
          <button className="pb-close" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          className="pb-search"
          placeholder={tab === "file" ? "搜本机文件(Everything)…" : "过滤标题/内容…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className={"pb-body " + view}>
          {loading && <div className="pb-empty">加载中…</div>}
          {!loading && results.length === 0 && (
            <div className="pb-empty">
              {tab === "file" && !q.trim() ? "输入关键词搜文件" : "没有结果"}
            </div>
          )}
          {!loading &&
            results.map((r) => (
              <button
                key={r.kind + ":" + r.ref}
                className={"pb-item" + (busy === r.ref ? " busy" : "")}
                onClick={() => doInsert(r)}
                title={"插入: " + r.title}
              >
                <div className="pb-item-head">
                  <span className="pb-badge">
                    {r.kind === "file" ? (r.ext || "file").toUpperCase().slice(0, 4) : TABS.find((t) => t.key === r.kind)?.label}
                  </span>
                  <span className="pb-item-title">{r.title || "未命名"}</span>
                </div>
                <div className="pb-item-text">{textOf(r) || (r.kind === "file" ? r.path : "")}</div>
              </button>
            ))}
        </div>
        <div className="pb-foot">
          {results.length} 项 · 选中即作为同步源块插入当前笔记(双向写回 + 历史)
        </div>
      </div>
    </div>
  );
}
