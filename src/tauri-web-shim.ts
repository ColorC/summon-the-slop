// 纯网页端 Tauri 垫片: 让 poof 笔记栈在浏览器里跑(无 Tauri)。
// @tauri-apps/api 的 invoke 底层读 window.__TAURI_INTERNALS__.invoke —— 这里把它接到 8210 的
// poof 笔记桥(/lofa/poof/invoke), notes_* 命令落盘到主机的 poof-notes(与桌面 poof 共用笔记)。
// 其余壳/文件命令在网页端降级成安全空值(搜索空、读文件空、run_shell 空), 不崩。
//
// 必须在任何 @tauri-apps/api 调用前 import(notes-web.tsx 第一行 import 本模块)。

const warnedUnknownCmds = new Set<string>();

async function bridge(cmd: string, args: any): Promise<any> {
  const r = await fetch("/lofa/poof/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args: args || {} }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.ok === false) throw new Error((j && j.error) || `poof bridge error: ${cmd}`);
  return j.result;
}

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    if (typeof cmd === "string" && cmd.startsWith("notes_")) return bridge(cmd, args);
    switch (cmd) {
      case "search":
        return Promise.resolve([]);
      case "read_file_text":
        return Promise.resolve("");
      case "read_file_b64":
        return Promise.resolve(null);
      case "write_file_text":
      case "copy_text":
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

export {};
