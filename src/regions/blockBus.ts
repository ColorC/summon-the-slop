// 统一插入总线 + 块注册表 —— 文件块 / 同步源块(md·计划·进度·审阅) / AI 块, 一个入口。
// slash 菜单 / 浏览面板 / CLI(notebridge add-block) 都走 insertBlock, 不再各写各的(防膨胀)。
import { insertFileIntoNote } from "./fileInsert";
import { insertOmniSource } from "./omniSources";
import { insertAiBlock } from "../blocks/aiblock";

export type BlockKind = "md" | "file" | "plan" | "progress" | "review" | "ai";

export interface BlockSpec {
  kind: BlockKind;
  label: string;
  needsRef: boolean; // 需要一个源标识(文件路径 / plan_id / 进度 id / mat_id)
  synced: boolean; // 是不是双向同步源块
}

export const BLOCK_REGISTRY: BlockSpec[] = [
  { kind: "md", label: "Markdown 文件(原生块·双向同步)", needsRef: true, synced: true },
  { kind: "file", label: "文件(代码块/原文·写回)", needsRef: true, synced: true },
  { kind: "plan", label: "omni 计划(双向同步)", needsRef: true, synced: true },
  { kind: "progress", label: "omni 进度/任务(双向同步)", needsRef: true, synced: true },
  { kind: "review", label: "omni 审阅材料(只读)", needsRef: true, synced: true },
  { kind: "ai", label: "AI 块", needsRef: false, synced: false },
];

export async function insertBlock(
  doc: any,
  kind: BlockKind,
  args: { ref?: string; name?: string; text?: string } = {}
): Promise<string | null> {
  switch (kind) {
    case "md":
      return insertFileIntoNote(doc, args.ref!, args.name); // md → 同步源块(原生)
    case "file":
      return insertFileIntoNote(doc, args.ref!, args.name, { raw: true }); // 其它文件 → 代码块/原文
    case "plan":
    case "progress":
    case "review":
      return insertOmniSource(doc, { kind, ref: args.ref!, title: "", preview: "" });
    case "ai":
      return insertAiBlock(doc, args.text || "");
    default:
      return null;
  }
}
