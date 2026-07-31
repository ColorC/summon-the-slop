// 总控 = 一个持续可见的 CLI 对话(默认 codex), 不是后台 call_json。用户从输入框发消息,
// poof 把消息送进总控的 CLI 窗格(看得见), 总控(带 controller/AGENTS.md 上下文 + omni 工具)
// 自己判断怎么处理。连续对话: 只有用户清理才重来。
import { ptyWrite, copyText } from "./lib";
import { pushChatIntent } from "./chatIntents";
import { focusPane } from "./poofPanes";
import { userConfig, KEY_CONTROLLER_HOME } from "./userConfig";

export type ControllerKind = "codex" | "claude" | "omni-web";

const KIND_KEY = "poof-controller-kind";
export function getControllerKind(): ControllerKind {
  const v = localStorage.getItem(KIND_KEY);
  return v === "claude" || v === "omni-web" ? v : "codex"; // 默认 codex CLI
}
export function setControllerKind(k: ControllerKind): void {
  localStorage.setItem(KIND_KEY, k);
}

// 总控 codex 的家: 带 AGENTS.md(总控角色+omni工具)的目录。可配:
//   localStorage.setItem("overlay-controller-home", "D:\\your\\controller")
// 缺省空串 → 终端退回 home(pty.rs 兜底)。
export const CONTROLLER_HOME = userConfig(KEY_CONTROLLER_HOME, "");
// 总控 web 界面: 已迁到收编 chatui(:7348)的 controller provider(原 omnidashboard ChatStandalone 已删)。
// ?provider=controller 让 chatui 预选总控 provider(本地 opus + 总控系统提示)。
export const OMNI_WEB_URL = "http://127.0.0.1:7348/?provider=controller";

let controllerPaneId: string | null = null;
export function getControllerPane(): string | null {
  return controllerPaneId;
}
export function setControllerPane(id: string | null): void {
  controllerPaneId = id;
}

export interface ControllerDeps {
  openChat: () => void; // 打开对话面板(挂载 TerminalBar)
  openOmniWeb: () => void; // 打开 omnidashboard 总控 web 面板
}

/** 把一条消息发给总控(可见、持续)。 */
export function sendToController(message: string, deps: ControllerDeps): void {
  const kind = getControllerKind();
  if (kind === "omni-web") {
    deps.openOmniWeb();
    void copyText(message).catch(() => {}); // web 输入框自己粘(v1)
    return;
  }
  deps.openChat();
  if (controllerPaneId) {
    // 已有总控窗格 → 直接送进去(连续对话)
    void ptyWrite(controllerPaneId, message + "\r").catch(() => {});
    focusPane(controllerPaneId);
  } else {
    // 还没有 → 在总控家起一个 codex/claude(skip-perms), 首条消息当 initialInput
    pushChatIntent(kind, message, CONTROLLER_HOME, "controller");
  }
}
