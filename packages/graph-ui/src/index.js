/**
 * @xo/graph-ui — public API.
 *
 * This is deliberately the ONLY export surface. Internal modules (layout
 * algorithms, adapters' implementation details, controller internals) are
 * reachable only through the classes exported here, so downstream packages
 * (XO Studio, the runtime debugger, the compiler visualizer, the package
 * explorer, future Registry/dashboard UIs) can only depend on this stable
 * contract.
 */
// ---- primary API classes -------------------------------------------------
export { GraphCanvas } from './canvas/GraphCanvas.js';
export { GraphRenderer } from './render/GraphRenderer.js';
export { GraphController } from './controller/GraphController.js';
export { GraphModel } from './model/GraphModel.js';
export { GraphLayouts } from './layout/GraphLayouts.js';
export { GraphTheme } from './theme/GraphTheme.js';
export { GraphSearch } from './search/GraphSearch.js';
export { GraphFilters } from './filter/GraphFilters.js';
// ---- supporting API classes (viewport/selection/execution/minimap/interaction) ----
// These are part of the public contract too — GraphController composes
// them, but host apps also use them directly (e.g. a runtime debugger
// driving GraphExecutionState from its own event stream).
export { GraphViewport, isRectVisible } from './viewport/GraphViewport.js';
export { GraphSelection } from './selection/GraphSelection.js';
export { GraphExecutionState } from './execution/GraphExecutionState.js';
export { GraphMinimap } from './minimap/GraphMinimap.js';
export { GraphInteraction } from './interaction/GraphInteraction.js';
export { SvgStringAdapter } from './render/adapters/SvgStringAdapter.js';
export { createReactFlowAdapter } from './render/adapters/ReactFlowAdapter.js';
// ---- presets -------------------------------------------------
export { GraphPresets, KnowledgeGraphPreset, CapabilityGraphPreset, IntentGraphPreset, WorkflowGraphPreset, PermissionGraphPreset, DependencyGraphPreset, ExecutionGraphPreset, DAGPreset, TreePreset, GeneralNetworkPreset, } from './presets/index.js';
// ---- domain adapters -------------------------------------------------
export { KnowledgeGraphAdapter, CapabilityGraphAdapter, IntentGraphAdapter, WorkflowGraphAdapter, PermissionGraphAdapter, ExecutionGraphAdapter, executionStateFromSource, DependencyGraphAdapter, } from './adapters/index.js';
// ---- inspector contracts -------------------------------------------------
export { GraphInspector } from './inspector/GraphInspector.js';
// ---- animation engine -------------------------------------------------
export { Easings, lerpNumber, lerpPoint, lerpViewportState, GraphAnimation, GraphAnimationEngine, animateNodePosition, nodePositionAt, animateEdgeFlow, edgeFlowPhaseAt, animateHighlight, highlightIntensityAt, stopHighlight, animateSelectionEnter, selectionIntensityAt, stopSelectionAnimation, animateExecutionActive, executionIntensityAt, stopExecutionAnimation, animateViewportTransition, viewportStateAt, isViewportTransitionComplete, computeExecutionPathReveal, } from './animation/index.js';
// ---- export system -------------------------------------------------
export { exportToSvg, computeContentBounds, exportToPng, exportModelToJson, importModelFromJson, modelToJsonObject, modelFromJsonObject, buildJsonClipboardPayload, buildSvgClipboardPayload, captureSnapshot, exportSnapshotToJson, importSnapshotFromJson, applySnapshot, exportToPrintSvg, } from './export/index.js';
// ---- history -------------------------------------------------
export { HistoryStack, createViewportHistory, createSelectionHistory, createNavigationHistory, } from './history/index.js';
// ---- commands -------------------------------------------------
export { GraphCommandRegistry, BUILTIN_COMMAND_NAMES } from './commands/index.js';
// ---- advanced interaction engine -------------------------------------------------
export { DragStateMachine } from './interaction/DragStateMachine.js';
export { ResizeStateMachine } from './interaction/ResizeStateMachine.js';
export { MarqueeSelection } from './interaction/MarqueeSelection.js';
export { LassoSelection } from './interaction/LassoSelection.js';
export { TouchGestures } from './interaction/TouchGestures.js';
export { HoverManager } from './interaction/HoverManager.js';
export { ClickArbiter } from './interaction/ClickArbiter.js';
export { FocusManager } from './interaction/FocusManager.js';
// ---- smart selection -------------------------------------------------
export { SmartSelection } from './selection/SmartSelection.js';
export { SavedSelections } from './selection/SavedSelections.js';
// ---- spatial index -------------------------------------------------
export { Quadtree } from './spatial/Quadtree.js';
export { RTree } from './spatial/RTree.js';
export { SpatialIndex } from './spatial/SpatialIndex.js';
// ---- virtualization -------------------------------------------------
export { VirtualizationEngine } from './virtualization/VirtualizationEngine.js';
// ---- constraint engine -------------------------------------------------
export { ConstraintEngine } from './constraints/ConstraintEngine.js';
// ---- snap engine -------------------------------------------------
export { SnapEngine } from './snap/SnapEngine.js';
// ---- grouping system -------------------------------------------------
export { GraphGrouping } from './grouping/GraphGrouping.js';
// ---- layout transitions -------------------------------------------------
export { computeLayoutTransition, layoutTransitionPositionAt, renderTransitionFrame, isLayoutTransitionComplete, } from './layout/transitions/LayoutTransition.js';
// ---- camera engine -------------------------------------------------
export { GraphCamera } from './camera/GraphCamera.js';
export { GraphCameraGroup } from './camera/GraphCameraGroup.js';
// ---- plugin system -------------------------------------------------
export { GraphPluginRegistry, installPlugin } from './plugins/GraphPluginRegistry.js';
// ---- diagnostics -------------------------------------------------
export { GraphDiagnostics } from './diagnostics/GraphDiagnostics.js';
// ---- developer tools (data models only — no UI) -------------------------------------------------
export { inspectGraph, inspectInteraction, inspectSelection, inspectLayout, inspectCamera, inspectPerformance, inspectAnimation, inspectHistory, } from './devtools/inspectors.js';
export { Timeline, EventTimeline, CommandTimeline } from './devtools/Timeline.js';
//# sourceMappingURL=index.js.map