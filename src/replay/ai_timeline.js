// poof 录像 P5 — session -> AI-readable timeline.
// A recording's JSONL is not AI-readable on its own: rrweb events are raw DOM mutations keyed by
// integer node ids. This interpreter resolves those ids against the FullSnapshot tree so every
// click/input/nav becomes a semantic line ("点击 按钮 '提交'", "在 输入框 '邮箱' 输入: ***").
// vscode.*/native.* events are already semantic and are formatted directly. Redaction is
// preserved end-to-end: rrweb Input values arrive pre-masked, so we never see raw secrets here.
// Dependency-free ESM so it runs both in the replay window and under Node (for tests).

// ---- rrweb constants ----
const EV = { META: 4, FULL: 2, INCR: 3 };
const SRC = { MUTATION: 0, MOUSE_MOVE: 1, MOUSE_INTERACTION: 2, SCROLL: 3, INPUT: 5 };
const CLICK_TYPES = new Set([2 /*Click*/, 4 /*DblClick*/, 9 /*ContextMenu*/]);

function trunc(s, n = 80) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Walk an rrweb snapshot node tree into id -> node, so later events can resolve their target id.
function indexNode(node, map) {
  if (!node || typeof node.id !== "number") return;
  map.set(node.id, node);
  if (node.childNodes) for (const c of node.childNodes) indexNode(c, map);
}

function firstText(node) {
  if (!node) return "";
  if (node.type === 3 && node.textContent) { const t = node.textContent.trim(); if (t) return t; }
  if (node.childNodes) for (const c of node.childNodes) { const t = firstText(c); if (t) return t; }
  return "";
}

// Human/AI label for a node id: prefer accessible name (aria-label/placeholder/alt/title/name/value),
// else the element's own text, else just the tag.
function label(map, id) {
  const n = map.get(id);
  if (!n) return `#${id}`;
  if (n.type === 3) return `“${trunc(n.textContent, 40)}”`;
  const a = n.attributes || {};
  const tag = (n.tagName || "").toLowerCase();
  const kindMap = { input: a.type === "password" ? "密码框" : "输入框", textarea: "输入框", button: "按钮", a: "链接", select: "下拉框", img: "图片" };
  const kind = kindMap[tag] || `<${tag || "节点"}>`;
  const name = a["aria-label"] || a.placeholder || a.alt || a.title || a.name || (tag !== "input" && tag !== "textarea" ? firstText(n) : "") || a.value || "";
  return name ? `${kind} '${trunc(name, 40)}'` : kind;
}

// Visible text of a snapshot (skips script/style) — gives the AI page context at load.
function snapshotText(node, parentTag, out) {
  if (!node) return;
  const tag = (node.tagName || parentTag || "").toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript") return;
  if (node.type === 3 && node.textContent) { const t = node.textContent.trim(); if (t) out.push(t); }
  if (node.childNodes) for (const c of node.childNodes) snapshotText(c, tag, out);
}

function fmtTs(ts, start) {
  const s = Math.max(0, (ts - start) / 1000);
  return `+${s.toFixed(1)}s`;
}

