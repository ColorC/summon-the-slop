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

// 全量中文(格式条/元素工具条/连线工具条/工具提示/链接卡片…无 config 钩子, 只能改 DOM)。
// MutationObserver 扫 BlockSuite "外壳"元素(弹层/工具条/tooltip), 把里面精确匹配到的英文词
// 换成中文。幂等(换完再触发也匹配不到), 不碰可编辑正文。
const UI_ZH: Record<string, string> = {
  ...SLASH_ZH,
  Bold: "加粗",
  Italic: "斜体",
  Underline: "下划线",
  Strikethrough: "删除线",
  Strike: "删除线",
  "Inline code": "行内代码",
  "Background color": "背景色",
  "Text color": "文字颜色",
  Color: "颜色",
  Highlight: "高亮",
  Comment: "评论",
  Conditions: "条件",
  "Turn into": "转换为",
  "Add frame": "加画框",
  "Add group": "成组",
  Group: "成组",
  Ungroup: "取消成组",
  "Release from group": "移出组",
  "Add note": "加便签",
  Note: "便签",
  Lock: "锁定",
  Unlock: "解锁",
  More: "更多",
  Align: "对齐",
  "Align left": "左对齐",
  "Align right": "右对齐",
  "Align center": "居中对齐",
  Distribute: "分布",
  Switch: "切换",
  Shadow: "阴影",
  "Bring to front": "置于顶层",
  "Bring forward": "上移一层",
  "Send backward": "下移一层",
  "Send to back": "置于底层",
  Connector: "连线",
  Pen: "画笔",
  Shape: "形状",
  Eraser: "橡皮",
  Hand: "抓手",
  Select: "选择",
  "Fit to screen": "适应屏幕",
  Present: "演示",
  "Mind Map": "思维导图",
  Template: "模板",
  Open: "打开",
  "Open in new tab": "在新标签打开",
  "Open this doc": "打开此文档",
  "Open doc": "打开文档",
  Edit: "编辑",
  Cancel: "取消",
  Confirm: "确认",
  Reset: "重置",
  Caption: "说明",
  Reload: "重新加载",
  Download: "下载",
  Rename: "重命名",
  "Copy link": "复制链接",
  Embed: "嵌入",
  Bookmark: "书签",
  Card: "卡片",
  "Search file or anything": "搜索文件 / 任何东西…",
  "Link to Doc": "链接文档",
  "New Doc": "新建文档",
  "Add tag": "加标签",
};

const CHROME_SEL = [
  "affine-slash-menu",
  "inner-slash-menu",
  ".slash-menu",
  "editor-toolbar",
  "affine-format-bar-widget",
  ".affine-format-bar-widget",
  "edgeless-toolbar",
  "edgeless-element-toolbar",
  "affine-tooltip",
  ".affine-tooltip",
  ".blocksuite-portal",
  "affine-linked-doc-popover",
  ".affine-link-popover",
  ".affine-embed-card-toolbar",
  ".bookmark-card",
].join(",");

function translateEl(el: Element): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) texts.push(cur as Text);
  for (const tn of texts) {
    const raw = tn.nodeValue || "";
    const t = raw.trim();
    if (t && UI_ZH[t]) tn.nodeValue = raw.replace(t, UI_ZH[t]);
  }
  el.querySelectorAll<HTMLElement>("[aria-label],[data-tooltip]").forEach((e) => {
    const a = e.getAttribute("aria-label");
    if (a && UI_ZH[a.trim()]) e.setAttribute("aria-label", UI_ZH[a.trim()]);
    const d = e.getAttribute("data-tooltip");
    if (d && UI_ZH[d.trim()]) e.setAttribute("data-tooltip", UI_ZH[d.trim()]);
  });
}

let translatorOn = false;
export function installChromeTranslator(): void {
  if (translatorOn || typeof document === "undefined") return;
  translatorOn = true;
  let scheduled = false;
  const sweep = () => {
    scheduled = false;
    document.querySelectorAll(CHROME_SEL).forEach(translateEl);
  };
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sweep);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
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
