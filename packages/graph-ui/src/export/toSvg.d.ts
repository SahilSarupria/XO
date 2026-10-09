import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import type { Rect } from '../model/types.js';
export interface SvgExportOptions {
    /** Explicit width/height for the <svg> root; defaults to fitting the frame's content bounds. */
    readonly width?: number;
    readonly height?: number;
    readonly padding?: number;
}
/** Computes the bounding rect of everything in a frame (nodes + edge endpoints), in world space. */
export declare function computeContentBounds(frame: RenderFrame): Rect;
/**
 * Renders a RenderFrame to a standalone, deterministic SVG document string.
 * Pure function — no DOM, no adapter, safe to call in Node or the browser.
 * This is what backs `exportToSvg`/`exportToPrintSvg`/PNG export (which
 * rasterizes this markup via a host-supplied rasterizer).
 */
export declare function exportToSvg(frame: RenderFrame, options?: SvgExportOptions): string;
//# sourceMappingURL=toSvg.d.ts.map