// events: array of envelopes {sid,seq,ts,surface,src,kind,p}. meta: optional {title,start_ms,...}.
export function sessionToTimeline(events, meta) {
  events = (events || []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const start = (meta && meta.start_ms) || (events[0] && events[0].ts) || 0;
  const surfaces = [...new Set(events.map((e) => e.surface).filter(Boolean))];
  const lines = [];
  const head = [];
  head.push(`# 录像时间线: ${(meta && meta.title) || "(无标题)"}`);
  head.push(`surface: ${surfaces.join(", ") || "?"} · 事件 ${events.length} 条`);
  if (meta && meta.start_ms && meta.stop_ms) head.push(`时长 ${((meta.stop_ms - meta.start_ms) / 1000).toFixed(1)}s`);
  head.push("");

  const map = new Map(); // rrweb id -> node (carried across snapshot + mutations)
  let lastScrollTs = 0;
  let lastMoveTs = 0;

  for (const e of events) {
    const t = fmtTs(e.ts, start);
    if (e.kind === "rrweb") {
      const ev = e.p && e.p.ev;
      if (!ev) continue;
      if (ev.type === EV.META) {
        lines.push(`- [${t}] 打开页面: ${ev.data && ev.data.href ? ev.data.href : "(unknown)"}`);
      } else if (ev.type === EV.FULL) {
        map.clear();
        indexNode(ev.data && ev.data.node, map);
        const txt = [];
        snapshotText(ev.data && ev.data.node, "", txt);
        lines.push(`- [${t}] 页面载入完成 · 可见文本: ${trunc(txt.join(" · "), 200)}`);
      } else if (ev.type === EV.INCR) {
        const d = ev.data || {};
        if (d.source === SRC.MUTATION) {
          // index newly added nodes so later clicks on them resolve
          let newText = [];
          for (const add of d.adds || []) { indexNode(add.node, map); const tx = firstText(add.node); if (tx) newText.push(tx); }
          for (const tc of d.texts || []) { const n = map.get(tc.id); if (n) n.textContent = tc.value; if (tc.value && tc.value.trim()) newText.push(tc.value.trim()); }
          if (newText.length) lines.push(`- [${t}] 页面变化 · 新文本: ${trunc(newText.join(" · "), 120)}`);
        } else if (d.source === SRC.MOUSE_INTERACTION && CLICK_TYPES.has(d.type)) {
          lines.push(`- [${t}] 点击 ${label(map, d.id)}`);
        } else if (d.source === SRC.INPUT) {
          lines.push(`- [${t}] 在 ${label(map, d.id)} 输入: ${d.text === "" ? "(清空)" : trunc(d.text, 60)}`);
        } else if (d.source === SRC.SCROLL) {
          if (e.ts - lastScrollTs > 1500) { lines.push(`- [${t}] 滚动页面`); lastScrollTs = e.ts; }
        } else if (d.source === SRC.MOUSE_MOVE) {
          if (e.ts - lastMoveTs > 4000) { lines.push(`- [${t}] 鼠标移动`); lastMoveTs = e.ts; }
        }
      }
    } else if (e.kind && e.kind.startsWith("vscode.")) {
      const p = e.p || {};
      const base = (p.path || "").split(/[\\/]/).pop() || p.path || "";
      const M = {
        "vscode.active": () => `切换到文件 ${base}`,
        "vscode.open": () => `打开文件 ${base}${p.lang ? ` (${p.lang})` : ""}`,
        "vscode.save": () => `保存 ${base}`,
        "vscode.edit": () => `编辑 ${base} (改动${p.edits}次, +${p.addedLines}/-${p.removedLines}行)`,
        "vscode.terminal.open": () => `打开终端 ${p.name || ""}`,
        "vscode.debug.start": () => `启动调试 ${p.name || ""}${p.type ? ` (${p.type})` : ""}`,
      };
      lines.push(`- [${t}] ${(M[e.kind] || (() => e.kind))()}`);
    } else if (e.kind && e.kind.startsWith("native.")) {
      const p = e.p || {};
      if (e.kind === "native.focus") lines.push(`- [${t}] 切换到窗口 「${trunc(p.title || "?", 60)}」${p.process ? ` (${p.process})` : ""}`);
      else if (e.kind === "native.activity") lines.push(`- [${t}] ${p.active ? "用户活跃" : `空闲 (${Math.round((p.idleMs || 0) / 1000)}s 无操作)`}`);
      else lines.push(`- [${t}] ${e.kind}`);
    } else if (e.kind === "keyframe") {
      // 区域录制 keyframe: the OCR'd text IS the AI-readable "what was on screen" (image lives at p.frame)
      const p = e.p || {};
      const txt = trunc((p.text || "").replace(/\s+/g, " "), 220);
      lines.push(`- [${t}] 画面 ${p.w || "?"}×${p.h || "?"} · 文字: ${txt || "(无文字)"}`);
    }
  }

  if (!lines.length) lines.push("- (无可读事件)");
  return head.join("\n") + lines.join("\n") + "\n";
}
