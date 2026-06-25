// 全局即时提示 —— 任何带 data-tip 或 title 的元素, 鼠标一悬浮立刻显示名称(无原生 ~500ms 延迟)。
// 悬浮时把 title 挪到 data-otitle 以抑制原生延迟气泡; 我们自己的气泡即时定位在元素上/下方。
let installed = false;

export function installInstantTooltips(): () => void {
  if (installed) return () => {};
  installed = true;

  const tip = document.createElement("div");
  tip.className = "pf-tip";
  document.body.appendChild(tip);

  let cur: HTMLElement | null = null;

  const show = (el: HTMLElement, text: string) => {
    cur = el;
    tip.textContent = text;
    const r = el.getBoundingClientRect();
    const above = r.top > 56; // 顶部留不下就显示在下方
    tip.classList.toggle("below", !above);
    tip.style.left = Math.round(r.left + r.width / 2) + "px";
    tip.style.top = Math.round(above ? r.top - 8 : r.bottom + 8) + "px";
    tip.classList.add("show");
  };
  const hide = () => {
    cur = null;
    tip.classList.remove("show");
  };

  const textOf = (el: HTMLElement): string => {
    const dt = el.getAttribute("data-tip");
    if (dt) return dt;
    const t = el.getAttribute("title");
    if (t && t.trim()) {
      el.setAttribute("data-otitle", t); // 抑制原生延迟气泡
      el.removeAttribute("title");
      return t;
    }
    return el.getAttribute("data-otitle") || "";
  };

  const onOver = (e: Event) => {
    const t = e.target as HTMLElement | null;
    const el = t?.closest?.("[data-tip],[title],[data-otitle]") as HTMLElement | null;
    if (!el) return;
    const text = textOf(el);
    if (text) show(el, text);
  };
  const onOut = (e: Event) => {
    const t = e.target as HTMLElement | null;
    const el = t?.closest?.("[data-tip],[title],[data-otitle]");
    if (el && el === cur) hide();
  };
  // 滚动/点击时收起, 别让气泡飘着
  const onScrollOrDown = () => hide();

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  document.addEventListener("pointerdown", onScrollOrDown, true);
  window.addEventListener("scroll", onScrollOrDown, true);

  return () => {
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("mouseout", onOut, true);
    document.removeEventListener("pointerdown", onScrollOrDown, true);
    window.removeEventListener("scroll", onScrollOrDown, true);
    tip.remove();
    installed = false;
  };
}
