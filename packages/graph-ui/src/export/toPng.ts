import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { exportToSvg, type SvgExportOptions } from './toSvg.js';

/**
 * Rasterizing SVG to PNG inherently needs a real image backend (a browser
 * <canvas>, `sharp`, `resvg`, ...) — graph-ui stays zero-dependency and
 * framework-agnostic, so it never bundles one. Instead, PNG export follows
 * the same dependency-injection pattern as `createReactFlowAdapter`: the
 * host supplies a `rasterize` function that turns SVG markup into PNG
 * bytes, and graph-ui only builds the (deterministic) SVG to feed it.
 */
export type PngRasterizer = (svgMarkup: string, size: { width: number; height: number }) => Promise<Uint8Array> | Uint8Array;

export async function exportToPng(frame: RenderFrame, rasterize: PngRasterizer, options: SvgExportOptions = {}): Promise<Uint8Array> {
  const svg = exportToSvg(frame, options);
  const bounds = svgDimensions(svg);
  return rasterize(svg, bounds);
}

function svgDimensions(svg: string): { width: number; height: number } {
  const widthMatch = /width="([\d.]+)"/.exec(svg);
  const heightMatch = /height="([\d.]+)"/.exec(svg);
  return {
    width: widthMatch ? Number(widthMatch[1]) : 0,
    height: heightMatch ? Number(heightMatch[1]) : 0,
  };
}
