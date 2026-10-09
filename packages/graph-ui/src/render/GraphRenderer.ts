import type { GraphModel } from '../model/GraphModel.js';
import { GraphViewport, isRectVisible } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { EdgeId, NodeId, Rect, Size } from '../model/types.js';
import type { GraphRenderAdapter, RenderFrame, RenderableEdge, RenderableNode } from './adapters/GraphRenderAdapter.js';

export interface GraphRendererOptions {
  /** Node/edge count above which viewport culling is applied. Below this,
   * everything renders regardless of visibility (avoids culling overhead
   * for small graphs). */
  virtualizationThreshold?: number;
  hoveredNodeId?: NodeId;
  hoveredEdgeId?: EdgeId;
}

const DEFAULT_NODE_SIZE = { width: 120, height: 40 };

/**
 * GraphRenderer composes model + theme + viewport + selection + execution
 * state into a single deterministic RenderFrame, then hands it to whichever
 * GraphRenderAdapter is attached. It performs viewport culling for large
 * graphs so adapters only ever see what's on screen.
 */
export class GraphRenderer {
  constructor(private readonly adapter: GraphRenderAdapter) {}

  buildFrame(
    model: GraphModel,
    theme: GraphTheme,
    viewport: GraphViewport,
    viewportSize: Size,
    selection: GraphSelection = GraphSelection.empty(),
    execution: GraphExecutionState = GraphExecutionState.idle(),
    options: GraphRendererOptions = {},
  ): RenderFrame {
    const threshold = options.virtualizationThreshold ?? 500;
    const shouldCull = model.nodeCount + model.edgeCount > threshold;
    const worldRect = viewport.visibleWorldRect(viewportSize);

    const visibleNodeIds = new Set<NodeId>();
    const nodes: RenderableNode[] = [];
    // model.nodes is already deterministically ordered (insertion order).
    for (const node of model.nodes) {
      const size = node.size ?? DEFAULT_NODE_SIZE;
      const rect: Rect = { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
      if (shouldCull && !isRectVisible(rect, worldRect)) continue;
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

    const edges: RenderableEdge[] = [];
    for (const edge of model.edges) {
      const source = model.getNode(edge.source);
      const target = model.getNode(edge.target);
      if (!source || !target) continue;
      // An edge is only culled if both its visible-graph endpoints are
      // culled — partially on-screen edges must still render.
      if (shouldCull && !visibleNodeIds.has(edge.source) && !visibleNodeIds.has(edge.target)) continue;
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

  renderFrame(frame: RenderFrame): void {
    this.adapter.render(frame);
  }

  render(
    model: GraphModel,
    theme: GraphTheme,
    viewport: GraphViewport,
    viewportSize: Size,
    selection?: GraphSelection,
    execution?: GraphExecutionState,
    options?: GraphRendererOptions,
  ): RenderFrame {
    const frame = this.buildFrame(model, theme, viewport, viewportSize, selection, execution, options);
    this.renderFrame(frame);
    return frame;
  }

  dispose(): void {
    this.adapter.dispose?.();
  }
}
