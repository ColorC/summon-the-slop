// HTML 消毒统一入口 —— 剪贴板富文本(HTML)和 markdown 渲染出的 HTML 塞进 innerHTML 前都要过这层。
// 用 DOMPurify 默认配置(它默认就保留 style 属性、剥 script/事件属性), 不额外加自定义白名单,
// 否则会把剪贴板富文本(Word/网页复制常见的 style/span 嵌套)洗坏。
import DOMPurify from "dompurify";
import { micromark } from "micromark";

/** 用 DOMPurify 默认配置清洗一段 HTML(剥 script/事件属性, 保留 style 等常规标签属性)。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

/** markdown → HTML(micromark) → 消毒, 供渲染到 innerHTML / srcDoc 的场景统一使用。 */
export function renderMarkdownSafe(md: string): string {
  return sanitizeHtml(micromark(md));
}
