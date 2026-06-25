// poof 小提示窗: 监听 Rust 发来的 poof://toast 文本, 淡入显示约 1.6s 再淡出。
// 窗口的显示/隐藏与"永不激活"由 Rust 端管(show_toast), 这里只管内容和淡入淡出。
import { listen } from "@tauri-apps/api/event";

const el = document.getElementById("toast")!;
const msg = document.getElementById("msg")!;
let fade: ReturnType<typeof setTimeout> | undefined;

listen<string>("poof://toast", (e) => {
  msg.textContent = e.payload || "";
  if (fade) clearTimeout(fade);
  // 先抹掉再触发, 让重复弹出也有淡入动画
  el.classList.remove("show");
  void el.offsetWidth; // 强制 reflow
  requestAnimationFrame(() => el.classList.add("show"));
  fade = setTimeout(() => el.classList.remove("show"), 1650);
});
