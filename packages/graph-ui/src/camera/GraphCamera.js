import { GraphViewport } from '../viewport/GraphViewport.js';
import { HistoryStack } from '../history/HistoryStack.js';
import { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import { animateViewportTransition, viewportStateAt, isViewportTransitionComplete } from '../animation/graphAnimations.js';
/**
 * A pure camera model: wraps GraphViewport (reused, not redesigned) with
 * named bookmarks, undo/redo history (built on HistoryStack), and animated
 * travel between states (built on the animation engine's viewport-transition
 * helpers). All the actual pan/zoom/fit math still lives in GraphViewport —
 * GraphCamera only adds the bookkeeping a camera needs on top of it.
 */
export class GraphCamera {
    viewport;
    bookmarks;
    history;
    constructor(viewport, bookmarks, history) {
        this.viewport = viewport;
        this.bookmarks = bookmarks;
        this.history = history;
    }
    static create(initial = { x: 0, y: 0, zoom: 1 }) {
        return new GraphCamera(new GraphViewport(initial), new Map(), HistoryStack.init(initial));
    }
    withViewport(viewport, commitHistory = true) {
        const history = commitHistory ? this.history.push(viewport.state) : this.history;
        return new GraphCamera(viewport, this.bookmarks, history);
    }
    pan(dx, dy) {
        return this.withViewport(this.viewport.pan(dx, dy));
    }
    zoomBy(factor, anchor) {
        return this.withViewport(this.viewport.zoomBy(factor, anchor));
    }
    fitToScreen(model, viewportSize) {
        return this.withViewport(this.viewport.fitToScreen(model, viewportSize));
    }
    focus(nodeId, model, viewportSize, zoom) {
        return this.withViewport(this.viewport.zoomToNode(nodeId, model, viewportSize, zoom));
    }
    // ---- bookmarks -------------------------------------------------
    bookmark(name) {
        const next = new Map(this.bookmarks);
        next.set(name, this.viewport.state);
        return new GraphCamera(this.viewport, next, this.history);
    }
    removeBookmark(name) {
        if (!this.bookmarks.has(name))
            return this;
        const next = new Map(this.bookmarks);
        next.delete(name);
        return new GraphCamera(this.viewport, next, this.history);
    }
    getBookmark(name) {
        return this.bookmarks.get(name);
    }
    get bookmarkNames() {
        return [...this.bookmarks.keys()];
    }
    goToBookmark(name) {
        const state = this.bookmarks.get(name);
        if (!state)
            return this;
        return this.withViewport(new GraphViewport(state));
    }
    // ---- history -------------------------------------------------
    undo() {
        if (!this.history.canUndo)
            return this;
        const history = this.history.undo();
        return new GraphCamera(new GraphViewport(history.present), this.bookmarks, history);
    }
    redo() {
        if (!this.history.canRedo)
            return this;
        const history = this.history.redo();
        return new GraphCamera(new GraphViewport(history.present), this.bookmarks, history);
    }
    get canUndo() {
        return this.history.canUndo;
    }
    get canRedo() {
        return this.history.canRedo;
    }
    // ---- animated travel -------------------------------------------------
    /** Starts an animated transition to `target`, returning both the updated camera (committed immediately, for history/bookmark purposes) and an animation engine a renderer can sample every frame via `GraphCamera.animatedStateAt`. */
    travelTo(target, durationMs, nowMs, easing) {
        const engine = animateViewportTransition(GraphAnimationEngine.empty(), this.viewport.state, target, durationMs, nowMs, easing);
        return { camera: this.withViewport(new GraphViewport(target)), engine };
    }
    static animatedStateAt(engine, nowMs, fallback) {
        return viewportStateAt(engine, nowMs, fallback);
    }
    static isTravelComplete(engine, nowMs) {
        return isViewportTransitionComplete(engine, nowMs);
    }
}
//# sourceMappingURL=GraphCamera.js.map