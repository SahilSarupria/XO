import type { GraphModel } from '../model/GraphModel.js';
import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { type SvgExportOptions } from './toSvg.js';
import type { ClipboardPayload } from './types.js';
/**
 * Builds a clipboard-ready payload rather than writing to the clipboard
 * directly — `navigator.clipboard` is a browser API graph-ui has no
 * business depending on. The host application takes the returned
 * `{ mimeType, data }` and writes it with whatever clipboard API fits its
 * environment.
 */
export declare function buildJsonClipboardPayload(model: GraphModel): ClipboardPayload;
export declare function buildSvgClipboardPayload(frame: RenderFrame, options?: SvgExportOptions): ClipboardPayload;
//# sourceMappingURL=clipboard.d.ts.map