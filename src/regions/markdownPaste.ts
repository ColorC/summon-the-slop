// markdown 粘贴保真: 默认智能转 markdown, 按住 Shift = 纯文本字面量。
//
// 根因(已读源码坐实): BlockSuite 的 text/plain 适配器(MixTextAdapter)本就把粘贴的纯文本走 markdown 解析
// (toSliceSnapshot → MarkdownAdapter)。但 text/html(优先级 90)抢在 text/plain(70)前 —— 从浏览器/飞书/
// Word/AI 对话复制时剪贴板带 html, 就轮不到 markdown, 于是 "1. 2." 原样进来不转。
//
// 修法: 把 text/plain 适配器换成本类、提到优先级 91(高于 html 90)。靠 capture 阶段的 paste 监听在
// BlockSuite 处理前拿到 "是否按 Shift / 剪贴板是否带 html", 据此决定:
//   · Shift            → 转义行首标记, 当字面量(复用同一条插入管线)
//   · 像 markdown      → 转(91 赢过 html 90)
//   · 不像 + 带 html   → 返回 null, 让 html 适配器接管(保住富文本粘贴)
//   · 不像 + 无 html   → 普通纯文本(每行一段, 同 MixText 默认)
import { MixTextAdapter } from "@blocksuite/blocks";

let poofShift = false;
let poofHasHtml = false;

const FW_DIGITS = "０１２３４５６７８９";

// 只修行首的 list/heading 标记的全角→半角(别动正文): １．/１、 → 1.  ；＃ → #  ；－/・/＊ → -
function normalizeLineMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let m = line.match(/^(\s*)([０-９0-9]+)[．.、)]\s+/);
      if (m) {
        const num = m[2].replace(/[０-９]/g, (d) => String(FW_DIGITS.indexOf(d)));
        return m[1] + num + ". " + line.slice(m[0].length);
      }
      m = line.match(/^(\s*)([＃#]{1,6})\s+/);
      if (m) return m[1] + m[2].replace(/＃/g, "#") + " " + line.slice(m[0].length);
      m = line.match(/^(\s*)[－\-＊*・]\s+/);
      if (m) return m[1] + "- " + line.slice(m[0].length);
      return line;
    })
    .join("\n");
}

export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  const markers: Record<string, RegExp> = {
    heading: /^#{1,6}\s/,
    ul: /^\s*[-*+]\s/,
    ol: /^\s*\d+[.)]\s/,
    quote: /^>\s/,
    fence: /^```/,
    table: /^\|.*\|/,
  };
  let hit = 0;
  const kinds = new Set<string>();
  for (const l of lines) {
    for (const k in markers) {
      if (markers[k].test(l)) {
        hit++;
        kinds.add(k);
        break;
      }
    }
  }
  const inline = /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(text);
  // 单行: 只认强标记(标题/代码围栏/表格/行内), 别把孤零零一句 "1. xxx" 误转
  if (lines.length === 1) {
    return kinds.has("heading") || kinds.has("fence") || kinds.has("table") || inline;
  }
  return kinds.size >= 2 || hit / lines.length >= 0.3 || (inline && hit >= 1);
}

// Shift 字面量: 反斜杠转义行首 markdown 标记, 让解析器当字面字符(CommonMark 中 # . - > 等都可转义)
function escapeMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)(#{1,6})(\s)/, "$1\\$2$3")
        .replace(/^(\s*)(\d+)([.)])(\s)/, "$1$2\\$3$4")
        .replace(/^(\s*)([-*+>])(\s)/, "$1\\$2$3")
    )
    .join("\n");
}

export class PoofMarkdownAdapter extends MixTextAdapter {
  override async toSliceSnapshot(payload: any): Promise<any> {
    const raw = payload?.file;
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    const text = raw.replace(/\r/g, "");
    if (poofShift) {
      return super.toSliceSnapshot({ ...payload, file: escapeMarkers(text) });
    }
    const norm = normalizeLineMarkers(text);
    if (looksLikeMarkdown(norm)) {
      return super.toSliceSnapshot({ ...payload, file: norm }); // 像 markdown → 转(赢过 html)
    }
    if (poofHasHtml) return null; // 不像 + 带 html → 让 html 适配器接管, 保住富文本
    return super.toSliceSnapshot({ ...payload, file: text }); // 不像 + 无 html → 普通纯文本
  }
}

/** 给编辑器装上 markdown 智能粘贴。返回 cleanup。 */
export function installMarkdownPaste(editor: any): () => void {
  // ⚠ ClipboardEvent 没有 shiftKey(它不是 KeyboardEvent/MouseEvent), 必须用 keydown/keyup 跟踪 Shift 状态。
  let shiftHeld = false;
  const onKey = (e: KeyboardEvent) => {
    shiftHeld = e.shiftKey;
  };
  // capture 阶段(BlockSuite 处理 paste 前)记下 Shift / 是否带 html
  const onPaste = (e: ClipboardEvent) => {
    poofShift = shiftHeld;
    poofHasHtml = !!e.clipboardData && Array.from(e.clipboardData.types).includes("text/html");
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);
  document.addEventListener("paste", onPaste, true);

  // 把 text/plain 适配器换成本类、提到 91(高于 html 90)。轻量定时重注入, 防编辑器重挂被还原。
  const ensure = () => {
    try {
      editor?.std?.clipboard?.registerAdapter?.("text/plain", PoofMarkdownAdapter, 91);
    } catch {
      /* ignore */
    }
  };
  ensure();
  const iv = window.setInterval(ensure, 2000);

  return () => {
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKey, true);
    window.clearInterval(iv);
    try {
      editor?.std?.clipboard?.registerAdapter?.("text/plain", MixTextAdapter, 70);
    } catch {
      /* ignore */
    }
  };
}
