import { GraphController } from '../controller/GraphController.js';
import { GraphRenderer, type GraphRendererOptions } from '../render/GraphRenderer.js';
import { GraphInteraction } from '../interaction/GraphInteraction.js';
import type { GraphRenderAdapter, RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import type { EdgeId, NodeId, Size } from '../model/types.js';
import type { KeyboardDirection } from '../interaction/GraphInteraction.js';

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
export class GraphCanvas {
  readonly controller: GraphController;
  readonly interaction: GraphInteraction;
  private readonly renderer: GraphRenderer;
  private viewportSize: Size;
  private readonly rendererOptions: GraphRendererOptions;
  private hoveredNodeId: NodeId | undefined;
  private hoveredEdgeId: EdgeId | undefined;
  private unsubscribeController: () => void;
  private lastFrame: RenderFrame | undefined;

  constructor(adapter: GraphRenderAdapter, options: GraphCanvasOptions) {
    this.controller = options.controller ?? new GraphController();
    this.interaction = options.interaction ?? new GraphInteraction();
    this.renderer = new GraphRenderer(adapter);
    this.viewportSize = options.viewportSize;
    this.rendererOptions = options.rendererOptions ?? {};

    this.unsubscribeController = this.controller.subscribe(() => this.renderNow());
    this.wireInteraction();
    this.renderNow();
  }

  private wireInteraction(): void {
    this.interaction.on('nodeClick', (e) =>
      this.controller.selectNode(e.nodeId, e.additive === undefined ? undefined : { additive: e.additive }),
    );
    this.interaction.on('nodeDoubleClick', (e) => this.controller.zoomToNode(e.nodeId, this.viewportSize));
    this.interaction.on('edgeClick', (e) =>
      this.controller.selectEdge(e.edgeId, e.additive === undefined ? undefined : { additive: e.additive }),
    );
    this.interaction.on('nodeHover', (e) => {
      this.hoveredNodeId = e.nodeId;
      this.renderNow();
    });
    this.interaction.on('nodeUnhover', () => {
      this.hoveredNodeId = undefined;
      this.renderNow();
    });
    this.interaction.on('edgeHover', (e) => {
      this.hoveredEdgeId = e.edgeId;
      this.renderNow();
    });
    this.interaction.on('boxSelectEnd', (e) => this.controller.selectBox(e.rect));
    this.interaction.on('nodeDrag', (e) => {
      if (!this.interaction.nodeDragEnabled || !e.position) return;
      this.controller.updateModel((model) => {
        const node = model.getNode(e.nodeId);
        return node ? model.upsertNode({ ...node, position: e.position! }) : model;
      });
    });
    this.interaction.on('keyboardNavigate', (e) => this.handleKeyboardNavigate(e.direction, e.fromNodeId));
  }

  private handleKeyboardNavigate(direction: KeyboardDirection, fromNodeId?: NodeId): void {
    const anchor = fromNodeId ?? [...this.controller.getState().selection.state.nodeIds][0];
    if (!anchor) return;
    const next = GraphInteraction.findNeighborInDirection(anchor, direction, this.controller.visibleModel);
    if (next) this.controller.selectNode(next);
  }

  resize(viewportSize: Size): void {
    this.viewportSize = viewportSize;
    this.renderNow();
  }

  private renderNow(): void {
    const state = this.controller.getState();
    this.lastFrame = this.renderer.render(
      this.controller.visibleModel,
      state.theme,
      state.viewport,
      this.viewportSize,
      state.selection,
      state.execution,
      {
        ...this.rendererOptions,
        ...(this.hoveredNodeId !== undefined ? { hoveredNodeId: this.hoveredNodeId } : {}),
        ...(this.hoveredEdgeId !== undefined ? { hoveredEdgeId: this.hoveredEdgeId } : {}),
      },
    );
  }

  /** The most recently rendered frame (useful for adapters that render outside the push cycle). */
  get frame(): RenderFrame | undefined {
    return this.lastFrame;
  }

  dispose(): void {
    this.unsubscribeController();
    this.renderer.dispose();
  }
}
