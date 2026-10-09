import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import { type SvgExportOptions } from './toSvg.js';
/**
 * Rasterizing SVG to PNG inherently needs a real image backend (a browser
 * <canvas>, `sharp`, `resvg`, ...) — graph-ui stays zero-dependency and
 * framework-agnostic, so it never bundles one. Instead, PNG export follows
 * the same dependency-injection pattern as `createReactFlowAdapter`: the
 * host supplies a `rasterize` function that turns SVG markup into PNG
 * bytes, and graph-ui only builds the (deterministic) SVG to feed it.
 */
export type PngRasterizer = (svgMarkup: string, size: {
    width: number;
    height: number;
}) => Promise<Uint8Array> | Uint8Array;
export declare function exportToPng(frame: RenderFrame, rasterize: PngRasterizer, options?: SvgExportOptions): Promise<Uint8Array>;
//# sourceMappingURL=toPng.d.ts.map