import { exportModelToJson } from './toJson.js';
import { exportToSvg } from './toSvg.js';
/**
 * Builds a clipboard-ready payload rather than writing to the clipboard
 * directly — `navigator.clipboard` is a browser API graph-ui has no
 * business depending on. The host application takes the returned
 * `{ mimeType, data }` and writes it with whatever clipboard API fits its
 * environment.
 */
export function buildJsonClipboardPayload(model) {
    return { mimeType: 'application/json', data: exportModelToJson(model) };
}
export function buildSvgClipboardPayload(frame, options) {
    return { mimeType: 'image/svg+xml', data: exportToSvg(frame, options) };
}
//# sourceMappingURL=clipboard.js.map