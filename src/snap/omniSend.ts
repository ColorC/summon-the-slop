// 统一捕获 · 把一次截图(可带评论/三态)发送到 omni, 让 dashboard 按屏幕位置自动识别它压在哪个
// 审阅材料/计划/笔记/项目/任务上, 并挂一条札记。见 plan UNIVERSAL-CAPTURE。
//
// 流程: capture_probe(光标下内容区原点+窗口标题) → POST /api/boss-sight/captures(带屏幕矩形+原点)。
// 解析(几何相交)在 dashboard 端做; 这里只负责采集提示 + 上送。
import { invoke } from "@tauri-apps/api/core";

const OMNI_BASE: string =
  (window as unknown as { OMNI_CAPTURE_ENDPOINT?: string }).OMNI_CAPTURE_ENDPOINT ||
  "http://127.0.0.1:8210";

export type Verdict = "keep" | "reject" | "undecided" | null;

interface Probe { content_origin: number[] | null; win_title: string; url: string; }
interface SendResult { omni_uri: string | null; note_id: string | null; saved_path: string; resolved?: unknown; }

export interface CaptureMeta { comment: string; verdict: Verdict; }

async function probeTarget(cx: number, cy: number): Promise<Probe> {
  try {
    return await invoke<Probe>("capture_probe", { x: Math.round(cx), y: Math.round(cy) });
  } catch {
    return { content_origin: null, win_title: "", url: "" };
  }
}

export async function sendCaptureToOmni(opts: {
  pngBase64: string;
  rect: [number, number, number, number]; // 屏幕物理像素 [l,t,r,b]
  comment: string;
  verdict?: Verdict;
  modality?: "still" | "video" | "dom_snapshot";
}): Promise<SendResult> {
  const [l, t, r, b] = opts.rect;
  const probe = await probeTarget((l + r) / 2, (t + b) / 2);
  const body = {
    capture_kind: "capture",
    modality: opts.modality || "still",
    comment: opts.comment || "",
    verdict: opts.verdict || null,
    image_data_url: opts.pngBase64 ? "data:image/png;base64," + opts.pngBase64 : null,
    screen_rect: [l, t, r, b],
    content_origin: probe.content_origin,
    dpr: window.devicePixelRatio || null,
    url: probe.url || "",
    title: probe.win_title || "",
    enqueue: true,
  };
  const resp = await fetch(OMNI_BASE + "/api/boss-sight/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("omni 捕获失败: HTTP " + resp.status);
  return (await resp.json()) as SendResult;
}

// 极简评论输入浮层(自带样式, 不依赖 snap 的其它状态)。返回 null = 取消。
export function promptCaptureMeta(): Promise<CaptureMeta | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45);font-family:system-ui,'Microsoft YaHei',sans-serif;";
    const box = document.createElement("div");
    box.style.cssText =
      "width:440px;max-width:90vw;background:#141210;color:#e7e9ee;border:1px solid #2a2a2a;" +
      "border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.6);";
    box.innerHTML =
      '<div style="font-size:13px;font-weight:600;margin-bottom:8px">评论 → omni（自动识别这一块属于哪个实体）</div>' +
      '<textarea id="oc_text" placeholder="写一句你想指出/想改的…（可只选三态不写字）" ' +
      'style="width:100%;height:84px;resize:vertical;background:#0f0f0f;color:#e7e9ee;border:1px solid #333;' +
      'border-radius:6px;padding:8px;font-size:13px;outline:none"></textarea>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-top:10px">' +
      '<span style="font-size:12px;color:#8b949e">三态:</span>' +
      '<button data-v="keep" class="ov" style="cursor:pointer">保留</button>' +
      '<button data-v="reject" class="ov" style="cursor:pointer">弃用</button>' +
      '<button data-v="undecided" class="ov" style="cursor:pointer">未定</button>' +
      '<button data-v="" class="ov on" style="cursor:pointer">无</button>' +
      '<span style="flex:1"></span>' +
      '<button id="oc_cancel" style="cursor:pointer;background:#2a2a2a;color:#e7e9ee;border:0;border-radius:6px;padding:6px 12px">取消</button>' +
      '<button id="oc_send" style="cursor:pointer;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 14px;font-weight:600">发送</button>' +
      "</div>";
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    box.querySelectorAll(".ov").forEach((b) => {
      (b as HTMLElement).style.cssText +=
        ";background:#0f0f0f;color:#cbd2da;border:1px solid #333;border-radius:6px;padding:4px 9px;font-size:12px";
    });
    let verdict: Verdict = null;
    const text = box.querySelector<HTMLTextAreaElement>("#oc_text")!;
    box.querySelectorAll<HTMLElement>(".ov").forEach((b) => {
      b.onclick = () => {
        box.querySelectorAll<HTMLElement>(".ov").forEach((x) => {
          x.style.background = "#0f0f0f";
          x.style.borderColor = "#333";
        });
        b.style.background = "#16324f";
        b.style.borderColor = "#1f6feb";
        const v = b.dataset.v || "";
        verdict = (v ? v : null) as Verdict;
      };
    });
    const done = (res: CaptureMeta | null) => { wrap.remove(); resolve(res); };
    box.querySelector<HTMLElement>("#oc_cancel")!.onclick = () => done(null);
    box.querySelector<HTMLElement>("#oc_send")!.onclick = () =>
      done({ comment: text.value.trim(), verdict });
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(null); });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done({ comment: text.value.trim(), verdict }); }
      if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    setTimeout(() => text.focus(), 30);
  });
}
