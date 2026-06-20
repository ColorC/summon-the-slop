import { DockviewReact, type DockviewReadyEvent, type DockviewApi } from "dockview";
import "dockview/dist/styles/dockview.css";
import { ProjectSurface, ReviewSurface, TalkSurface, NoteSurface } from "../surfaces";

const components = {
  project: () => (
    <div className="dock-pane">
      <ProjectSurface />
    </div>
  ),
  review: () => (
    <div className="dock-pane">
      <ReviewSurface />
    </div>
  ),
  talk: () => (
    <div className="dock-pane">
      <TalkSurface />
    </div>
  ),
  note: () => (
    <div className="dock-pane note">
      <NoteSurface />
    </div>
  ),
};

/** Center workspace — dockview. Panels (项目/审阅/对话/笔记画布) are draggable,
 *  splittable and float-able (dockview floating groups). Left nav focuses them. */
export function CenterDock({ apiRef }: { apiRef: React.MutableRefObject<DockviewApi | null> }) {
  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    event.api.addPanel({ id: "note", component: "note", title: "笔记画布" });
    event.api.addPanel({
      id: "project",
      component: "project",
      title: "项目",
      position: { referencePanel: "note", direction: "within" },
    });
    event.api.addPanel({
      id: "review",
      component: "review",
      title: "审阅台",
      position: { referencePanel: "note", direction: "within" },
    });
    event.api.addPanel({
      id: "talk",
      component: "talk",
      title: "对话",
      position: { referencePanel: "note", direction: "within" },
    });
    event.api.getPanel("note")?.focus();
  };

  return (
    <DockviewReact
      components={components}
      onReady={onReady}
      className="dockview-theme-abyss center-dock"
    />
  );
}
