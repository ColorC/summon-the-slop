// poof:aiblock —— 画布上的 "AI 块"。本质是一段绑定到「这个块自己」的持续 AI CLI 对话:
//  · 每个块有独立工作目录 ai-blocks/<块id> → 用 `claude --continue` 天然 resume 该块上次的对话
//  · 关掉笔记 = 元素卸载 = 杀掉 pty(关对话);再打开同一笔记 = 同一块id = --continue 续上
// 实现: 一个不带装饰器的 Lit 块(配合本仓 ES2020/无 experimentalDecorators 的构建),
// 块体里挂一个 React 根渲染已验证的 <TerminalView/>(xterm + ConPTY)。BlockSuite 负责画布上的
// 选中/缩放/平移(Lit reconcile 不会重建 host div, 所以 pty 在平移缩放时不会被churn)。
import {
  BlockComponent,
  BlockService,
  BlockViewExtension,
  FlavourExtension,
  toGfxBlockComponent,
  type ExtensionType,
} from "@blocksuite/block-std";
import {
  GfxCompatible,
  type GfxCommonBlockProps,
  type GfxElementGeometry,
} from "@blocksuite/block-std/gfx";
import { BlockModel, defineBlockSchema } from "@blocksuite/store";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { literal } from "lit/static-html.js";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { TerminalView } from "../regions/Terminal";
import { runShell } from "../lib";

const AI_HOME = "E:\\WindowsWorkspace\\poof\\ai-blocks";

// ---- schema / model ----
type AiBlockProps = {
  provider: string; // claude(默认) / codex
} & Omit<GfxCommonBlockProps, "scale">;

const defaultAiBlockProps: AiBlockProps = {
  provider: "claude",
  index: "a0",
  xywh: "[0,0,560,440]",
  lockedBySelf: false,
  rotate: 0,
};

export const AiBlockSchema = defineBlockSchema({
  flavour: "poof:aiblock",
  props: (): AiBlockProps => defaultAiBlockProps,
  metadata: {
    version: 1,
    role: "content",
    parent: ["affine:note", "affine:surface"],
  },
  toModel: () => new AiBlockModel(),
});

export class AiBlockModel
  extends GfxCompatible<AiBlockProps>(BlockModel)
  implements GfxElementGeometry {}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface EdgelessBlockModelMap {
      "poof:aiblock": AiBlockModel;
    }
    interface BlockModels {
      "poof:aiblock": AiBlockModel;
    }
  }
}

// ---- service ----
export class AiBlockService extends BlockService {
  static override readonly flavour = "poof:aiblock";
}

// ---- page 视图(也被 edgeless 复用为内容)----
const STARTED_PREFIX = "poof-aiblock-started-";

class AiBlockComponent extends BlockComponent<AiBlockModel, AiBlockService> {
  private hostRef = createRef<HTMLDivElement>();
  private _root: Root | null = null;
  private _mounted = false;

  override renderBlock() {
    return html`<div
      class="poof-aiblock"
      style="width:100%;height:100%;min-height:200px;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:#0e0f14;"
    >
      <div
        class="poof-aiblock-bar"
        style="flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;color:#9aa3b5;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);"
      >
        ⌁ AI · ${this.model.provider || "claude"}
      </div>
      <div ${ref(this.hostRef)} style="flex:1 1 auto;min-height:0;"></div>
    </div>`;
  }

  override firstUpdated() {
    void this._mount();
  }

  private async _mount() {
    if (this._mounted) return;
    const host = this.hostRef.value;
    if (!host) return;
    this._mounted = true;
    const blockId = this.model.id;
    const cwd = AI_HOME + "\\" + blockId;
    // 确保该块的独立对话目录存在(pty cwd 必须是已存在目录)
    try {
      await runShell(`if not exist "${cwd}" mkdir "${cwd}"`);
    } catch {
      /* ignore */
    }
    const key = STARTED_PREFIX + blockId;
    const started = localStorage.getItem(key) === "1";
    const provider = this.model.provider || "claude";
    // 首次 = 开新对话; 之后 = --continue 续上该目录里的上次对话(=resume)
    const startCommand =
      provider === "codex"
        ? "codex --dangerously-bypass-approvals-and-sandbox"
        : started
        ? "claude --continue --dangerously-skip-permissions"
        : "claude --dangerously-skip-permissions";
    localStorage.setItem(key, "1");
    this._root = createRoot(host);
    this._root.render(createElement(TerminalView, { id: "ai-" + blockId, startCommand, cwd }));
  }

  private _unmount() {
    if (this._root) {
      try {
        this._root.unmount();
      } catch {
        /* ignore */
      }
      this._root = null;
    }
    this._mounted = false;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // 关笔记/删块 = 卸载 = 关对话(TerminalView 清理里会 ptyKill)
    this._unmount();
  }
}
if (!customElements.get("poof-aiblock")) {
  customElements.define("poof-aiblock", AiBlockComponent);
}

