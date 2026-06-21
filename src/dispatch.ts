// 总控派发客户端 — poof 的"新对话"先过 omni 的路由器(本机 sonnet 中思考), 再按 5 类执行。
//
// omni dispatch route 吃一条消息 + 本机在跑的对话清单, 归到:
//   new_strongest / new_with_project : 新起对话(带/不带项目) → 这里直接开 CLI tab
//   send_active_window               : 发给已活跃的外部窗口(vscode/codex 桌面) → 复制 + 提示切过去粘贴
//   send_poof_pane                   : 发给 poof 在跑窗格 → (窗格尚未注册进 omni, 暂回退新起)
//   ask_user                         : 不确定发给谁 → 复制 + 新起 + 提示候选
//
// UI 反馈用一个自管的 vanilla toast(贴 body), 不动 App/CSS, 把对共享文件的改动压到最小。
import { runShell, copyText, ptyWrite } from "./lib";
import { listPanes, focusPane } from "./poofPanes";

export type RouteKind =
  | "send_active_window"
  | "send_poof_pane"
  | "new_with_project"
  | "new_strongest"
  | "ask_user"
  | "error";

export interface RouteDecision {
  kind: RouteKind;
  target_key?: string;
  target_pane?: string;
  target_identity?: string;
  target_location?: string;
  target_provider?: string;
  project?: string;
  provider?: "claude" | "codex";
  text?: string;
  candidates?: string[];
  candidate_details?: CandidateDetail[];
  reason?: string;
  error?: string;
}

export interface CandidateDetail {
  key: string;
  identity?: string;
  location?: string;
  pane?: string;
  current_task?: string;
}

