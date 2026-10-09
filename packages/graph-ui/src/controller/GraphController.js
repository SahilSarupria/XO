import { GraphModel } from '../model/GraphModel.js';
import { GraphViewport } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphSearch } from '../search/GraphSearch.js';
import { GraphFilters } from '../filter/GraphFilters.js';
import { GraphLayouts } from '../layout/GraphLayouts.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import { HistoryStack } from '../history/HistoryStack.js';
/**
 * GraphController is the single orchestration point: it owns the current
 * (immutable) model/viewport/selection/search/filters/theme/execution state
 * and exposes one mutable, stateful API over them. GraphCanvas wires a
 * GraphController to a GraphRenderer + a rendering adapter; nothing else in
 * the package needs to know both exist.
 */
export class GraphController {
    layouts;
    state;
    listeners = new Set();
    /** Undo/redo history over the model, committed to by setModel/updateModel/applyLayout. */
    modelHistory;
    constructor(init = {}) {
        this.layouts = init.layouts ?? new GraphLayouts();
        const initialModel = init.model ?? GraphModel.empty();
        this.state = {
            model: initialModel,
            viewport: new GraphViewport(),
            selection: GraphSelection.empty(),
            search: new GraphSearch(),
            filters: GraphFilters.empty(),
            theme: init.theme ?? GraphTheme.light(),
            execution: GraphExecutionState.idle(),
        };
        this.modelHistory = HistoryStack.init(initialModel);
    }
    getState() {
        return this.state;
    }
    /** The model after filters are applied — what should actually be rendered/searched against. */
    get visibleModel() {
        return this.state.filters.apply(this.state.model);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    setState(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners)
            listener(this.state);
    }
    // ---- model -----------------------------------------------------
    /** Commits a new model as the current present, recording the previous one for undo(). */
    commitModel(model) {
        this.modelHistory = this.modelHistory.push(model);
        this.setState({ model });
    }
    setModel(model) {
        this.commitModel(model);
    }
    updateModel(updater) {
        this.commitModel(updater(this.state.model));
    }
    /** Reverts to the model before the last setModel/updateModel/applyLayout call, if any. */
    undo() {
        if (!this.modelHistory.canUndo)
            return;
        this.modelHistory = this.modelHistory.undo();
        this.setState({ model: this.modelHistory.present });
    }
    /** Re-applies a model previously reverted by undo(), if any. */
    redo() {
        if (!this.modelHistory.canRedo)
            return;
        this.modelHistory = this.modelHistory.redo();
        this.setState({ model: this.modelHistory.present });
    }
    get canUndo() {
        return this.modelHistory.canUndo;
    }
    get canRedo() {
        return this.modelHistory.canRedo;
    }
    // ---- layout ------------------------------------------------------
    applyLayout(kind, options) {
        this.commitModel(this.layouts.apply(kind, this.state.model, options));
    }
    // ---- viewport ------------------------------------------------------
    setViewport(state) {
        this.setState({ viewport: new GraphViewport(state) });
    }
    pan(dx, dy) {
        this.setState({ viewport: this.state.viewport.pan(dx, dy) });
    }
    zoomBy(factor, anchor) {
        this.setState({ viewport: this.state.viewport.zoomBy(factor, anchor) });
    }
    fitToScreen(viewportSize) {
        this.setState({ viewport: this.state.viewport.fitToScreen(this.visibleModel, viewportSize) });
    }
    fitSelection(viewportSize) {
        this.setState({
            viewport: this.state.viewport.fitSelection([...this.state.selection.state.nodeIds], this.visibleModel, viewportSize),
        });
    }
    centerNode(nodeId, viewportSize) {
        this.setState({ viewport: this.state.viewport.centerNode(nodeId, this.visibleModel, viewportSize) });
    }
    zoomToNode(nodeId, viewportSize, zoom) {
        this.setState({ viewport: this.state.viewport.zoomToNode(nodeId, this.visibleModel, viewportSize, zoom) });
    }
    zoomToSelection(viewportSize) {
        this.setState({
            viewport: this.state.viewport.zoomToSelection([...this.state.selection.state.nodeIds], this.visibleModel, viewportSize),
        });
    }
    // ---- selection ------------------------------------------------------
    selectNode(id, options) {
        this.setState({ selection: this.state.selection.selectNode(id, options) });
    }
    toggleNodeSelection(id) {
        this.setState({ selection: this.state.selection.toggleNode(id) });
    }
    selectEdge(id, options) {
        this.setState({ selection: this.state.selection.selectEdge(id, options) });
    }
    selectBox(rect) {
        this.setState({ selection: GraphSelection.fromBox(rect, this.visibleModel) });
    }
    clearSelection() {
        this.setState({ selection: GraphSelection.empty() });
    }
    // ---- search ------------------------------------------------------
    search(query) {
        const search = GraphSearch.run(query, this.visibleModel);
        this.setState({ search });
        const match = search.activeMatch;
        if (match?.kind === 'node')
            this.setState({ selection: GraphSelection.empty().selectNode(match.id) });
    }
    nextMatch() {
        const search = this.state.search.next();
        this.setState({ search });
        if (search.activeMatch?.kind === 'node')
            this.setState({ selection: GraphSelection.empty().selectNode(search.activeMatch.id) });
    }
    previousMatch() {
        const search = this.state.search.previous();
        this.setState({ search });
        if (search.activeMatch?.kind === 'node')
            this.setState({ selection: GraphSelection.empty().selectNode(search.activeMatch.id) });
    }
    clearSearch() {
        this.setState({ search: new GraphSearch() });
    }
    // ---- filters ------------------------------------------------------
    setFilters(filters) {
        this.setState({ filters });
    }
    updateFilters(updater) {
        this.setState({ filters: updater(this.state.filters) });
    }
    // ---- theme ------------------------------------------------------
    setTheme(theme) {
        this.setState({ theme });
    }
    // ---- execution ------------------------------------------------------
    updateExecution(updater) {
        this.setState({ execution: updater(this.state.execution) });
    }
    resetExecution() {
        this.setState({ execution: GraphExecutionState.idle() });
    }
}
//# sourceMappingURL=GraphController.js.map