// 同步源块的绑定登记 —— 纯 localStorage, 零依赖。单独成文件防循环引用:
// 笔记列表/桥/index/自愈 都要判断"这个 doc 是不是绑定子文档(不是独立笔记, 别列进去)", 都从这里 import。
export interface Binding {
  kind: string; // 源类型: "md-file" | "omni-plan" | "omni-progress" | "omni-review" | …
  ref: string; // 源标识: 文件绝对路径 / mat_id / plan_id / progress id
  base: string; // 上次同步的源文本(三路合并的 base)
  hash: string; // base 的 hash(检测外部改动)
  rev?: string; // 外部版本号/mtime(若有)
  title?: string; // 显示名
}

const BIND_KEY = "poof-bound-sources";

function load(): Record<string, Binding> {
  try {
    return JSON.parse(localStorage.getItem(BIND_KEY) || "{}");
  } catch {
    return {};
  }
}
function save(m: Record<string, Binding>): void {
  try {
    localStorage.setItem(BIND_KEY, JSON.stringify(m));
  } catch {
    /* ignore(超额) */
  }
}

export function getBinding(subDocId: string): Binding | null {
  return load()[subDocId] || null;
}
export function setBinding(subDocId: string, b: Binding): void {
  const m = load();
  m[subDocId] = b;
  save(m);
}
export function removeBinding(subDocId: string): void {
  const m = load();
  delete m[subDocId];
  save(m);
}
export function allBindings(): Record<string, Binding> {
  return load();
}
/** 这个 doc 是不是绑定子文档(= embed-synced-doc 的内容, 不是独立笔记)。 */
export function isBoundSubDoc(id: string): boolean {
  return !!load()[id];
}
