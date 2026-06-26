// poof 小提示窗。文字不走事件系统(win.emit/app.emit 都送不到这个独立小窗的 listen), 改由 Rust
// 端 win.eval 直接调 window.__showToast(text) —— webview 加载了就一定调得到, 最稳。
// 窗口的显示/隐藏与"不抢焦点"由 Rust 端管(show_toast), 这里只管内容和淡入淡出。
const el = document.getElementById("toast")!;
const msg = document.getElementById("msg")!;
let fade: ReturnType<typeof setTimeout> | undefined;

(window as any).__showToast = (text: string) => {
  msg.textContent = text || "";
  if (fade) clearTimeout(fade);
  // 先抹掉再触发, 让重复弹出也有淡入动画
  el.classList.remove("show");
  void el.offsetWidth; // 强制 reflow
  requestAnimationFrame(() => el.classList.add("show"));
  fade = setTimeout(() => el.classList.remove("show"), 1650);
};
