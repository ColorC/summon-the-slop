// Types for the dependency-free JS interpreter (kept as .js so Node tests can import it directly).
export function sessionToTimeline(events: any[], meta?: { title?: string; start_ms?: number; stop_ms?: number | null } | undefined): string;
