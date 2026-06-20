import { ProjectSurface, ReviewSurface, TalkSurface } from "../surfaces";

/** Omnicompany content surfaces (project / review / talk) as their own windows. */
export function SurfaceWindow({ view }: { view: string }) {
  const C = view === "review" ? ReviewSurface : view === "talk" ? TalkSurface : ProjectSurface;
  return (
    <div className="win win-surface">
      <C />
    </div>
  );
}
