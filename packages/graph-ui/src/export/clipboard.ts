import type { GraphModel } from '../model/GraphModel.js';
import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { exportModelToJson } from './toJson.js';
import { exportToSvg, type SvgExportOptions } from './toSvg.js';
import type { ClipboardPayload } from './types.js';

/**
 * Builds a clipboard-ready payload rather than writing to the clipboard
 * directly — `navigator.clipboard` is a browser API graph-ui has no
 * business depending on. The host application takes the returned
 * `{ mimeType, data }` and writes it with whatever clipboard API fits its
 * environment.
 */
export function buildJsonClipboardPayload(model: GraphModel): ClipboardPayload {
  return { mimeType: 'application/json', data: exportModelToJson(model) };
}

export function buildSvgClipboardPayload(frame: RenderFrame, options?: SvgExportOptions): ClipboardPayload {
  return { mimeType: 'image/svg+xml', data: exportToSvg(frame, options) };
}
