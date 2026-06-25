// 把一个本机文件插进当前笔记 —— 不再用错的「书签卡」, 而是按类型用对的原生块:
//  · 文本类(md/json/yaml/csv/代码/html…) → affine:code 可编辑块, 并「绑定源文件路径」:
//    在笔记里改了 → 防抖写回磁盘(用户要的"文档里改了保存, 源文件也变")。源文件是真源, 单向 note→disk。
//  · 图片 → affine:image(读字节进 blob 仓, 内嵌预览, 只读)
//  · PDF  → affine:attachment embed(pdf.js 内嵌预览, 只读)
//  · 其它二进制(docx/xlsx/zip…) → affine:attachment 文件卡(图标+名+大小+下载, 只读)
import { Text } from "@blocksuite/store";
import { micromark } from "micromark";
import { readFileText, writeFileText, readFileB64 } from "../lib";
import { getCollection } from "./notesCollection";
import { insertBoundSource } from "./boundSource";

// ---- 扩展名 → 类别 / 高亮语言 / mime ----
const CODE_LANG: Record<string, string> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  json: "json", json5: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", conf: "ini", env: "ini", properties: "ini",
  csv: "csv", tsv: "csv",
  html: "html", htm: "html", xml: "xml", vue: "html", svelte: "html",
  css: "css", scss: "scss", less: "less",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", py: "python", rb: "ruby", php: "php",
  rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "bat", cmd: "bat",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  dockerfile: "docker", makefile: "makefile", txt: "text", text: "text", log: "text", gitignore: "text",
};
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  svg: "image/svg+xml",
};
const BIN_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  zip: "application/zip", rar: "application/x-rar", "7z": "application/x-7z-compressed",
};

function extOf(pathOrName: string): string {
  const base = pathOrName.replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
}
type Kind = "text" | "image" | "pdf" | "binary";
function kindOf(ext: string): Kind {
  if (ext in IMAGE_MIME) return "image";
  if (ext === "pdf") return "pdf";
  if (ext in CODE_LANG) return "text";
  return "binary";
}

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

function noteIdOf(doc: any): string | null {
  const note = doc?.getBlocksByFlavour?.("affine:note")?.[0];
  return note?.model?.id ?? note?.id ?? doc?.root?.id ?? null;
}

/**
 * 把文件插进当前笔记。返回插入块 id(失败 null)。
 *  · markdown → 同步源块(绑定子文档 + embed-synced-doc, 原生块渲染, 双向写回, 带历史) —— 见 boundSource。
 *  · 其它文本(json/yaml/代码/配置…) → affine:code 块 + 写回绑定(字节保真, 单向 note→disk)。
 *  · 图片/PDF/二进制 → image/attachment(只读)。
 * 传 opts.raw=true 强制 md 也走代码块(字节保真逃生口)。
 */
export async function insertFileIntoNote(
  doc: any,
  path: string,
  name?: string,
  opts?: { raw?: boolean }
): Promise<string | null> {
  const fileName = name || (path.replace(/\\/g, "/").split("/").pop() ?? path);
  const ext = extOf(fileName) || extOf(path);
  const noteId = noteIdOf(doc);
  if (!noteId) return null;
  const kind = kindOf(ext);
  try {
    if (kind === "text") {
      // markdown → 同步源块(原生块 + 双向同步 + 历史), 除非显式要原文/代码块
      if (!opts?.raw && /\.(md|markdown|mdx)$/i.test(path)) {
        const embedId = await insertBoundSource(doc, "md-file", path);
        if (embedId) return embedId;
        // 引擎失败兜底走代码块
      }
      const content = await readFileText(path);
      const id = doc.addBlock(
        "affine:code",
        { language: CODE_LANG[ext] || "text", text: new Text(content) },
        noteId
      );
      bindFileBlock(doc, id, path);
      return id;
    }
    if (kind === "image") {
      const blob = b64ToBlob(await readFileB64(path), IMAGE_MIME[ext] || "image/png");
      const sourceId = await getCollection().blobSync.set(blob as any);
      return doc.addBlock("affine:image", { sourceId }, noteId);
    }
    // pdf + 其它二进制都走 attachment;只有 pdf 开 embed(内嵌预览)
    const type = kind === "pdf" ? "application/pdf" : BIN_MIME[ext] || "application/octet-stream";
    const blob = b64ToBlob(await readFileB64(path), type);
    const sourceId = await getCollection().blobSync.set(blob as any);
    return doc.addBlock(
      "affine:attachment",
      { name: fileName, size: blob.size, type, sourceId, embed: kind === "pdf" },
      noteId
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("insertFileIntoNote", path, e);
    return null;
  }
}

// ---------- 写回绑定: blockId ⇄ 源文件路径 ----------
// 持久化在 localStorage(按 doc 分桶), 重开笔记仍知道哪些块是「活文件」。
function bindKey(docId: string): string {
  return "poof-filebind-" + docId;
}
function readBindings(docId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(bindKey(docId)) || "{}");
  } catch {
    return {};
  }
}
function writeBindings(docId: string, m: Record<string, string>): void {
  localStorage.setItem(bindKey(docId), JSON.stringify(m));
}
export function bindingPathOf(docId: string, blockId: string): string | null {
  return readBindings(docId)[blockId] || null;
}

// 当前已装写回的 doc + 每块的 yText 观察者卸载函数
let currentDocId: string | null = null;
const watchers = new Map<string, () => void>();
const writeTimers = new Map<string, number>();
const dirtyBlocks = new Set<string>();

