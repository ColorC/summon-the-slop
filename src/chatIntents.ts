// Queued hand-off of "open a new chat" intents to the (now mount-on-demand) TerminalBar.
// A plain CustomEvent races the panel mounting; queuing + de-dup by id makes it reliable:
// intents pushed before the bar mounts wait in the queue and are drained on mount.
export interface ChatIntent {
  id: number;
  provider: string;
  query?: string;
}
let seq = 0;
const pending: ChatIntent[] = [];
export const CHAT_EVENT = "poof-new-chat";

export function pushChatIntent(provider: string, query?: string) {
  pending.push({ id: ++seq, provider, query });
  window.dispatchEvent(new CustomEvent(CHAT_EVENT));
}
export function drainChatIntents(): ChatIntent[] {
  return pending.splice(0, pending.length);
}
