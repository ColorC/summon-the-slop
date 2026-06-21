// Queued hand-off of "open a new chat" intents to the (now mount-on-demand) TerminalBar.
// A plain CustomEvent races the panel mounting; queuing + de-dup by id makes it reliable:
// intents pushed before the bar mounts wait in the queue and are drained on mount.
export interface ChatIntent {
  id: number;
  provider: string;
  query?: string;
  cwd?: string; // 工作目录(新对话进对应项目主文件夹, 见 #4)
  role?: "controller"; // 总控窗格: 创建后登记成持续总控对话
}
let seq = 0;
const pending: ChatIntent[] = [];
export const CHAT_EVENT = "poof-new-chat";

export function pushChatIntent(
  provider: string,
  query?: string,
  cwd?: string,
  role?: "controller"
) {
  pending.push({ id: ++seq, provider, query, cwd, role });
  window.dispatchEvent(new CustomEvent(CHAT_EVENT));
}
export function drainChatIntents(): ChatIntent[] {
  return pending.splice(0, pending.length);
}
