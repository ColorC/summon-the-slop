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
  reason?: string;
  error?: string;
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
    case "new_strongest":
    case "new_with_project": {
      const prov = d.provider === "codex" ? "codex" : "claude";
      deps.newChat(prov, text);
      const proj = d.kind === "new_with_project" && d.project ? `（${d.project}）` : "";
      toast(`新起 ${prov} 对话${proj} · ${d.reason || ""}`);
      break;
    }
    case "send_active_window": {
      await copyText(text).catch(() => {});
      const loc = d.target_location || "";
      let jumped = false;
      if (loc) {
        try {
          const out = await runShell(`omni dispatch activate --location "${loc}" --json`);
          const last = (out.stdout || "").trim().split("\n").pop() || "";
          jumped = JSON.parse(last)?.ok === true;
        } catch {
          /* activate best-effort; clipboard is the guarantee */
        }
      }
      const who = d.target_identity || d.target_key;
      toast(
        jumped
          ? `已把「${who}」所在窗口（${loc}）切到最前，消息已复制 —— 粘贴即可。`
          : `这条更像是发给「${who}」（${loc || "外部窗口"}）。已复制到剪贴板，切过去粘贴。`
      );
      break;
    }
    case "send_poof_pane": {
      const pane =
        d.target_pane ||
        (d.target_key && d.target_key.startsWith("poof:") ? d.target_key.slice(5) : "");
      if (pane) {
        deps.openChat?.(); // 确保对话面板开着, TerminalBar 挂载
        await ptyWrite(pane, text + "\r").catch(() => {});
        setTimeout(() => focusPane(pane), 180); // 切到那个窗格 tab
        toast(`已直接发给 poof 窗格「${d.target_identity || pane}」。`);
      } else {
        deps.newChat("claude", text);
        toast(`想发给 poof 窗格但没拿到窗格号，已回退新起。`);
      }
      break;
    }
    case "ask_user": {
      await copyText(text).catch(() => {});
      deps.newChat("claude", text);
      const n = (d.candidates || []).length;
      toast(`不确定该接到哪条已有对话（候选 ${n} 个）。已新起并把内容复制到剪贴板。`);
      break;
    }
    default: {
      deps.newChat("claude", text);
      toast(`路由失败，按普通新对话处理。${d.error ? "\n" + d.error.slice(0, 120) : ""}`);
    }
  }
  return d;
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
