// 工作流二·笔记 ↔ omnicompany 项目/计划 关联(@ 内联引用 + 跳转)。
//
// 正向(笔记→omni): 在 @ 菜单里列 omni 项目/计划(omni project/plan list --json), 选中插一个内联引用
//   (reference, pageId="__omni:project:<id>" / "__omni:plan:<id>", 把标题一并存进 reference 属性)。
// 跳转: 点引用 → docLinkClicked 发 referenceInfo → 拦 __omni: 前缀 → 项目跳 vscode(focus_window 项目根名)、
//   计划/兜底打开看板(8210)。
// 反向(omni→笔记, 用 decisions 域 anchor.kind=note)留作下一片。
import { html } from "lit";
import { RefNodeSlotsProvider } from "@blocksuite/affine-components/rich-text";
import { runShell, focusWindow, openPath } from "../lib";

const OMNI_PREFIX = "__omni:"; // pageId: __omni:project:<id> / __omni:plan:<id>
const BOARD_URL = "http://localhost:8210/";

export interface OmniEntity {
  id: string;
  kind: "project" | "plan";
  name: string;
  group?: string;
  roots?: string[]; // 项目根目录(用来跳 vscode)
}

function refId(e: OmniEntity): string {
  return OMNI_PREFIX + e.kind + ":" + e.id;
}

// 缓存 refId→entity, 持久化: 重载后点击老引用仍能跳/显示
const CACHE_KEY = "poof-omni-entities";
function loadCache(): Record<string, OmniEntity> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}
function cacheEntity(e: OmniEntity): void {
  const m = loadCache();
  m[refId(e)] = e;
  localStorage.setItem(CACHE_KEY, JSON.stringify(m));
}

// ---- omni 数据源 ----
let projectsCache: OmniEntity[] | null = null;
let plansCache: OmniEntity[] | null = null;

export async function omniProjects(): Promise<OmniEntity[]> {
  if (projectsCache) return projectsCache;
  try {
    const r = await runShell("omni project list --json");
    const data = JSON.parse(r.stdout || "{}");
    const arr: any[] = data.projects || (Array.isArray(data) ? data : []);
    projectsCache = arr.map((p) => ({
      id: p.id,
      kind: "project" as const,
      name: p.name || p.id,
      group: p.group,
      roots: p.roots || [],
    }));
    return projectsCache;
  } catch {
    return [];
  }
}

export async function omniPlans(): Promise<OmniEntity[]> {
  if (plansCache) return plansCache;
  try {
    const r = await runShell("omni plan list --json");
    const data = JSON.parse(r.stdout || "[]");
    const arr: any[] = Array.isArray(data) ? data : data.plans || [];
    plansCache = arr.map((p) => ({
      id: p.plan_id || p.id,
      kind: "plan" as const,
      name: p.title || p.plan_id || p.id,
    }));
    return plansCache;
  } catch {
    return [];
  }
}

// ---- 插入内联引用(REFERENCE_NODE 就是个空格, 引用信息在 attributes.reference 里, title 一并存)----
function insertOmniRef(inlineEditor: any, e: OmniEntity): void {
  if (!inlineEditor?.getInlineRange) return;
  const range = inlineEditor.getInlineRange();
  if (!range) return;
  cacheEntity(e);
  inlineEditor.insertText(range, " ", {
    reference: { type: "LinkedPage", pageId: refId(e), title: e.name },
  });
  inlineEditor.setInlineRange?.({ index: range.index + 1, length: 0 });
}

function fuzzy(name: string, q: string): boolean {
  if (!q) return true;
  return name.toLowerCase().includes(q.toLowerCase());
}

const PROJ_ICON = html`<span style="font-size:14px;line-height:1">📦</span>`;
const PLAN_ICON = html`<span style="font-size:14px;line-height:1">📋</span>`;

/** 给 @ 菜单贡献 omni 项目/计划两组(供 editorConfig 的 getMenus 拼进去)。 */
export async function omniMenuGroups(
  query: string,
  abort: () => void,
  inlineEditor: any
): Promise<any[]> {
  const q = (query || "").trim();
  const [projects, plans] = await Promise.all([omniProjects(), omniPlans()]);
  const groups: any[] = [];
  const projItems = projects
    .filter((p) => fuzzy(p.name + " " + (p.group || ""), q))
    .slice(0, 8)
    .map((p) => ({
      key: refId(p),
      name: p.name,
      icon: PROJ_ICON,
      action: () => {
        abort();
        insertOmniRef(inlineEditor, p);
      },
    }));
  if (projItems.length) groups.push({ name: "omni 项目", items: projItems, maxDisplay: 8 });
  const planItems = plans
    .filter((p) => fuzzy(p.name, q))
    .slice(0, 8)
    .map((p) => ({
      key: refId(p),
      name: p.name,
      icon: PLAN_ICON,
      action: () => {
        abort();
        insertOmniRef(inlineEditor, p);
      },
    }));
  if (planItems.length) groups.push({ name: "omni 计划", items: planItems, maxDisplay: 8 });
  return groups;
}

