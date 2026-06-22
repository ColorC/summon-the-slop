// BlockSuite 编辑器定制:
//  #5 内置 linked-doc 搜索("@" / 工具栏链接键弹出的 "Search file or anything")→ 接 poof 核心
//     搜索(MFT/Everything), 选中即把文件作为书签卡片插进当前笔记。用官方 ConfigExtension 的
//     linkedWidget.getMenus 钩子(widget 会 spread 默认配置再覆盖, 所以给部分字段即可)。
//  #8 slash 菜单中文化。BlockSuite 0.19.5 没导出 slash widget/config, 只能运行时拿到 widget
//     实例改它的 config.items 的 name/groupName(MIT 工程, 这是干净的运行时改法, 非改 node_modules)。
import { html } from "lit";
import { ConfigExtension } from "@blocksuite/block-std";
import { search } from "./lib";

const FILE_ICON = html`<span style="font-size:14px;line-height:1">📄</span>`;

function fileUrl(p: string): string {
  return /^https?:\/\//.test(p) ? p : "file:///" + String(p).replace(/\\/g, "/");
}

// #5 —— 内置搜索的数据源换成 Everything
export const FileSearchConfig = ConfigExtension("affine:page", {
  linkedWidget: {
    triggerKeys: ["@", "[[", "【【"],
    convertTriggerKey: true,
    ignoreBlockTypes: ["affine:code"],
    getMenus: async (query: string, abort: () => void, editorHost: any) => {
      const q = (query || "").trim();
      if (!q) return [];
      let hits: Array<{ name: string; path: string }> = [];
      try {
        hits = await search(q, 12);
      } catch {
        hits = [];
      }
      const doc = editorHost?.doc;
      return [
        {
          name: "文件 · Everything",
          maxDisplay: 12,
          items: hits.map((h) => ({
            key: h.path,
            name: h.name,
            icon: FILE_ICON,
            action: () => {
              abort();
              try {
                const note = doc?.getBlocksByFlavour?.("affine:note")?.[0];
                const pid = note?.model?.id ?? note?.id ?? doc?.root?.id;
                doc?.addBlock?.(
                  "affine:bookmark",
                  { url: fileUrl(h.path), title: h.name, description: h.path },
                  pid
                );
              } catch {
                /* ignore */
              }
            },
          })),
        },
      ];
    },
  },
});

// #8 —— slash 菜单中文(运行时改 widget.config)
const SLASH_ZH: Record<string, string> = {
  // 组名
  Basic: "基础",
  List: "列表",
  Style: "样式",
  Docs: "文档",
  Page: "页面",
  Headings: "标题",
  "Content & Media": "内容与媒体",
  Date: "日期",
  Database: "数据库",
  Others: "其他",
  Actions: "操作",
  // 条目
  "Other Headings": "更多标题",
  Text: "正文",
  "Heading 1": "标题 1",
  "Heading 2": "标题 2",
  "Heading 3": "标题 3",
  "Heading 4": "标题 4",
  "Heading 5": "标题 5",
  "Heading 6": "标题 6",
  "Bulleted List": "无序列表",
  "Numbered List": "有序列表",
  "To-do List": "待办列表",
  "Code Block": "代码块",
  Quote: "引用",
  Divider: "分割线",
  "Inline equation": "行内公式",
  "Equation Block": "公式块",
  Image: "图片",
  Link: "链接",
  Bookmark: "书签",
  Attachment: "附件",
  File: "文件",
  Table: "表格",
  "Group Database": "看板",
  "Grid Database": "表格视图",
  "New Doc": "新建文档",
  "Linked Doc": "链接文档",
  Today: "今天",
  Tomorrow: "明天",
  Yesterday: "昨天",
  Now: "现在",
  Frame: "画框",
  "Group elements": "成组",
  "Move Up": "上移",
  "Move Down": "下移",
  Copy: "复制",
  Duplicate: "副本",
  Delete: "删除",
};

function translateItems(items: any[]): any[] {
  return (items || []).map((it) => {
    const n = { ...it };
    if (typeof n.name === "string" && SLASH_ZH[n.name]) n.name = SLASH_ZH[n.name];
    if (typeof n.groupName === "string" && SLASH_ZH[n.groupName]) n.groupName = SLASH_ZH[n.groupName];
    if (typeof n.description === "string" && SLASH_ZH[n.description]) n.description = SLASH_ZH[n.description];
    if (Array.isArray(n.subMenu)) n.subMenu = translateItems(n.subMenu); // 递归子菜单
    return n;
  });
}

/** 编辑器挂载后调用: 把当前活动根上的 slash 菜单 config 改成中文。带重试(widget 异步挂载)。 */
export function localizeSlashMenu(editor: any): void {
  let tries = 0;
  const apply = (): boolean => {
    try {
      const rootId = editor?.doc?.root?.id;
      const view = editor?.std?.view;
      if (!rootId || !view?.getWidget) return false;
      const w = view.getWidget("affine-slash-menu-widget", rootId);
      if (!w || !w.config || !Array.isArray(w.config.items)) return false;
      w.config = { ...w.config, items: translateItems(w.config.items) };
      return true;
    } catch {
      return false;
    }
  };
  const t = window.setInterval(() => {
    if (apply() || ++tries > 25) window.clearInterval(t);
  }, 200);
}
