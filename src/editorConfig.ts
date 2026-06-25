// BlockSuite 编辑器定制:
//  #5 内置 linked-doc 搜索("@" / 工具栏链接键弹出的 "Search file or anything")→ 接 poof 核心
//     搜索(MFT/Everything), 选中即把文件作为书签卡片插进当前笔记。用官方 ConfigExtension 的
//     linkedWidget.getMenus 钩子(widget 会 spread 默认配置再覆盖, 所以给部分字段即可)。
//  #8 slash 菜单中文化。BlockSuite 0.19.5 没导出 slash widget/config, 只能运行时拿到 widget
//     实例改它的 config.items 的 name/groupName(MIT 工程, 这是干净的运行时改法, 非改 node_modules)。
import { html } from "lit";
import { ConfigExtension } from "@blocksuite/block-std";
import { EdgelessTemplatePanel } from "@blocksuite/blocks";
import { search } from "./lib";
import { insertFileIntoNote } from "./regions/fileInsert";
import { omniMenuGroups } from "./regions/omniLink";

const FILE_ICON = html`<span style="font-size:14px;line-height:1">📄</span>`;

// #5 —— 内置搜索的数据源换成 Everything
export const FileSearchConfig = ConfigExtension("affine:page", {
  linkedWidget: {
    triggerKeys: ["@", "[[", "【【"],
    convertTriggerKey: true,
    ignoreBlockTypes: ["affine:code"],
    getMenus: async (
      query: string,
      abort: () => void,
      editorHost: any,
      inlineEditor: any
    ) => {
      const q = (query || "").trim();
      const groups: any[] = [];
      // omni 项目/计划(内联引用 @项目, 点了跳 vscode/看板)
      try {
        groups.push(...(await omniMenuGroups(query, abort, inlineEditor)));
      } catch {
        /* ignore */
      }
      // 文件(插入活文件块)—— 要有 query 才搜, 空 @ 只给 omni 列表
      if (q) {
        let hits: Array<{ name: string; path: string }> = [];
        try {
          hits = await search(q, 12);
        } catch {
          hits = [];
        }
        const doc = editorHost?.doc;
        if (hits.length)
          groups.push({
            name: "文件 · Everything",
            maxDisplay: 12,
            items: hits.map((h) => ({
              key: h.path,
              name: h.name,
              icon: FILE_ICON,
              action: () => {
                abort();
                void insertFileIntoNote(doc, h.path, h.name);
              },
            })),
          });
      }
      return groups;
    },
  },
});

// #5(真) —— 工具栏最右"模板"按钮弹出的 "Search file or anything"(EdgelessTemplatePanel)。把它的数据源
// 换成 poof 核心搜索(MFT/Everything), 结果按文件给「图标 + 文件名」(不再是抓不到封面的破书签卡)。选中即
// 用 insertFileIntoNote 直接插进当前笔记 —— 截下面板的 _insertTemplate, 文件结果绕开模板的 DocSnapshot
// 拖拽路径(文件块要带 blob/写回, snapshot 反而是障碍)。
function fileIconSvg(ext: string): string {
  const label = (ext || "?").slice(0, 4).toUpperCase();
  return `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M11 5h14l8 8v26a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="#2b2f3a" stroke="#586079" stroke-width="1.3"/>
    <path d="M25 5v8h8" fill="#1f232c" stroke="#586079" stroke-width="1.3"/>
    <text x="22" y="31" text-anchor="middle" font-size="7.5" fill="#aeb6c7" font-family="ui-monospace,monospace">${label}</text>
  </svg>`;
}
let fileTemplatesInstalled = false;
export function installFileTemplateSearch(): void {
  if (fileTemplatesInstalled) return;
  fileTemplatesInstalled = true;
  (EdgelessTemplatePanel as any).templates = {
    categories: () => [],
    list: () => [],
    search: async (keyword: string) => {
      const q = (keyword || "").trim();
      if (!q) return [];
      let hits: Array<{ name: string; path: string }> = [];
      try {
        hits = await search(q, 12);
      } catch {
        hits = [];
      }
      return hits.map((h) => {
        const ext = (h.name.split(".").pop() || "").toLowerCase();
        return { name: h.name, type: "poof-file", path: h.path, preview: fileIconSvg(ext) };
      });
    },
  };
  const Proto: any = (EdgelessTemplatePanel as any).prototype;
  if (!Proto.__poofFilePatched) {
    Proto.__poofFilePatched = true;
    const orig = Proto._insertTemplate;
    Proto._insertTemplate = async function (template: any, bound: any) {
      if (template && template.type === "poof-file" && template.path) {
        try {
          const doc = this.edgeless?.doc ?? this.edgeless?.std?.doc ?? this.edgeless?.service?.doc;
          await insertFileIntoNote(doc, template.path, template.name);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("poof file insert", e);
        }
        try {
          this.edgeless?.gfx?.tool?.setTool("default");
        } catch {
          /* ignore */
        }
        return;
      }
      return orig.call(this, template, bound);
    };
  }
}

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

// #2 "展开写作"从笔记块自身触发: 把按钮注入到"选中笔记时"才出现的原生元素工具条
// (edgeless-element-toolbar-widget → editor-toolbar, 含 edgeless-change-note-button=选中的是笔记)。
// 这样切到文档写作模式是从那个块交互的, 不是外挂浮钮。
export function mountNoteExpandButton(onExpand: () => void): () => void {
  const findToolbar = (): Element | null => {
    let tb: any = null;
    const walk = (r: any) =>
      r.querySelectorAll?.("*").forEach((e: any) => {
        if (e.tagName?.toLowerCase() === "edgeless-element-toolbar-widget") tb = e;
        if (e.shadowRoot) walk(e.shadowRoot);
      });
    walk(document);
    return tb?.shadowRoot?.querySelector("editor-toolbar") ?? null;
  };
  const ensure = () => {
    const tb = findToolbar();
    if (!tb) return;
    const isNote = !!tb.querySelector("edgeless-change-note-button");
    const existing = tb.querySelector(".poof-expand-btn");
    if (!isNote) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const btn = document.createElement("button");
    btn.className = "poof-expand-btn";
    btn.title = "展开写作（把这篇文档铺成全幅）";
    btn.innerHTML = "⤢ 展开写作";
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:3px;height:28px;padding:0 10px;margin-right:2px;background:transparent;border:none;color:#c3c6cf;cursor:pointer;font-size:13px;border-radius:6px;white-space:nowrap;";
    btn.addEventListener("mouseenter", () => (btn.style.background = "rgba(255,255,255,0.1)"));
    btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onExpand();
    });
    tb.insertBefore(btn, tb.firstChild);
  };
  ensure();
  const iv = window.setInterval(ensure, 700);
  return () => window.clearInterval(iv);
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
      let items = translateItems(w.config.items);
      // 追加"插入内容"(统一入口: 文件/计划/任务/审阅 → 同步源块), 打开浏览面板。幂等。
      if (!items.some((it: any) => it.name === "插入内容")) {
        items = [
          ...items,
          {
            name: "插入内容",
            description: "文件 / 计划 / 任务 / 审阅材料 → 同步源块",
            group: "9_Others@poof",
            icon: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/></svg>`,
            action: () => {
              try {
                window.dispatchEvent(new CustomEvent("poof:open-browse"));
              } catch {
                /* ignore */
              }
            },
          },
        ];
      }
      w.config = { ...w.config, items };
      return true;
    } catch {
      return false;
    }
  };
  const t = window.setInterval(() => {
    if (apply() || ++tries > 25) window.clearInterval(t);
  }, 200);
}
