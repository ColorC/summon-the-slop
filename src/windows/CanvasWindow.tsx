import { NoteSurface } from "../surfaces";

/** Notes infinite canvas as its own normal window (opened from the shade).
 *  Currently tldraw (infinite canvas + arrows/flowchart + iframe webpage embeds).
 *  Production swap = BlockSuite EdgelessEditor (markdown blocks + open-source). */
export function CanvasWindow() {
  return (
    <div className="win win-canvas">
      <NoteSurface />
    </div>
  );
}
