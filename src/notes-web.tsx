// poof 笔记的纯网页入口: 接 8210 笔记桥, 挂真 <NotesWorkspace>(BlockSuite 笔记, 与桌面 overlay-shell 共用)。
// 看板/LOFA app 都嵌这个页(经 8210 一个口)。
import "./tauri-web-shim"; // 必须最先: 装 invoke 垫片 → 8210 桥
import "@toeverything/theme/style.css";
import "./App.css";
import ReactDOM from "react-dom/client";
import { NotesWorkspace } from "./regions/NotesWorkspace";

ReactDOM.createRoot(document.getElementById("app") as HTMLElement).render(
  <div className="poof-notes-web" style={{ position: "fixed", inset: 0 }}>
    <NotesWorkspace onClose={() => { /* 网页端无关闭 */ }} />
  </div>,
);
