// 纯网页端 Tauri 垫片: 让 overlay-shell 笔记栈在浏览器里跑(无 Tauri)。
// @tauri-apps/api 的 invoke 底层读 window.__TAURI_INTERNALS__.invoke —— 这里把它接到 8210 的
// overlay-shell 笔记桥(/lofa/overlay/invoke), notes_* 命令落盘到主机的 overlay-note-store(与桌面 overlay-shell 共用笔记)。
// 文件搜索接 Dashboard → 本机 Overlay Shell 索引；其余高权限文件命令仍降级成安全空值。
//
// 必须在任何 @tauri-apps/api 调用前 import(notes-web.tsx 第一行 import 本模块)。
import { copyPlainText, installDoubleCtrlForwarder, installWebClipboardCompat } from "./webRuntimeCompat";
import { webNotesInvoke } from "./webNotesInvoke";

const warnedUnknownCmds = new Set<string>();

installWebClipboardCompat();
installDoubleCtrlForwarder();

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    if (typeof cmd === "string" && cmd.startsWith("notes_")) return webNotesInvoke(cmd, args);
    switch (cmd) {
      case "search":
      case "file_inspect":
        return webNotesInvoke(cmd, args);
      case "search_index_ready":
        // The browser bridge does not own the desktop process' lazy arena lifecycle.
        return Promise.resolve(true);
      case "nb_pending":
      case "nb_respond":
        return webNotesInvoke(cmd, args);
      case "copy_text":
        return copyPlainText(String(args?.text ?? ""));
      case "read_file_text":
        return Promise.resolve("");
      case "read_file_b64":
        return Promise.resolve(null);
      case "write_file_text":
      case "open_path":
      case "reveal_path":
        return Promise.resolve(null);
      case "run_shell":
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      default:
        if (!warnedUnknownCmds.has(cmd)) {
          warnedUnknownCmds.add(cmd);
          console.warn(`[tauri-web-shim] 未覆盖命令 "${cmd}" 已降级为 null`);
        }
        return Promise.resolve(null); // 未知命令一律安全空值, 别抛
    }
  },
  transformCallback: (cb: any) => cb,
  registerListener: () => {},
  unregisterListener: () => {},
  // @tauri-apps/api 的 getCurrentWindow/getCurrentWebview 读 metadata; 网页端给个假身份避免崩。
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
  convertFileSrc: (p: string) => p,
};

(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  ...(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__,
  unregisterListener: () => {},
};

export {};
