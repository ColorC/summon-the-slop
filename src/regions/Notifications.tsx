import { useEffect, useState } from "react";
import { runShell } from "../lib";

/** Right region — "最近通知" (TBD). Until the notification model is decided, it
 *  surfaces recent omni project activity as a stand-in feed. */
export function Notifications() {
  const [items, setItems] = useState<{ name: string; when: string }[]>([]);

  useEffect(() => {
    runShell("omni project list --json")
      .then((o) => {
        try {
          const data = JSON.parse(o.stdout);
          const ps = (data.projects ?? []) as any[];
          const sorted = ps
            .filter((p) => p.last_active || p.updated_at)
            .sort((a, b) =>
              String(b.last_active ?? b.updated_at).localeCompare(String(a.last_active ?? a.updated_at))
            )
            .slice(0, 12)
            .map((p) => ({
              name: p.name as string,
              when: String(p.last_active ?? p.updated_at).slice(0, 10),
            }));
          setItems(sorted);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="notif">
      <div className="region-h">🔔 最近 <span className="tbd">(通知模型 TBD)</span></div>
      <div className="notif-list">
        {items.map((it, i) => (
          <div className="notif-item" key={i}>
            <span className="notif-dot" />
            <span className="notif-name">{it.name}</span>
            <span className="notif-when">{it.when}</span>
          </div>
        ))}
        {items.length === 0 && <div className="muted">（暂无）</div>}
      </div>
    </div>
  );
}
