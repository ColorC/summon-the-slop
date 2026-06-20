import ReactDOM from "react-dom/client";
import App from "./App";
import { TerminalWindow } from "./windows/TerminalWindow";
import { SurfaceWindow } from "./windows/SurfaceWindow";

// Route by URL hash. Default = the lightweight summoned SHADE (with an inline canvas
// mode). The terminal and omni surfaces open as their own normal windows.
function route() {
  const h = window.location.hash.replace(/^#\/?/, "").trim();
  if (h === "terminal") return <TerminalWindow />;
  if (h === "project" || h === "review") return <SurfaceWindow view={h} />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(route());
