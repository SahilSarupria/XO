import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { type SvgExportOptions } from './toSvg.js';
/**
 * Print-friendly SVG export: forces a white background (regardless of the
 * active theme) and explicit width/height/viewBox sized to the content, so
 * the output looks correct on paper rather than assuming a screen.
 */
export declare function exportToPrintSvg(frame: RenderFrame, options?: SvgExportOptions): string;
//# sourceMappingURL=printExport.d.ts.map