// 走 --input-b64 把 {message, poof_panes} 传给 omni —— base64 是纯 [A-Za-z0-9+/=], 在
// cmd 里不用引号、零转义问题(消息含引号/换行/中文都安全)。poof_panes 让路由器能判 send_poof_pane。
function b64utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export async function routeMessage(message: string): Promise<RouteDecision> {
  try {
    const payload = JSON.stringify({ message, poof_panes: listPanes() });
    const out = await runShell(`omni dispatch route --input-b64 ${b64utf8(payload)} --json`);
    const lines = (out.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    return JSON.parse(last) as RouteDecision;
  } catch (e) {
    return { kind: "error", error: String(e) };
  }
}

export interface DispatchDeps {
  newChat: (provider: string, query?: string) => void;
  openChat?: () => void; // 只打开"对话/终端"面板(不新建 tab) —— send_poof_pane 用
}

/** 路由一条消息并执行。返回后 toast 已把结果告诉用户。 */
export async function dispatchMessage(message: string, deps: DispatchDeps): Promise<RouteDecision> {
  toast("总控路由中…", true);
  const d = await routeMessage(message);
  const text = d.text || message;

  switch (d.kind) {
    case "new_with_project": {
      const prov = d.provider === "codex" ? "codex" : "claude";
      // 轻量"带项目上下文": 给首条消息加项目标注, 让新对话知道归属。
      // (完整版"受 omni 控制的会话 + cd 进项目载 CLAUDE.md"是更深的活, 见下一增量。)
      const seed = d.project ? `【项目上下文：${d.project}】\n${text}` : text;
      deps.newChat(prov, seed);
      toast(`新起 ${prov} 对话（${d.project || "?"}）· ${d.reason || ""}`);
      break;
    }
    case "new_strongest": {
      const prov = d.provider === "codex" ? "codex" : "claude";
      deps.newChat(prov, text);
      toast(`新起 ${prov} 对话 · ${d.reason || ""}`);
      break;
    }
    case "send_active_window": {
      await execActiveWindow(d.target_location, d.target_identity || d.target_key, text);
      break;
    }
    case "send_poof_pane": {
      const pane =
        d.target_pane ||
        (d.target_key && d.target_key.startsWith("poof:") ? d.target_key.slice(5) : "");
      if (pane) await execPoofPane(pane, d.target_identity || pane, text, deps.openChat);
      else {
        deps.newChat("claude", text);
        toast(`想发给 poof 窗格但没拿到窗格号，已回退新起。`);
      }
      break;
    }
    case "ask_user": {
      const cands = d.candidate_details || [];
      if (cands.length) showPicker(cands, text, deps);
      else {
        deps.newChat("claude", text);
        toast(`不确定该接到哪条已有对话，已新起处理。`);
      }
      break;
    }
    default: {
      deps.newChat("claude", text);
      toast(`路由失败，按普通新对话处理。${d.error ? "\n" + d.error.slice(0, 120) : ""}`);
    }
  }
  return d;
}

// ---- 执行端(switch 与 picker 共用) ----
async function execActiveWindow(loc: string | undefined, who: string | undefined, text: string): Promise<void> {
  await copyText(text).catch(() => {});
  let jumped = false;
  if (loc) {
    try {
      const out = await runShell(`omni dispatch activate --location "${loc}" --json`);
      const last = (out.stdout || "").trim().split("\n").pop() || "{}";
      jumped = JSON.parse(last)?.ok === true;
    } catch {
      /* activate best-effort; clipboard is the guarantee */
    }
  }
  toast(
    jumped
      ? `已把「${who}」所在窗口（${loc}）切到最前，消息已复制 —— 粘贴即可。`
      : `这条更像是发给「${who}」（${loc || "外部窗口"}）。已复制到剪贴板，切过去粘贴。`
  );
}

async function execPoofPane(pane: string, who: string, text: string, openChat?: () => void): Promise<void> {
  openChat?.();
  await ptyWrite(pane, text + "\r").catch(() => {});
  setTimeout(() => focusPane(pane), 180);
  toast(`已直接发给 poof 窗格「${who}」。`);
}

// ---- ask_user 选择器(vanilla overlay, 不动 React) ----
function showPicker(cands: CandidateDetail[], text: string, deps: DispatchDeps): void {
  const back = document.createElement("div");
  Object.assign(back.style, {
    position: "fixed", inset: "0", zIndex: "10000",
    background: "rgba(0,0,0,0.35)", display: "flex",
    alignItems: "center", justifyContent: "center",
  } as CSSStyleDeclaration);
  const box = document.createElement("div");
  Object.assign(box.style, {
    width: "520px", maxWidth: "92vw", maxHeight: "70vh", overflow: "auto",
    background: "rgba(22,23,29,0.99)", color: "#e7e7ea",
    border: "1px solid rgba(255,255,255,0.16)", borderRadius: "14px",
    padding: "16px 18px", boxShadow: "0 28px 80px rgba(0,0,0,0.6)",
    font: "13px/1.5 'Segoe UI', sans-serif",
  } as CSSStyleDeclaration);
  const title = document.createElement("div");
  title.textContent = "这条该接到哪个对话？";
  Object.assign(title.style, { fontWeight: "600", fontSize: "14px", marginBottom: "10px" } as CSSStyleDeclaration);
  box.appendChild(title);

  const close = () => back.remove();
  const row = (label: string, sub: string, onClick: () => void) => {
    const b = document.createElement("button");
    Object.assign(b.style, {
      display: "block", width: "100%", textAlign: "left", cursor: "pointer",
      background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)",
      color: "#e7e7ea", borderRadius: "9px", padding: "9px 12px", marginBottom: "7px",
      font: "13px/1.4 'Segoe UI', sans-serif",
    } as CSSStyleDeclaration);
    b.onmouseenter = () => (b.style.background = "rgba(99,102,241,0.28)");
    b.onmouseleave = () => (b.style.background = "rgba(255,255,255,0.05)");
    b.innerHTML = `<div style="font-weight:600">${label}</div>` +
      (sub ? `<div style="color:#9aa0ad;font-size:12px;margin-top:2px">${sub}</div>` : "");
    b.onclick = () => { close(); onClick(); };
    box.appendChild(b);
  };

  for (const c of cands) {
    const loc = c.location || "";
    row(c.identity || c.key, `${loc}${c.current_task ? " · " + c.current_task : ""}`, () => {
      if (loc.includes("poof") && c.pane) void execPoofPane(c.pane, c.identity || c.pane, text, deps.openChat);
      else void execActiveWindow(loc, c.identity || c.key, text);
    });
  }
  row("都不是 —— 新起一个对话", "用最强模型新建并发送", () => deps.newChat("claude", text));

  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  Object.assign(cancel.style, {
    marginTop: "4px", background: "transparent", border: "none", color: "#9aa0ad",
    cursor: "pointer", font: "12px 'Segoe UI', sans-serif",
  } as CSSStyleDeclaration);
  cancel.onclick = close;
  box.appendChild(cancel);

  back.onclick = (e) => { if (e.target === back) close(); };
  back.appendChild(box);
  document.body.appendChild(back);
}

// ---- 自管 toast ----
let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;
function toast(text: string, sticky = false): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    Object.assign(toastEl.style, {
      position: "fixed",
      left: "50%",
      top: "13vh",
      transform: "translateX(-50%)",
      zIndex: "9999",
      maxWidth: "560px",
      background: "rgba(20,21,28,0.98)",
      color: "#e7e7ea",
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "12px",
      padding: "12px 16px",
      font: "13px/1.5 'Segoe UI', sans-serif",
      boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  if (toastTimer) window.clearTimeout(toastTimer);
  if (!sticky) {
    toastTimer = window.setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
    }, 5200);
  }
}
