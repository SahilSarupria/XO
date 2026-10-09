import { isRectVisible } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
const DEFAULT_NODE_SIZE = { width: 120, height: 40 };
/**
 * GraphRenderer composes model + theme + viewport + selection + execution
 * state into a single deterministic RenderFrame, then hands it to whichever
 * GraphRenderAdapter is attached. It performs viewport culling for large
 * graphs so adapters only ever see what's on screen.
 */
export class GraphRenderer {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    buildFrame(model, theme, viewport, viewportSize, selection = GraphSelection.empty(), execution = GraphExecutionState.idle(), options = {}) {
        const threshold = options.virtualizationThreshold ?? 500;
        const shouldCull = model.nodeCount + model.edgeCount > threshold;
        const worldRect = viewport.visibleWorldRect(viewportSize);
        const visibleNodeIds = new Set();
        const nodes = [];
        // model.nodes is already deterministically ordered (insertion order).
        for (const node of model.nodes) {
            const size = node.size ?? DEFAULT_NODE_SIZE;
            const rect = { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
            if (shouldCull && !isRectVisible(rect, worldRect))
                continue;
            visibleNodeIds.add(node.id);
            nodes.push({
                node,
                style: theme.resolveNodeStyle(node, {
                    selected: selection.hasNode(node.id),
                    hovered: options.hoveredNodeId === node.id,
                    executionStatus: execution.statusOf(node.id),
                }),
                selected: selection.hasNode(node.id),
                hovered: options.hoveredNodeId === node.id,
            });
        }
        const edges = [];
        for (const edge of model.edges) {
            const source = model.getNode(edge.source);
            const target = model.getNode(edge.target);
            if (!source || !target)
                continue;
            // An edge is only culled if both its visible-graph endpoints are
            // culled — partially on-screen edges must still render.
            if (shouldCull && !visibleNodeIds.has(edge.source) && !visibleNodeIds.has(edge.target))
                continue;
            const sourceSize = source.size ?? DEFAULT_NODE_SIZE;
            const targetSize = target.size ?? DEFAULT_NODE_SIZE;
            edges.push({
                edge,
                style: theme.resolveEdgeStyle(edge, {
                    selected: selection.hasEdge(edge.id),
                    hovered: options.hoveredEdgeId === edge.id,
                    animated: execution.animatedEdgeIds.has(edge.id),
                }),
                sourcePoint: { x: source.position.x + sourceSize.width / 2, y: source.position.y + sourceSize.height / 2 },
                targetPoint: { x: target.position.x + targetSize.width / 2, y: target.position.y + targetSize.height / 2 },
                selected: selection.hasEdge(edge.id),
                hovered: options.hoveredEdgeId === edge.id,
            });
        }
        return { background: theme.definition.background, nodes, edges };
    }
    renderFrame(frame) {
        this.adapter.render(frame);
    }
    render(model, theme, viewport, viewportSize, selection, execution, options) {
        const frame = this.buildFrame(model, theme, viewport, viewportSize, selection, execution, options);
        this.renderFrame(frame);
        return frame;
    }
    dispose() {
        this.adapter.dispose?.();
    }
}
//# sourceMappingURL=GraphRenderer.js.map