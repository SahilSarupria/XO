import type { GraphRenderAdapter, RenderFrame } from './GraphRenderAdapter.js';
/**
 * Renders a frame to a deterministic SVG markup string. Depends on nothing
 * beyond the DOM-free string builder below, so it works identically in
 * Node (tests, SSR, snapshot export) and the browser. This is the
 * reference adapter implementation — other adapters (Canvas, WebGL, React
 * Flow) implement the same GraphRenderAdapter contract.
 */
export declare class SvgStringAdapter implements GraphRenderAdapter {
    readonly name = "svg-string";
    private lastMarkup;
    render(frame: RenderFrame): void;
    /** The markup produced by the most recent render() call. */
    toString(): string;
    dispose(): void;
}
//# sourceMappingURL=SvgStringAdapter.d.ts.map