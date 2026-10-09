import { GraphViewport } from '../viewport/GraphViewport.js';
import { HistoryStack } from '../history/HistoryStack.js';
import { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import { animateViewportTransition, viewportStateAt, isViewportTransitionComplete } from '../animation/graphAnimations.js';
import type { GraphModel } from '../model/GraphModel.js';
import type { Easing } from '../animation/easing.js';
import type { GraphViewportState, NodeId, Size } from '../model/types.js';

/**
 * A pure camera model: wraps GraphViewport (reused, not redesigned) with
 * named bookmarks, undo/redo history (built on HistoryStack), and animated
 * travel between states (built on the animation engine's viewport-transition
 * helpers). All the actual pan/zoom/fit math still lives in GraphViewport —
 * GraphCamera only adds the bookkeeping a camera needs on top of it.
 */
export class GraphCamera {
  private constructor(
    readonly viewport: GraphViewport,
    private readonly bookmarks: ReadonlyMap<string, GraphViewportState>,
    private readonly history: HistoryStack<GraphViewportState>,
  ) {}

  static create(initial: GraphViewportState = { x: 0, y: 0, zoom: 1 }): GraphCamera {
    return new GraphCamera(new GraphViewport(initial), new Map(), HistoryStack.init(initial));
  }

  private withViewport(viewport: GraphViewport, commitHistory = true): GraphCamera {
    const history = commitHistory ? this.history.push(viewport.state) : this.history;
    return new GraphCamera(viewport, this.bookmarks, history);
  }

  pan(dx: number, dy: number): GraphCamera {
    return this.withViewport(this.viewport.pan(dx, dy));
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }): GraphCamera {
    return this.withViewport(this.viewport.zoomBy(factor, anchor));
  }

  fitToScreen(model: GraphModel, viewportSize: Size): GraphCamera {
    return this.withViewport(this.viewport.fitToScreen(model, viewportSize));
  }

  focus(nodeId: NodeId, model: GraphModel, viewportSize: Size, zoom?: number): GraphCamera {
    return this.withViewport(this.viewport.zoomToNode(nodeId, model, viewportSize, zoom));
  }

  // ---- bookmarks -------------------------------------------------

  bookmark(name: string): GraphCamera {
    const next = new Map(this.bookmarks);
    next.set(name, this.viewport.state);
    return new GraphCamera(this.viewport, next, this.history);
  }

  removeBookmark(name: string): GraphCamera {
    if (!this.bookmarks.has(name)) return this;
    const next = new Map(this.bookmarks);
    next.delete(name);
    return new GraphCamera(this.viewport, next, this.history);
  }

  getBookmark(name: string): GraphViewportState | undefined {
    return this.bookmarks.get(name);
  }

  get bookmarkNames(): readonly string[] {
    return [...this.bookmarks.keys()];
  }

  goToBookmark(name: string): GraphCamera {
    const state = this.bookmarks.get(name);
    if (!state) return this;
    return this.withViewport(new GraphViewport(state));
  }

  // ---- history -------------------------------------------------

  undo(): GraphCamera {
    if (!this.history.canUndo) return this;
    const history = this.history.undo();
    return new GraphCamera(new GraphViewport(history.present), this.bookmarks, history);
  }

  redo(): GraphCamera {
    if (!this.history.canRedo) return this;
    const history = this.history.redo();
    return new GraphCamera(new GraphViewport(history.present), this.bookmarks, history);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // ---- animated travel -------------------------------------------------

  /** Starts an animated transition to `target`, returning both the updated camera (committed immediately, for history/bookmark purposes) and an animation engine a renderer can sample every frame via `GraphCamera.animatedStateAt`. */
  travelTo(target: GraphViewportState, durationMs: number, nowMs: number, easing?: Easing): { camera: GraphCamera; engine: GraphAnimationEngine } {
    const engine = animateViewportTransition(GraphAnimationEngine.empty(), this.viewport.state, target, durationMs, nowMs, easing);
    return { camera: this.withViewport(new GraphViewport(target)), engine };
  }

  static animatedStateAt(engine: GraphAnimationEngine, nowMs: number, fallback: GraphViewportState): GraphViewportState {
    return viewportStateAt(engine, nowMs, fallback);
  }

  static isTravelComplete(engine: GraphAnimationEngine, nowMs: number): boolean {
    return isViewportTransitionComplete(engine, nowMs);
  }
}
