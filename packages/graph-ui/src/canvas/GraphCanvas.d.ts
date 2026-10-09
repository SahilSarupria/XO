import { GraphController } from '../controller/GraphController.js';
import { type GraphRendererOptions } from '../render/GraphRenderer.js';
import { GraphInteraction } from '../interaction/GraphInteraction.js';
import type { GraphRenderAdapter, RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import type { Size } from '../model/types.js';
export interface GraphCanvasOptions {
    readonly controller?: GraphController;
    readonly interaction?: GraphInteraction;
    readonly viewportSize: Size;
    readonly rendererOptions?: GraphRendererOptions;
}
/**
 * GraphCanvas is the single entry point most host applications use. It
 * wires a GraphController (state), a GraphRenderer bound to a
 * GraphRenderAdapter (drawing), and a GraphInteraction bus (input) into one
 * object, re-rendering automatically whenever controller state changes and
 * translating interaction events into controller calls (selection,
 * navigation, box-select).
 */
export declare class GraphCanvas {
    readonly controller: GraphController;
    readonly interaction: GraphInteraction;
    private readonly renderer;
    private viewportSize;
    private readonly rendererOptions;
    private hoveredNodeId;
    private hoveredEdgeId;
    private unsubscribeController;
    private lastFrame;
    constructor(adapter: GraphRenderAdapter, options: GraphCanvasOptions);
    private wireInteraction;
    private handleKeyboardNavigate;
    resize(viewportSize: Size): void;
    private renderNow;
    /** The most recently rendered frame (useful for adapters that render outside the push cycle). */
    get frame(): RenderFrame | undefined;
    dispose(): void;
}
//# sourceMappingURL=GraphCanvas.d.ts.map