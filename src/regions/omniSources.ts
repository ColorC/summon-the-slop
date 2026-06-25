// omni 源适配器 + 列表(给浏览面板)。三类:
//  · 计划(plan)   —— 本质是 omnicompany/docs/plans/<id>/plan.md, 解析成路径后走 md-file 适配器(可写回)。
//  · 任务/进度(progress) —— 进度时间线条目, 读 `omni progress list --json`, 写 `omni progress edit <id> <text>`(可写回, 简单时间戳笔记)。
//  · 审阅材料(review) —— data/boss_sight/reviewstage/mat_<id>.json(inline_content 或 file_relpath), **只读**(动审阅判定, 后议)。
// 决策见 docs/plans/synced-source-blocks-and-browse-plan.md §9。
import { runShell, readFileText } from "../lib";
import { registerSourceAdapter, insertBoundSource } from "./boundSource";

const REVIEWSTAGE = "E:/WindowsWorkspace/omnicompany/data/boss_sight/reviewstage";

export interface OmniListItem {
  kind: "plan" | "progress" | "review";
  ref: string; // plan_id / progress id / mat_id
  title: string;
  preview: string; // 副标题/元信息
  meta?: string;
}

// ============ 列表(浏览面板用) ============
export async function omniPlanList(): Promise<OmniListItem[]> {
  try {
    const r = await runShell("omni plan list --json");
    const arr = JSON.parse(r.stdout || "[]");
    return (arr as any[]).map((p) => ({
      kind: "plan" as const,
      ref: p.plan_id,
      title: p.title || p.plan_id,
      preview: [p.status, p.work_type, p.date].filter(Boolean).join(" · "),
      meta: p.status,
    }));
  } catch {
    return [];
  }
}

export async function omniProgressList(): Promise<OmniListItem[]> {
  try {
    const r = await runShell("omni progress list --json");
    const arr = JSON.parse(r.stdout || "[]");
    return (arr as any[])
      .slice()
      .reverse() // 新的在前
      .map((e) => ({
        kind: "progress" as const,
        ref: e.id,
        title: (e.text || "").split("\n")[0].slice(0, 70) || e.id,
        preview: `${e.ref_type || ""}:${e.ref_id || ""} · ${(e.created_at || "").slice(0, 10)}`,
        meta: e.ref_id,
      }));
  } catch {
    return [];
  }
}

export async function omniReviewList(max = 40): Promise<OmniListItem[]> {
  try {
    const r = await runShell(`omni review list --max ${max}`);
    const out: OmniListItem[] = [];
    for (const ln of (r.stdout || "").split("\n")) {
      // 形如:  - mat_xxx [important/accepted] kind=markdown plan=personal-site title='...'
      const m = ln.match(/-\s+(mat_\w+)\s+\[([^/\]]+)\/([^\]]+)\]\s+kind=(\S+)\s+plan=(\S+)\s+title='(.*)'/);
      if (m) {
        out.push({
          kind: "review",
          ref: m[1],
          title: m[6],
          preview: `${m[4]} · ${m[2]}/${m[3]} · ${m[5]}`,
          meta: m[3],
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ============ 计划路径解析(plan_id → .md 文件) ============
export async function resolvePlanFile(planId: string): Promise<string | null> {
  let base = "";
  try {
    const r = await runShell(`omni plan show "${planId}"`);
    const m = (r.stdout || "").match(/^path\s*:\s*(.+)$/m);
    base = (m?.[1] || "").trim();
  } catch {
    return null;
  }
  if (!base) return null;
  for (const cand of [base + "/plan.md", base + ".md", base]) {
    try {
      await readFileText(cand);
      return cand; // 读得到就是它
    } catch {
      /* 下一个候选 */
    }
  }
  return base + "/plan.md"; // 都读不到也返回最可能的(让上层报错)
}

// ============ 适配器 ============
function cmdQuote(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"'; // cmd /C 内双引号转义
}

registerSourceAdapter({
  kind: "omni-progress",
  writable: true,
  read: async (ref) => {
    try {
      const r = await runShell("omni progress list --json");
      const arr = JSON.parse(r.stdout || "[]");
      return (arr as any[]).find((x) => x.id === ref)?.text ?? "";
    } catch {
      return "";
    }
  },
  write: async (ref, md) => {
    const text = md.replace(/\r?\n+/g, " ").trim(); // 进度一条 = 一段文本, 压平换行
    if (!text) return;
    await runShell(`omni progress edit ${ref} ${cmdQuote(text)}`);
  },
  label: (ref) => "进度 " + ref,
});

registerSourceAdapter({
  kind: "omni-review",
  writable: false, // 先只读
  read: async (ref) => {
    try {
      const raw = await readFileText(`${REVIEWSTAGE}/${ref}.json`);
      const j = JSON.parse(raw);
      if (j.inline_content) return String(j.inline_content);
      if (j.file_relpath) return await readFileText(`${REVIEWSTAGE}/${j.file_relpath}`);
      return j.title || "";
    } catch {
      return "";
    }
  },
  write: async () => {
    /* 只读, 不写回 */
  },
  label: (ref) => "审阅 " + ref,
});

// ============ 统一插入: 浏览面板选中一个 omni 实体 → 绑定块 ============
export async function insertOmniSource(hostDoc: any, item: OmniListItem): Promise<string | null> {
  if (item.kind === "plan") {
    const path = await resolvePlanFile(item.ref);
    if (!path) return null;
    return insertBoundSource(hostDoc, "md-file", path); // 计划 = md 文件, 可写回
  }
  if (item.kind === "progress") return insertBoundSource(hostDoc, "omni-progress", item.ref);
  if (item.kind === "review") return insertBoundSource(hostDoc, "omni-review", item.ref);
  return null;
}
