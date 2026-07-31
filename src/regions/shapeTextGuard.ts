import type { AffineEditorContainer } from "@blocksuite/presets";
import { flushNotesStore } from "./fileNotesStore";
import { scheduleNoteExport } from "./noteExport";

/**
 * Shape text is edited in a temporary rich-text overlay. In BlockSuite 0.19
 * that overlay can keep focus while its Y.Text binding has stopped updating;
 * canvas clicks are then swallowed by the overlay dispatcher and the visible
 * text exists only in the DOM. Mirror the DOM as a last-resort write-through
 * and force a clean editor exit when the user clicks elsewhere.
 */
export function installShapeTextStabilityGuard(
  editor: AffineEditorContainer,
  doc: any,
  collection: any
): () => void {
  const shapeEditorFrom = (event: Event): any | null =>
    (event.composedPath() as any[]).find(
      (node) => node?.tagName?.toLowerCase?.() === "edgeless-shape-text-editor"
    ) ?? null;

  const commit = (shapeEditor: any, allowEmpty = true): boolean => {
    const yText = shapeEditor?.element?.text;
    const root = shapeEditor?.inlineEditor?.rootElement ?? shapeEditor?.querySelector?.(".inline-editor");
    if (!yText || !root) return false;
    const domText = String((root as HTMLElement).innerText ?? "").replace(/\r\n/g, "\n");
    const modelText = String(yText.toString?.() ?? "");
    if (domText === modelText || (!allowEmpty && !domText && modelText)) return false;

    doc.transact?.(() => {
      yText.delete(0, yText.length);
      if (domText) yText.insert(0, domText);
    });
    scheduleNoteExport(doc, collection);
    window.setTimeout(() => void flushNotesStore(), 500);
    return true;
  };

  const commitSoon = (event: Event) => {
    const shapeEditor = shapeEditorFrom(event);
    if (!shapeEditor) return;
    window.setTimeout(() => commit(shapeEditor), 0);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const active = editor.querySelector("edgeless-shape-text-editor") as any;
    if (active) commit(active, false);
  };

  const onPointerDown = (event: PointerEvent) => {
    const active = editor.querySelector("edgeless-shape-text-editor") as any;
    if (!active || event.composedPath().includes(active)) return;

    commit(active);
    const root: any = editor.querySelector("affine-edgeless-root");
    const editable = active.inlineEditor?.rootElement ?? active.querySelector?.(".inline-editor");
    editable?.blur?.();
    // WebView2 may keep the contenteditable focused even after a canvas
    // pointerdown. Finish cleanup if BlockSuite's blur handler did not.
    window.queueMicrotask(() => {
      if (active.isConnected) {
        if (active.element) active.element.textDisplay = true;
        active.remove();
      }
      root?.service?.selection?.set?.({
        elements: active.element?.id ? [active.element.id] : [],
        editing: false,
      });
      root?.gfx?.tool?.setTool?.("default", undefined);
    });
  };

  editor.addEventListener("input", commitSoon, true);
  editor.addEventListener("compositionend", commitSoon, true);
  editor.addEventListener("paste", commitSoon, true);
  editor.addEventListener("keydown", onKeyDown, true);
  editor.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    for (const active of editor.querySelectorAll("edgeless-shape-text-editor")) commit(active);
    editor.removeEventListener("input", commitSoon, true);
    editor.removeEventListener("compositionend", commitSoon, true);
    editor.removeEventListener("paste", commitSoon, true);
    editor.removeEventListener("keydown", onKeyDown, true);
    editor.removeEventListener("pointerdown", onPointerDown, true);
  };
}
