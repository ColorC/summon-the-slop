// 网页札记入口只启动轻量画布。旧 BlockSuite 数据由画布内的迁移入口按需读取，
// 不再参与首屏，也不会成为新画布的存储格式。
import "./tauri-web-shim";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MaterialNotesWorkspace } from "./regions/MaterialNotesWorkspace";

export interface MaterialNotesMountOptions {
  sessionId?: string;
  sessionTitle?: string;
  onReady?: () => void;
  onError?: (error: string) => void;
}

const mountedRoots = new WeakMap<HTMLElement, Root>();

export function mountMaterialNotesWorkspace(
  container: HTMLElement,
  options: MaterialNotesMountOptions = {},
): () => void {
  mountedRoots.get(container)?.unmount();
  const root = createRoot(container);
  mountedRoots.set(container, root);
  root.render(
    <React.StrictMode>
      <MaterialNotesWorkspace {...options} />
    </React.StrictMode>,
  );
  return () => {
    if (mountedRoots.get(container) !== root) return;
    root.unmount();
    mountedRoots.delete(container);
  };
}

const app = document.getElementById("app");
if (app) mountMaterialNotesWorkspace(app);
