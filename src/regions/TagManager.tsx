// 标签管理台(M7) —— 在悬浮层内全屏覆盖(无独立窗口路由, 与 omni-web 同模式)。
// 左: 标签列表(按 group 分组, 改名/色/组/置顶/删); 右: 该标签下所有文件; 顶: 孤儿视图(失踪文件重指认)。
import { useEffect, useState, useCallback } from "react";
import { X, Pin, Trash2, FolderOpen, ExternalLink, Tag as TagIcon, Ghost, SlidersHorizontal, ArrowDownNarrowWide, EyeOff } from "lucide-react";
import {
  tagDefs,
  tagFiles,
  tagSetDef,
  tagRename,
  tagDelete,
  tagOrphans,
  tagReassign,
  tagRescue,
  tagsFor,
  tagRemove,
  listOverrides,
  setOverride,
  revealPath,
  openPath,
  type TagDef,
} from "../lib";
import { TagChip, colorOf } from "../lib/tagchip";

const SWATCHES = [
  "#6366f1", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6", "#14b8a6",
  "#f97316", "#84cc16",
];

function baseName(p: string) {
  const m = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return m[m.length - 1] || p;
}

export function TagManager({
  onClose,
  initialTag,
}: {
  onClose: () => void;
  initialTag?: string | null;
}) {
  const [defs, setDefs] = useState<TagDef[]>([]);
  const [sel, setSel] = useState<string | null>(initialTag ?? null);
  const [files, setFiles] = useState<string[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [over, setOver] = useState<[string, number][]>([]);
  const [tab, setTab] = useState<"tags" | "orphans" | "over">("tags");

  const reloadDefs = useCallback(
    () =>
      tagDefs().then((d) => {
        setDefs(d);
        setSel((s) => s ?? (d.length ? d[0].name : null));
      }),
    []
  );
  const reloadOrphans = useCallback(() => tagOrphans().then(setOrphans), []);
  const reloadOver = useCallback(() => listOverrides().then(setOver), []);
  useEffect(() => {
    reloadDefs();
    reloadOrphans();
    reloadOver();
  }, [reloadDefs, reloadOrphans, reloadOver]);
  useEffect(() => {
    if (sel) tagFiles(sel).then(setFiles);
    else setFiles([]);
  }, [sel, defs]);

  const cur = defs.find((d) => d.name === sel) || null;

  // group → defs（无组归 "未分组"）
  const groups: Record<string, TagDef[]> = {};
  for (const d of defs) {
    const g = d.group || "未分组";
    (groups[g] ||= []).push(d);
  }

  async function doRename() {
    if (!cur) return;
    const v = window.prompt("重命名标签：", cur.name)?.trim();
    if (!v || v === cur.name) return;
    await tagRename(cur.name, v);
    setSel(v);
    reloadDefs();
  }
  async function doDelete() {
    if (!cur) return;
    if (!window.confirm(`删除标签「${cur.name}」？会从所有文件上移除（文件本身不动）。`)) return;
    await tagDelete(cur.name);
    setSel(null);
    reloadDefs();
  }
  async function setColor(c: string) {
    if (!cur) return;
    await tagSetDef(cur.name, { color: c });
    reloadDefs();
  }
  async function togglePin() {
    if (!cur) return;
    await tagSetDef(cur.name, { pin: !cur.pin });
    reloadDefs();
  }
  async function setGroup() {
    if (!cur) return;
    const v = window.prompt("分组（留空=未分组，仅用于组织，不影响排序）：", cur.group || "")?.trim();
    if (v === undefined) return;
    await tagSetDef(cur.name, { group: v });
    reloadDefs();
  }
  async function reassignOrphan(p: string) {
    const v = window.prompt("重新指认到新路径（文件移动后用）：", p)?.trim();
    if (!v || v === p) return;
    await tagReassign(p, v);
    reloadOrphans();
    if (sel) tagFiles(sel).then(setFiles);
  }
  async function dropOrphanTags(p: string) {
    if (!window.confirm(`清除「${baseName(p)}」的所有标签条目？`)) return;
    const ts = await tagsFor(p);
    for (const t of ts) await tagRemove(p, t);
    reloadOrphans();
    if (sel) tagFiles(sel).then(setFiles);
  }

  return (
    <div className="tagmgr" onMouseDown={(e) => e.stopPropagation()}>
      <div className="tagmgr-head">
        <span className="tagmgr-title">
          <TagIcon size={16} /> 标签管理
        </span>
        <div className="tagmgr-tabs">
          <button className={tab === "tags" ? "on" : ""} onClick={() => setTab("tags")}>
            标签 {defs.length > 0 && <em>{defs.length}</em>}
          </button>
          <button className={tab === "orphans" ? "on" : ""} onClick={() => { setTab("orphans"); reloadOrphans(); }}>
            <Ghost size={13} /> 孤儿 {orphans.length > 0 && <em>{orphans.length}</em>}
          </button>
          <button className={tab === "over" ? "on" : ""} onClick={() => { setTab("over"); reloadOver(); }}>
            <SlidersHorizontal size={13} /> 纠偏 {over.length > 0 && <em>{over.length}</em>}
          </button>
        </div>
        <button className="tagmgr-x" onClick={onClose} title="关闭（Esc）">
          <X size={18} />
        </button>
      </div>

      {tab === "tags" ? (
        <div className="tagmgr-body">
          <div className="tagmgr-list">
            {defs.length === 0 && <div className="tagmgr-empty">还没有标签。右键搜索结果 → 🏷 标签… 开始打标签。</div>}
            {Object.entries(groups).map(([g, ds]) => (
              <div key={g} className="tagmgr-group">
                <div className="tagmgr-group-h">{g}</div>
                {ds.map((d) => (
                  <div
                    key={d.name}
                    className={"tagmgr-row" + (d.name === sel ? " on" : "")}
                    onClick={() => setSel(d.name)}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }}
                    onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("dragover");
                      const p = e.dataTransfer.getData("text/poof-path");
                      if (p) import("../lib").then(({ tagAdd }) => tagAdd(p, d.name)).then(() => { if (sel === d.name) tagFiles(d.name).then(setFiles); });
                    }}
                    title="可把搜索结果拖到这里打标签"
                  >
                    <span className="tagmgr-dot" style={{ background: colorOf(d.name, d.color) }} />
                    <span className="tagmgr-name">{d.name}</span>
                    {d.pin && <Pin size={12} className="tagmgr-pinned" />}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="tagmgr-detail">
            {cur ? (
              <>
                <div className="tagmgr-detail-h">
                  <TagChip name={cur.name} color={cur.color} pinned={cur.pin} size="md" />
                  <div className="tagmgr-acts">
                    <button onClick={togglePin} className={cur.pin ? "on" : ""} title="置顶：带此标签的文件在搜索里强力上浮">
                      <Pin size={14} /> {cur.pin ? "已置顶" : "置顶"}
                    </button>
                    <button onClick={setGroup} title="分组（仅组织）">分组</button>
                    <button onClick={doRename}>重命名</button>
                    <button onClick={doDelete} className="danger">
                      <Trash2 size={14} /> 删除
                    </button>
                  </div>
                </div>
                <div className="tagmgr-swatches">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      className={"sw" + (colorOf(cur.name, cur.color) === c ? " on" : "")}
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                      title={c}
                    />
                  ))}
                </div>
                <div className="tagmgr-files">
                  <div className="tagmgr-files-h">{files.length} 个文件 · 可拖到左侧别的标签上改打</div>
                  {files.map((f) => (
                    <div
                      key={f}
                      className="tagmgr-file"
                      onDoubleClick={() => openPath(f)}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/poof-path", f);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      <span className="tagmgr-file-name">{baseName(f)}</span>
                      <span className="tagmgr-file-path">{f}</span>
                      <button onClick={() => revealPath(f)} title="打开所在文件夹">
                        <FolderOpen size={13} />
                      </button>
                      <button onClick={() => openPath(f)} title="打开">
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="tagmgr-empty">左侧选一个标签</div>
            )}
          </div>
        </div>
      ) : tab === "orphans" ? (
        <div className="tagmgr-orphans">
          {orphans.length > 0 && (
            <div className="tagmgr-files-h" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>{orphans.length} 个失踪 · 标签悬空（14 天宽限后自动清）</span>
              <button
                style={{ marginLeft: "auto" }}
                onClick={async () => {
                  const moved = await tagRescue();
                  reloadOrphans();
                  if (sel) tagFiles(sel).then(setFiles);
                  window.alert(moved.length ? `FileId 救援：找回 ${moved.length} 个移动过的文件` : "没有可自动找回的（文件可能已删除）");
                }}
                title="按 FileId 自动找回移动过的文件（监视目录外的移动）"
              >
                一键救援（FileId）
              </button>
            </div>
          )}
          {orphans.length === 0 ? (
            <div className="tagmgr-empty">没有孤儿标签。文件移动/删除后失踪的标签会列在这里（14 天宽限后自动清）。</div>
          ) : (
            orphans.map((p) => (
              <div key={p} className="tagmgr-file">
                <span className="tagmgr-file-name">{baseName(p)}</span>
                <span className="tagmgr-file-path">{p}</span>
                <button onClick={() => reassignOrphan(p)} title="文件移走了？重新指认新路径">重新指认</button>
                <button onClick={() => dropOrphanTags(p)} className="danger" title="清除其标签条目">
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="tagmgr-orphans">
          {over.length === 0 ? (
            <div className="tagmgr-empty">没有排序纠偏。右键搜索结果可「置顶 / 降权 / 隐藏」，在这里统一管理与撤销。</div>
          ) : (
            over.map(([p, lvl]) => (
              <div key={p} className="tagmgr-file">
                <span className={"over-badge lv" + lvl}>
                  {lvl === 2 ? <><Pin size={11} /> 置顶</> : lvl === -1 ? <><ArrowDownNarrowWide size={11} /> 降权</> : <><EyeOff size={11} /> 隐藏</>}
                </span>
                <span className="tagmgr-file-name">{baseName(p)}</span>
                <span className="tagmgr-file-path">{p}</span>
                {lvl !== -2 && (
                  <button onClick={() => revealPath(p)} title="打开所在文件夹">
                    <FolderOpen size={13} />
                  </button>
                )}
                <button onClick={async () => { await setOverride(p, 0); reloadOver(); }} title="撤销纠偏（恢复正常排序）">
                  撤销
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
