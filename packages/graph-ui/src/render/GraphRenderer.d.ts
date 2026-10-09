import type { GraphModel } from '../model/GraphModel.js';
import { GraphViewport } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { EdgeId, NodeId, Size } from '../model/types.js';
import type { GraphRenderAdapter, RenderFrame } from './adapters/GraphRenderAdapter.js';
export interface GraphRendererOptions {
    /** Node/edge count above which viewport culling is applied. Below this,
     * everything renders regardless of visibility (avoids culling overhead
     * for small graphs). */
    virtualizationThreshold?: number;
    hoveredNodeId?: NodeId;
    hoveredEdgeId?: EdgeId;
}
/**
 * GraphRenderer composes model + theme + viewport + selection + execution
 * state into a single deterministic RenderFrame, then hands it to whichever
 * GraphRenderAdapter is attached. It performs viewport culling for large
 * graphs so adapters only ever see what's on screen.
 */
export declare class GraphRenderer {
    private readonly adapter;
    constructor(adapter: GraphRenderAdapter);
    buildFrame(model: GraphModel, theme: GraphTheme, viewport: GraphViewport, viewportSize: Size, selection?: GraphSelection, execution?: GraphExecutionState, options?: GraphRendererOptions): RenderFrame;
    renderFrame(frame: RenderFrame): void;
    render(model: GraphModel, theme: GraphTheme, viewport: GraphViewport, viewportSize: Size, selection?: GraphSelection, execution?: GraphExecutionState, options?: GraphRendererOptions): RenderFrame;
    dispose(): void;
}
//# sourceMappingURL=GraphRenderer.d.ts.map