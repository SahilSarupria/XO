import { GraphModel } from '../model/GraphModel.js';
import { GraphViewport } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphSearch } from '../search/GraphSearch.js';
import { GraphFilters } from '../filter/GraphFilters.js';
import { GraphLayouts } from '../layout/GraphLayouts.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import { HistoryStack } from '../history/HistoryStack.js';
import type { EdgeId, GraphLayoutOptions, GraphViewportState, LayoutKind, NodeId, Rect, Size } from '../model/types.js';

export interface GraphControllerState {
  readonly model: GraphModel;
  readonly viewport: GraphViewport;
  readonly selection: GraphSelection;
  readonly search: GraphSearch;
  readonly filters: GraphFilters;
  readonly theme: GraphTheme;
  readonly execution: GraphExecutionState;
}

type ControllerListener = (state: GraphControllerState) => void;

/**
 * GraphController is the single orchestration point: it owns the current
 * (immutable) model/viewport/selection/search/filters/theme/execution state
 * and exposes one mutable, stateful API over them. GraphCanvas wires a
 * GraphController to a GraphRenderer + a rendering adapter; nothing else in
 * the package needs to know both exist.
 */
export class GraphController {
  readonly layouts: GraphLayouts;
  private state: GraphControllerState;
  private readonly listeners = new Set<ControllerListener>();
  /** Undo/redo history over the model, committed to by setModel/updateModel/applyLayout. */
  private modelHistory: HistoryStack<GraphModel>;

  constructor(init: { model?: GraphModel; theme?: GraphTheme; layouts?: GraphLayouts } = {}) {
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

  getState(): GraphControllerState {
    return this.state;
  }

  /** The model after filters are applied — what should actually be rendered/searched against. */
  get visibleModel(): GraphModel {
    return this.state.filters.apply(this.state.model);
  }

  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<GraphControllerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  // ---- model -----------------------------------------------------

  /** Commits a new model as the current present, recording the previous one for undo(). */
  private commitModel(model: GraphModel): void {
    this.modelHistory = this.modelHistory.push(model);
    this.setState({ model });
  }

  setModel(model: GraphModel): void {
    this.commitModel(model);
  }

  updateModel(updater: (model: GraphModel) => GraphModel): void {
    this.commitModel(updater(this.state.model));
  }

  /** Reverts to the model before the last setModel/updateModel/applyLayout call, if any. */
  undo(): void {
    if (!this.modelHistory.canUndo) return;
    this.modelHistory = this.modelHistory.undo();
    this.setState({ model: this.modelHistory.present });
  }

  /** Re-applies a model previously reverted by undo(), if any. */
  redo(): void {
    if (!this.modelHistory.canRedo) return;
    this.modelHistory = this.modelHistory.redo();
    this.setState({ model: this.modelHistory.present });
  }

  get canUndo(): boolean {
    return this.modelHistory.canUndo;
  }

  get canRedo(): boolean {
    return this.modelHistory.canRedo;
  }

  // ---- layout ------------------------------------------------------

  applyLayout(kind: LayoutKind | string, options?: GraphLayoutOptions): void {
    this.commitModel(this.layouts.apply(kind, this.state.model, options));
  }

  // ---- viewport ------------------------------------------------------

  setViewport(state: GraphViewportState): void {
    this.setState({ viewport: new GraphViewport(state) });
  }

  pan(dx: number, dy: number): void {
    this.setState({ viewport: this.state.viewport.pan(dx, dy) });
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.setState({ viewport: this.state.viewport.zoomBy(factor, anchor) });
  }

  fitToScreen(viewportSize: Size): void {
    this.setState({ viewport: this.state.viewport.fitToScreen(this.visibleModel, viewportSize) });
  }

  fitSelection(viewportSize: Size): void {
    this.setState({
      viewport: this.state.viewport.fitSelection([...this.state.selection.state.nodeIds], this.visibleModel, viewportSize),
    });
  }

  centerNode(nodeId: NodeId, viewportSize: Size): void {
    this.setState({ viewport: this.state.viewport.centerNode(nodeId, this.visibleModel, viewportSize) });
  }

  zoomToNode(nodeId: NodeId, viewportSize: Size, zoom?: number): void {
    this.setState({ viewport: this.state.viewport.zoomToNode(nodeId, this.visibleModel, viewportSize, zoom) });
  }

  zoomToSelection(viewportSize: Size): void {
    this.setState({
      viewport: this.state.viewport.zoomToSelection([...this.state.selection.state.nodeIds], this.visibleModel, viewportSize),
    });
  }

  // ---- selection ------------------------------------------------------

  selectNode(id: NodeId, options?: { additive?: boolean }): void {
    this.setState({ selection: this.state.selection.selectNode(id, options) });
  }

  toggleNodeSelection(id: NodeId): void {
    this.setState({ selection: this.state.selection.toggleNode(id) });
  }

  selectEdge(id: EdgeId, options?: { additive?: boolean }): void {
    this.setState({ selection: this.state.selection.selectEdge(id, options) });
  }

  selectBox(rect: Rect): void {
    this.setState({ selection: GraphSelection.fromBox(rect, this.visibleModel) });
  }

  clearSelection(): void {
    this.setState({ selection: GraphSelection.empty() });
  }

  // ---- search ------------------------------------------------------

  search(query: string): void {
    const search = GraphSearch.run(query, this.visibleModel);
    this.setState({ search });
    const match = search.activeMatch;
    if (match?.kind === 'node') this.setState({ selection: GraphSelection.empty().selectNode(match.id) });
  }

  nextMatch(): void {
    const search = this.state.search.next();
    this.setState({ search });
    if (search.activeMatch?.kind === 'node') this.setState({ selection: GraphSelection.empty().selectNode(search.activeMatch.id) });
  }

  previousMatch(): void {
    const search = this.state.search.previous();
    this.setState({ search });
    if (search.activeMatch?.kind === 'node') this.setState({ selection: GraphSelection.empty().selectNode(search.activeMatch.id) });
  }

  clearSearch(): void {
    this.setState({ search: new GraphSearch() });
  }

  // ---- filters ------------------------------------------------------

  setFilters(filters: GraphFilters): void {
    this.setState({ filters });
  }

  updateFilters(updater: (filters: GraphFilters) => GraphFilters): void {
    this.setState({ filters: updater(this.state.filters) });
  }

  // ---- theme ------------------------------------------------------

  setTheme(theme: GraphTheme): void {
    this.setState({ theme });
  }

  // ---- execution ------------------------------------------------------

  updateExecution(updater: (execution: GraphExecutionState) => GraphExecutionState): void {
    this.setState({ execution: updater(this.state.execution) });
  }

  resetExecution(): void {
    this.setState({ execution: GraphExecutionState.idle() });
  }
}
