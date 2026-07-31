// 用户级可配项。overlay-shell 是深度个人工具: 路径/URL 因人而异, 故全部支持 localStorage
// 覆盖; 缺省值对"全新机器"安全 —— 空串 = 退回进程默认(如 pty 落 home)或该功能温和停用,
// URL = 本地口。在 DevTools 控制台里 set 即可, 无需重启:
//   localStorage.setItem("overlay-terminal-cwd", "D:\\work")
// Rust 侧对应项走环境变量(见 README「配置」节: OVERLAY_NOTE_STORE_ROOT / OVERLAY_SEARCH_ROOTS)。

export function userConfig(key: string, fallback = ""): string {
  try {
    const v = localStorage.getItem(key);
    return v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

export function setUserConfig(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore (隐私模式等) */
  }
}

// ---- keys ----
export const KEY_TERMINAL_CWD = "overlay-terminal-cwd"; // 新终端默认 cwd(空 = home)
export const KEY_AI_BLOCKS_HOME = "overlay-ai-blocks-home"; // AI 块终端工作根(每块一个子目录)
export const KEY_CONTROLLER_HOME = "overlay-controller-home"; // 总控 CLI 家目录(带 AGENTS.md 上下文)
export const KEY_CAPTURES_DIR = "overlay-captures-dir"; // 捕获/圈选目录(空 = 捕获页温和停用)
export const KEY_OMNI_REVIEWSTAGE = "overlay-omni-reviewstage"; // omnicompany 审阅材料目录(空 = 停用)
export const KEY_BOARD_URL = "overlay-board-url"; // omnidashboard 看板 URL
