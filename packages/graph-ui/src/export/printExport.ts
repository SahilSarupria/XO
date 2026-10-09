import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { exportToSvg, type SvgExportOptions } from './toSvg.js';

/**
 * Print-friendly SVG export: forces a white background (regardless of the
 * active theme) and explicit width/height/viewBox sized to the content, so
 * the output looks correct on paper rather than assuming a screen.
 */
export function exportToPrintSvg(frame: RenderFrame, options: SvgExportOptions = {}): string {
  const printFrame: RenderFrame = { ...frame, background: '#ffffff' };
  return exportToSvg(printFrame, { padding: 32, ...options });
}
