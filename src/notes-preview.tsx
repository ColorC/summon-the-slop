// 离屏验证: 用和 NotesWorkspace 完全一样的配置真渲染一张 edgeless 笔记 + 一个 AI 块,
// 给 Playwright 截图, 肉眼确认: 方框米色? 画布半透明? 文字深色可读? AI 块是否渲染? 搜索/中文?
// 浏览器没有 Tauri, mock __TAURI_INTERNALS__ 让 invoke("search") 返回假文件, 好测内置搜索接管。
const __writes: Record<string, string> = {};
(window as any).__writes = __writes; // 验证写回: 改了文本块后这里应出现源路径→新内容
const FAKE_FILES: Record<string, string> = {
  "E:/report.md": "# 报告标题\n\n这是一段 markdown 正文。\n\n- 项目一\n- 项目二\n",
  "D:/x/测试文件.txt": "纯文本内容\n第二行\n",
  "E:/data.csv": "name,age\nAlice,30\nBob,25\n",
  "E:/config.yaml": "key: value\nlist:\n  - a\n  - b\n",
};
const PNG1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// 落盘存储的内存替身: 把 notes_doc_*/notes_blob_* 后端做成 JS Map, 可被 window 注入预置数据,
// 用来在离屏台验证 FileDocSource/FileBlobSource 的 pull/push 往返(模拟"重启后仍在")。
const DOC_STORE: Record<string, string> = ((window as any).__docStore ??= {});
const BLOB_STORE: Record<string, string> = ((window as any).__blobStore ??= {});
(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    ((window as any).__invokeLog ??= []).push({ cmd, args });
    if (cmd === "run_shell") {
      const c = (args?.cmd as string) || "";
      if (c.includes("omni project list"))
        return Promise.resolve({ stdout: JSON.stringify({ projects: [
          { id: "omnidashboard", name: "Omni Dashboard 驾驶舱", group: "omnicompany", roots: ["E:/WindowsWorkspace/omnicompany"] },
          { id: "poof", name: "Poof 悬浮层", roots: ["E:/WindowsWorkspace/poof"] },
        ] }), stderr: "", code: 0 });
      if (c.includes("omni plan list"))
        return Promise.resolve({ stdout: JSON.stringify([{ plan_id: "p1", title: "存储落地计划" }]), stderr: "", code: 0 });
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
    if (cmd === "search")
      return Promise.resolve([
        { kind: "file", name: "report.md", path: "E:/report.md", score: 9 },
        { kind: "file", name: "data.csv", path: "E:/data.csv", score: 8 },
        { kind: "file", name: "shot.png", path: "E:/shot.png", score: 7 },
      ]);
    if (cmd === "read_file_text")
      return Promise.resolve(FAKE_FILES[args?.path] ?? "（空文件）");
    if (cmd === "write_file_text") {
      __writes[args.path] = args.content;
      return Promise.resolve(null);
    }
    if (cmd === "read_file_b64") return Promise.resolve(PNG1);
    // 落盘存储替身
    if (cmd === "notes_root") return Promise.resolve("E:/WindowsWorkspace/poof-notes");
    if (cmd === "notes_doc_get") return Promise.resolve(DOC_STORE[args.id] ?? null);
    if (cmd === "notes_doc_put") {
      DOC_STORE[args.id] = args.b64;
      return Promise.resolve(null);
    }
    if (cmd === "notes_doc_keys") return Promise.resolve(Object.keys(DOC_STORE));
    if (cmd === "notes_doc_del") {
      delete DOC_STORE[args.id];
      return Promise.resolve(null);
    }
    if (cmd === "notes_blob_get") return Promise.resolve(BLOB_STORE[args.key] ?? null);
    if (cmd === "notes_blob_put") {
      BLOB_STORE[args.key] = args.b64;
      return Promise.resolve(null);
    }
    if (cmd === "notes_blob_keys") return Promise.resolve(Object.keys(BLOB_STORE));
    if (cmd === "notes_blob_del") {
      delete BLOB_STORE[args.key];
      return Promise.resolve(null);
    }
    if (cmd === "notes_md_put") {
      ((window as any).__mdStore ??= {})[args.id] = args.content;
      return Promise.resolve(null);
    }
    if (cmd === "notes_md_del") {
      delete ((window as any).__mdStore ??= {})[args.id];
      return Promise.resolve(null);
    }
    if (cmd === "notes_index_put") {
      (window as any).__index = args.json;
      return Promise.resolve(null);
    }
    // 版本历史落盘替身: { "<docId>/<ts>": json }
    if (cmd === "notes_version_put") {
      ((window as any).__verStore ??= {})[`${args.docId}/${args.ts}`] = args.json;
      return Promise.resolve(null);
    }
    if (cmd === "notes_version_all") {
      const vs: any = (window as any).__verStore ??= {};
      const out = Object.keys(vs)
        .filter((k) => k.startsWith(args.docId + "/"))
        .map((k) => ({ ts: k.split("/")[1], json: vs[k] }));
      return Promise.resolve(out);
    }
    if (cmd === "notes_version_del_one") {
      delete ((window as any).__verStore ??= {})[`${args.docId}/${args.ts}`];
      return Promise.resolve(null);
    }
    if (cmd === "notes_version_del_all") {
      const vs: any = ((window as any).__verStore ??= {});
      for (const k of Object.keys(vs)) if (k.startsWith(args.docId + "/")) delete vs[k];
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  },
  transformCallback: (cb: any) => cb,
};
import "@toeverything/theme/style.css";
import "./App.css";
import { Text, Job } from "@blocksuite/store";
import { EdgelessTemplatePanel } from "@blocksuite/blocks";
import { AffineEditorContainer } from "@blocksuite/presets";
import { OverrideThemeExtension } from "@blocksuite/affine-shared/services";
import { signal } from "@preact/signals-core";
import { AiBlockSpec, insertAiBlock, mountAiToolbarButton } from "./blocks/aiblock";
import { getCollection } from "./regions/notesCollection";
import { insertFileIntoNote, installFileWriteback, installMdPreviewToggle } from "./regions/fileInsert";
import { FileDocSource, FileBlobSource } from "./regions/fileNotesStore";
import { exportNoteToMd, rebuildNotesIndex, backfillExports } from "./regions/noteExport";
import { saveVersion, listVersions, deleteVersionsFor } from "./regions/noteVersions";
import { PoofMarkdownAdapter, looksLikeMarkdown, installMarkdownPaste } from "./regions/markdownPaste";
import { omniMenuGroups, jumpOmni, omniProjects } from "./regions/omniLink";
(window as any).__omniTest = { omniMenuGroups, jumpOmni, omniProjects };
import * as Y from "yjs";
(window as any).__storeTest = {
  FileDocSource, FileBlobSource, Y, Job, exportNoteToMd, rebuildNotesIndex, backfillExports,
  saveVersion, listVersions, deleteVersionsFor, PoofMarkdownAdapter, looksLikeMarkdown,
};
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
installFileWriteback(doc); // 活文件块写回
installMdPreviewToggle(doc); // md 源码 ⇄ 渲染预览
installMarkdownPaste(editor); // markdown 智能粘贴
localizeSlashMenu(editor);
// 验证用: 直接把文件插进笔记(等价于搜索结果/拖入)
(window as any).__insertFile = (path: string, name?: string) => insertFileIntoNote(doc, path, name);
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
