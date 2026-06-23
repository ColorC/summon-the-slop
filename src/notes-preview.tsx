// 离屏验证: 用和 NotesWorkspace 完全一样的配置真渲染一张 edgeless 笔记 + 一个 AI 块,
// 给 Playwright 截图, 肉眼确认: 方框米色? 画布半透明? 文字深色可读? AI 块是否渲染? 搜索/中文?
// 浏览器没有 Tauri, mock __TAURI_INTERNALS__ 让 invoke("search") 返回假文件, 好测内置搜索接管。
(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) =>
    cmd === "search"
      ? Promise.resolve([
          { kind: "file", name: "测试文件.txt", path: "D:/x/测试文件.txt", score: 9 },
          { kind: "file", name: "report.md", path: "E:/report.md", score: 8 },
        ])
      : Promise.resolve(null),
  transformCallback: (cb: any) => cb,
};
import "@toeverything/theme/style.css";
import "./App.css";
import { Text } from "@blocksuite/store";
import { EdgelessTemplatePanel } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { OverrideThemeExtension } from "@blocksuite/affine-shared/services";
import { signal } from "@preact/signals-core";
import { AiBlockSpec, insertAiBlock, mountAiToolbarButton } from "./blocks/aiblock";
import { getCollection } from "./regions/notesCollection";
import {
  FileSearchConfig,
  installChromeTranslator,
  localizeSlashMenu,
  mountNoteExpandButton,
  installFileTemplateSearch,
} from "./editorConfig";

const THEME = signal("dark" as any);
const DARK_THEME = OverrideThemeExtension({
  getAppTheme: () => THEME,
  getEdgelessTheme: () => THEME,
});

// 用和真机一样的 getCollection(effects + schema 都在里头注册, 单例), 这样 genBaseBookmarkSnap
// 复用同一个 collection, 不会重复 define custom element(那是离屏台之前的假阳性报错)。
const collection = getCollection();
const doc = collection.createDoc();
doc.load(() => {
  const root = doc.addBlock("affine:page", { title: new Text("预览笔记") });
  doc.addBlock("affine:surface", {}, root);
  const note = doc.addBlock("affine:note", { xywh: "[40,40,440,560]" }, root);
  doc.addBlock("affine:paragraph", { type: "h1", text: new Text("标题示例") }, note);
  doc.addBlock("affine:paragraph", { text: new Text("正文示例 — 这段字在米色纸上应是深色可读") }, note);
  doc.addBlock("affine:paragraph", {}, note);
});

const editor = new AffineEditorContainer();
editor.edgelessSpecs = [...editor.edgelessSpecs, DARK_THEME, ...AiBlockSpec, FileSearchConfig];
editor.pageSpecs = [...editor.pageSpecs, DARK_THEME, ...AiBlockSpec, FileSearchConfig];
editor.doc = doc;
const pageMode = location.search.includes("page");
editor.mode = (pageMode ? "page" : "edgeless") as any;
const app = document.getElementById("app")!;
app.className = "notes-ws " + (pageMode ? "page" : "edgeless") + " full";
const space = document.createElement("div");
space.className = "notespace";
space.appendChild(editor);
app.appendChild(space);

installChromeTranslator();
installFileTemplateSearch();
localizeSlashMenu(editor);
// #6 同真机: 把 AI 块按钮注入原生底部工具栏
mountAiToolbarButton(() => insertAiBlock(doc, ""));
// #2 展开写作注入笔记元素工具条
mountNoteExpandButton(() => {
  editor.mode = "page" as any;
  app.className = "notes-ws page full";
});

(window as any).__doc = doc;
(window as any).__editor = editor;
(window as any).__tmplSearch = (q: string) =>
  (EdgelessTemplatePanel as any).templates.search(q);