function modelOf(doc: any, blockId: string): any {
  const b = doc.getBlock?.(blockId) ?? doc.getBlockById?.(blockId);
  return b?.model ?? b ?? null;
}

async function flushBlock(doc: any, blockId: string, path: string): Promise<void> {
  const model = modelOf(doc, blockId);
  const text = model?.text?.toString?.();
  if (typeof text !== "string") return;
  try {
    await writeFileText(path, text);
    dirtyBlocks.delete(blockId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("写回源文件失败", path, e);
  }
}

function scheduleWrite(doc: any, blockId: string, path: string): void {
  dirtyBlocks.add(blockId);
  const prev = writeTimers.get(blockId);
  if (prev) clearTimeout(prev);
  const t = window.setTimeout(() => {
    writeTimers.delete(blockId);
    void flushBlock(doc, blockId, path);
  }, 700);
  writeTimers.set(blockId, t);
}

function attachWatcher(doc: any, blockId: string, path: string): void {
  if (watchers.has(blockId)) return;
  const model = modelOf(doc, blockId);
  const yText = model?.text?.yText;
  if (!yText?.observe) return; // 块还没物化, install 的重试会再来
  const cb = () => scheduleWrite(doc, blockId, path);
  yText.observe(cb);
  watchers.set(blockId, () => {
    try {
      yText.unobserve(cb);
    } catch {
      /* ignore */
    }
  });
}

// ---------- md 文件块: 「源码编辑 ⇄ 渲染预览」切换 ----------
// md 活文件块本体是 affine:code(源码, 可编辑, 写回)。给它角上加个「👁 渲染」钮:
// 切到只读渲染(micromark, 复用 BlockSuite 自带的 md 解析器, 无新依赖), 双击渲染层回到源码编辑。
function isMdPath(p: string | null): boolean {
  return !!p && /\.(md|markdown|mdx)$/i.test(p);
}
function togglePreview(code: HTMLElement, doc: any, blockId: string): void {
  const existing = code.querySelector(":scope > .poof-md-rendered");
  if (existing) {
    existing.remove();
    code.classList.remove("poof-previewing");
    return;
  }
  const model = (doc.getBlock?.(blockId) ?? doc.getBlockById?.(blockId))?.model;
  const md = model?.text?.toString?.() ?? "";
  const div = document.createElement("div");
  div.className = "poof-md-rendered";
  div.title = "渲染预览(只读)· 双击回到源码编辑";
  try {
    div.innerHTML = micromark(md);
  } catch {
    div.textContent = md;
  }
  div.addEventListener("dblclick", () => {
    div.remove();
    code.classList.remove("poof-previewing");
  });
  code.appendChild(div);
  code.classList.add("poof-previewing");
}

let mdToggleIv = 0;
/** 给当前笔记里所有「md 活文件块」加渲染预览切换钮。返回 cleanup。 */
export function installMdPreviewToggle(doc: any): () => void {
  const ensure = () => {
    const codes = document.querySelectorAll<HTMLElement>(".notes-ws affine-code[data-block-id]");
    codes.forEach((code) => {
      const id = code.getAttribute("data-block-id");
      const path = id ? bindingPathOf(doc.id, id) : null;
      if (!isMdPath(path)) {
        code.querySelector(":scope > .poof-md-toggle")?.remove();
        return;
      }
      if (code.querySelector(":scope > .poof-md-toggle")) return;
      code.style.position = "relative";
      const btn = document.createElement("button");
      btn.className = "poof-md-toggle";
      btn.textContent = "👁 渲染";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePreview(code, doc, id!);
      });
      code.appendChild(btn);
    });
  };
  ensure();
  mdToggleIv = window.setInterval(ensure, 800);
  return () => {
    window.clearInterval(mdToggleIv);
    document
      .querySelectorAll(".poof-md-toggle, .poof-md-rendered")
      .forEach((e) => e.remove());
  };
}

/** 插入文本块后登记绑定 + 立刻挂上写回观察者。 */
export function bindFileBlock(doc: any, blockId: string, path: string): void {
  const docId = doc.id;
  const m = readBindings(docId);
  m[blockId] = path;
  writeBindings(docId, m);
  if (currentDocId === docId) attachWatcher(doc, blockId, path);
}

/**
 * 笔记挂载后调用: 给这个 doc 里所有「活文件」文本块挂写回观察者。
 * 返回 cleanup(切笔记/关笔记时调): 卸载观察者 + 落盘未保存的改动。
 */
export function installFileWriteback(doc: any): () => void {
  const docId = doc.id;
  currentDocId = docId;
  const bindings = readBindings(docId);
  // 块可能在挂载后才物化, 重试几轮把观察者都挂上
  let tries = 0;
  const iv = window.setInterval(() => {
    const cur = readBindings(docId);
    for (const [bid, p] of Object.entries(cur)) attachWatcher(doc, bid, p);
    if (++tries > 12) clearInterval(iv);
  }, 300);
  for (const [bid, p] of Object.entries(bindings)) attachWatcher(doc, bid, p);

  return () => {
    clearInterval(iv);
    for (const off of watchers.values()) off();
    watchers.clear();
    // 落盘所有还没写回的(关笔记前最后一次)
    const cur = readBindings(docId);
    for (const bid of dirtyBlocks) {
      const p = cur[bid];
      if (p) void flushBlock(doc, bid, p);
    }
    dirtyBlocks.clear();
    for (const t of writeTimers.values()) clearTimeout(t);
    writeTimers.clear();
    if (currentDocId === docId) currentDocId = null;
  };
}
