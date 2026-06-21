// poof 自己在跑的 CLI 窗格登记表 —— 让总控路由器能把消息派给"poof 里在跑的对话"(case2)。
// poof 的窗格走独立的 pty.rs, 不在 omni 的 ~/.claude 扫描里, 所以由 TerminalBar 在这里登记,
// dispatch 在路由时把它们当候选带给 omni; 命中 send_poof_pane 时再 ptyWrite 直送。
export interface PoofPane {
  id: string; // pty id, 如 "term-3"
  provider: string; // claude / codex / ps
  label: string; // 这个窗格在鼓捣啥(首条输入 / 标题)
}

const panes = new Map<string, PoofPane>();

export function registerPane(p: PoofPane): void {
  panes.set(p.id, p);
}
export function setPaneLabel(id: string, label: string): void {
  const p = panes.get(id);
  if (p && label) p.label = label;
}
export function unregisterPane(id: string): void {
  panes.delete(id);
}
export function listPanes(): PoofPane[] {
  return [...panes.values()];
}

// 切到某个窗格的事件(dispatch 命中 send_poof_pane 时发, TerminalBar 监听切 tab)。
export const FOCUS_PANE_EVENT = "poof-focus-pane";
export function focusPane(id: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_PANE_EVENT, { detail: id }));
}
