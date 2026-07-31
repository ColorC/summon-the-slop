// 全套日志引导 — 必须在最早被 import(放在各 window 入口的第一行)。
// 把"这个 webview 窗口"里的 console 报错 / 未捕获异常 / Promise 拒绝, 全部送给 Rust(log_js),
// 落进 %TEMP%\overlay-shell-summon.log 的同一条时间线 —— 这样原生侧(panic/钩子/启动)和前端侧的事件
// 按时间对齐, 崩溃(0xcfffffff 这类原生崩)前一刻 webview 在干什么就有据可查, 不用再靠猜。
import { invoke } from "@tauri-apps/api/core";

// 这是哪个窗口: index.html→main, snap.html→snap, replay/recbar/pin …
const surface = location.pathname.replace(/^\//, "").replace(/\.html$/, "") || "main";

let inShip = false; // 防止"包装后的 console"递归调用自己
// 防刷屏: 同一条(level + 前 120 字)在 3s 窗口内只落一次, 期间重复只计数, 下次落盘时带上 [+N]。
// BlockSuite 整页重载/拆解会瞬间抛几百条相同的 Lit 错 —— 不限流会淹掉日志和崩溃哨兵。
const recent = new Map<string, { n: number; t: number }>();
function ship(level: string, msg: string) {
  if (inShip) return;
  const key = level + "|" + msg.slice(0, 120);
  const now = performance.now();
  const prev = recent.get(key);
  if (prev && now - prev.t < 3000) {
    prev.n++;
    return; // 抑制窗口内的重复
  }
  const suppressed = prev ? prev.n : 0;
  recent.set(key, { n: 0, t: now });
  if (recent.size > 200) recent.clear(); // 防 map 无界增长
  inShip = true;
  try {
    // 失败也无所谓(非 Tauri 上下文 / 命令未就绪) —— 绝不能让记日志本身抛错
    const tag = suppressed ? `[+${suppressed}同条被抑制] ` : "";
    void invoke("log_js", { line: `${surface}/${level} ${tag}${msg}` }).catch(() => {});
  } catch {
    /* ignore */
  } finally {
    inShip = false;
  }
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 3500);
}

// 包住 console.error / warn(report 级) —— 保留原行为, 额外落盘
(["error", "warn"] as const).forEach((level) => {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    ship(level, fmt(args));
  };
});

// 未捕获的同步异常(真正能崩 webview 的那类)
window.addEventListener("error", (e) => {
  const t =
    e.error instanceof Error
      ? `${e.error.name}: ${e.error.message}\n${e.error.stack || ""}`
      : e.message;
  ship("onerror", `${t} @ ${e.filename}:${e.lineno}:${e.colno}`);
});

// 未处理的 Promise 拒绝
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  const t = r instanceof Error ? `${r.name}: ${r.message}\n${r.stack || ""}` : String(r);
  ship("unhandledrejection", t);
});

// 关窗/刷新前留个标记 —— 崩溃 vs 正常卸载, 后面好区分
window.addEventListener("beforeunload", () => ship("unload", "beforeunload"));

ship("boot", `loaded · ${navigator.userAgent}`);