// ---- 反向(omni→笔记): 扫一篇笔记里的 @omni 引用, 落进 localStorage 映射, 供 index.json 带出 ----
// omni 读 index.json 的每条 note.links 即知"哪些笔记关联了项目 X"(比给每个 @mention 记一条 decision 轻)。
const LINKS_KEY = "poof-note-omnilinks"; // { noteId: [{kind,id,name}] }

export interface OmniLink {
  kind: "project" | "plan";
  id: string;
  name: string;
}

/** 扫 doc 所有文本块的 delta, 收集 reference 里 __omni: 前缀的引用。 */
export function scanOmniLinks(doc: any): OmniLink[] {
  const out: OmniLink[] = [];
  const seen = new Set<string>();
  const cache = loadCache();
  try {
    const blocks = doc.getBlocksByFlavour?.([
      "affine:paragraph",
      "affine:list",
      "affine:code",
    ]) || [];
    for (const b of blocks) {
      const model = b?.model ?? b;
      const deltas = model?.text?.yText?.toDelta?.() ?? model?.text?.toDelta?.() ?? [];
      for (const d of deltas) {
        const pid = d?.attributes?.reference?.pageId;
        if (typeof pid === "string" && pid.startsWith(OMNI_PREFIX) && !seen.has(pid)) {
          seen.add(pid);
          const e = cache[pid];
          const m = pid.slice(OMNI_PREFIX.length).match(/^(project|plan):(.+)$/);
          if (m) {
            out.push({
              kind: m[1] as "project" | "plan",
              id: m[2],
              name: e?.name || d.attributes.reference.title || m[2],
            });
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 扫并把这篇笔记的 omni 关联落进映射(在导出/保存时调)。 */
export function recordNoteOmniLinks(doc: any): void {
  if (!doc?.id) return;
  try {
    const map = JSON.parse(localStorage.getItem(LINKS_KEY) || "{}");
    const links = scanOmniLinks(doc);
    if (links.length) map[doc.id] = links;
    else delete map[doc.id];
    localStorage.setItem(LINKS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 读某笔记的 omni 关联(供 index.json 带出)。 */
export function omniLinksOf(noteId: string): OmniLink[] {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) || "{}")[noteId] || [];
  } catch {
    return [];
  }
}

// ---- 点引用跳转: 拦 docLinkClicked 的 __omni: 引用 ----
export function jumpOmni(refIdStr: string): void {
  const e = loadCache()[refIdStr];
  if (e?.kind === "project") {
    // 跳 vscode: 用项目根目录的 basename 当 query 模糊命中已开窗口
    const root = (e.roots || [])[0] || e.name;
    const base = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || e.name;
    focusWindow(base)
      .then((hit) => {
        if (!hit) void openPath(BOARD_URL); // 没开着就打开看板
      })
      .catch(() => void openPath(BOARD_URL));
  } else {
    void openPath(BOARD_URL); // 计划暂时跳看板(深链待 8210 前端支持)
  }
}

/** 装上 omni 引用点击跳转。返回 cleanup。 */
export function installOmniRefJump(editor: any): () => void {
  let off = () => {};
  let tries = 0;
  const iv = window.setInterval(() => {
    try {
      const slots = editor?.std?.getOptional?.(RefNodeSlotsProvider);
      if (slots?.docLinkClicked?.on) {
        const d = slots.docLinkClicked.on((info: any) => {
          const pid = info?.pageId;
          if (typeof pid === "string" && pid.startsWith(OMNI_PREFIX)) jumpOmni(pid);
        });
        off = () => {
          try {
            d?.dispose?.();
          } catch {
            /* ignore */
          }
        };
        window.clearInterval(iv);
      }
    } catch {
      /* ignore */
    }
    if (++tries > 25) window.clearInterval(iv);
  }, 200);
  return () => {
    window.clearInterval(iv);
    off();
  };
}
