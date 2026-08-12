export interface NoteSession {
  id: string;
  label: string;
}

export const NOTE_SESSION_EVENT = "poof-note-session";

const FALLBACK_KEY = "poof-note-ui-session";

function fallbackSession(): NoteSession {
  let id = sessionStorage.getItem(FALLBACK_KEY) || "";
  if (!id) {
    const uuid = globalThis.crypto?.randomUUID?.();
    id = uuid
      ? `workspace:${uuid}`
      : `workspace:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(FALLBACK_KEY, id);
  }
  return { id, label: "当前会话" };
}

let activeSession: NoteSession = fallbackSession();

export function getActiveNoteSession(): NoteSession {
  return activeSession;
}

export function setActiveNoteSession(session: NoteSession | null): void {
  activeSession = session?.id ? session : fallbackSession();
  window.dispatchEvent(new CustomEvent<NoteSession>(NOTE_SESSION_EVENT, { detail: activeSession }));
}

export function subscribeNoteSession(listener: (session: NoteSession) => void): () => void {
  const onSession = (event: Event) => listener((event as CustomEvent<NoteSession>).detail);
  window.addEventListener(NOTE_SESSION_EVENT, onSession);
  return () => window.removeEventListener(NOTE_SESSION_EVENT, onSession);
}

export function sessionFromLocation(): NoteSession | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("session_id") || params.get("session") || params.get("sid");
  if (!id) return null;
  return { id: `external:${id}`, label: params.get("session_title") || "会话札记" };
}