// ---- edgeless 视图(画布上可选中/缩放的自由元素)----
// 基类(toGfxBlockComponent)已按 model.xywh 给元素定尺寸定位, renderPageContent() 即渲染
// 上面 page 组件的 renderBlock(里面的 100%×100% 终端随之填满)→ 无需额外覆写。
class AiBlockEdgelessComponent extends toGfxBlockComponent(AiBlockComponent) {}
if (!customElements.get("poof-edgeless-aiblock")) {
  customElements.define("poof-edgeless-aiblock", AiBlockEdgelessComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "poof-aiblock": AiBlockComponent;
    "poof-edgeless-aiblock": AiBlockEdgelessComponent;
  }
}

// ---- spec(挂进 editor.pageSpecs / edgelessSpecs)----
export const AiBlockSpec: ExtensionType[] = [
  FlavourExtension("poof:aiblock"),
  AiBlockService,
  BlockViewExtension("poof:aiblock", (model) =>
    model.parent?.flavour === "affine:surface"
      ? literal`poof-edgeless-aiblock`
      : literal`poof-aiblock`
  ),
];

// affine:surface 的 children 是固定白名单(frame/image/bookmark/attachment/embed-*/edgeless-text),
// 不含 poof:aiblock → 直接 addBlock 到 surface 会被 schema 拒("Block cannot have parent: affine:surface")。
// 那些 schema 对象是冻结的(push 不进去), 所以这里"不可变重建": 复制一份 surface schema、把
// poof:aiblock 加进它的 children, 连同 AiBlockSchema 一起返回。register 按 flavour 入 Map,
// 后者覆盖前者 → 用我们这份放宽过的 surface。
export function aiBlockSchemas(affineSchemas: any[]): any[] {
  const out = affineSchemas.map((s) => {
    if (s?.model?.flavour === "affine:surface") {
      // 注意: defineBlockSchema 把 role/parent/children 摊进 schema.model(不是 schema.metadata)。
      const kids = s.model?.children || [];
      if (!kids.includes("poof:aiblock")) {
        return { ...s, model: { ...s.model, children: [...kids, "poof:aiblock"] } };
      }
    }
    return s;
  });
  out.push(AiBlockSchema);
  return out;
}

// #6 把"AI 块"按钮注入到原生 edgeless 底部工具栏(edgeless-toolbar-widget 的 shadow root 里的
// .edgeless-toolbar-container), 跟 note/shape 等工具并排 = 统一实现, 不是外挂浮钮。Lit 重渲染
// 实测不会清掉它(点画布后仍在); 仍加个轻量定时器兜底重注入(模式切换等大重渲染时补回)。
export function mountAiToolbarButton(onPlace: () => void): () => void {
  const findContainer = (): Element | null => {
    let tb: any = null;
    const walk = (r: any) =>
      r.querySelectorAll?.("*").forEach((e: any) => {
        if (e.tagName?.toLowerCase() === "edgeless-toolbar-widget") tb = e;
        if (e.shadowRoot) walk(e.shadowRoot);
      });
    walk(document);
    return tb?.shadowRoot?.querySelector(".edgeless-toolbar-container") ?? null;
  };
  const ensure = () => {
    const c = findContainer();
    if (!c || c.querySelector(".poof-ai-tool")) return;
    const btn = document.createElement("button");
    btn.className = "poof-ai-tool";
    btn.title = "加 AI 块（绑定本笔记的持续对话 · 关=关 · 再开=resume）";
    btn.innerHTML = `<span style="font-size:15px;line-height:1">⌁</span> AI`;
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;height:54px;padding:0 13px;margin:0 1px;background:transparent;border:none;color:#c3c6cf;cursor:pointer;font-size:13px;";
    btn.addEventListener("mouseenter", () => (btn.style.color = "#fff"));
    btn.addEventListener("mouseleave", () => (btn.style.color = "#c3c6cf"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPlace();
    });
    c.appendChild(btn);
  };
  ensure();
  const iv = window.setInterval(ensure, 1000);
  return () => window.clearInterval(iv);
}

// ---- 往画布(surface)放一个 AI 块 ----
export function insertAiBlock(doc: any, _noteId: string): string | null {
  try {
    const surface = doc.getBlocksByFlavour?.("affine:surface")?.[0];
    const surfaceId = surface?.model?.id ?? surface?.id;
    if (!surfaceId) return null;
    // 错开堆叠, 别叠在一起
    const n = (doc.getBlocksByFlavour?.("poof:aiblock") || []).length;
    const x = 120 + (n % 4) * 60;
    const y = 120 + (n % 4) * 50;
    return doc.addBlock(
      "poof:aiblock",
      { xywh: `[${x},${y},560,440]`, provider: "claude" },
      surfaceId
    );
  } catch (e) {
    console.error("insertAiBlock", e);
    return null;
  }
}
