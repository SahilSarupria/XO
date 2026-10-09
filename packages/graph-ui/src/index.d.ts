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
export { GraphCanvas } from './canvas/GraphCanvas.js';
export type { GraphCanvasOptions } from './canvas/GraphCanvas.js';
export { GraphRenderer } from './render/GraphRenderer.js';
export type { GraphRendererOptions } from './render/GraphRenderer.js';
export { GraphController } from './controller/GraphController.js';
export type { GraphControllerState } from './controller/GraphController.js';
export { GraphModel } from './model/GraphModel.js';
export { GraphLayouts } from './layout/GraphLayouts.js';
export type { LayoutEngine } from './layout/types.js';
export { GraphTheme } from './theme/GraphTheme.js';
export { GraphSearch } from './search/GraphSearch.js';
export { GraphFilters } from './filter/GraphFilters.js';
export { GraphViewport, isRectVisible } from './viewport/GraphViewport.js';
export type { ViewportTransition } from './viewport/GraphViewport.js';
export { GraphSelection } from './selection/GraphSelection.js';
export { GraphExecutionState } from './execution/GraphExecutionState.js';
export { GraphMinimap } from './minimap/GraphMinimap.js';
export type { MinimapGeometry } from './minimap/GraphMinimap.js';
export { GraphInteraction } from './interaction/GraphInteraction.js';
export type { InteractionEventName, InteractionEventMap, NodeInteractionEvent, EdgeInteractionEvent, BoxSelectEvent, ContextMenuEvent, KeyboardDirection, GraphInteractionOptions, } from './interaction/GraphInteraction.js';
export type { GraphRenderAdapter, RenderFrame, RenderableNode, RenderableEdge } from './render/adapters/GraphRenderAdapter.js';
export { SvgStringAdapter } from './render/adapters/SvgStringAdapter.js';
export { createReactFlowAdapter } from './render/adapters/ReactFlowAdapter.js';
export type { ReactFlowBindings, ReactFlowLikeNode, ReactFlowLikeEdge } from './render/adapters/ReactFlowAdapter.js';
export { GraphPresets, KnowledgeGraphPreset, CapabilityGraphPreset, IntentGraphPreset, WorkflowGraphPreset, PermissionGraphPreset, DependencyGraphPreset, ExecutionGraphPreset, DAGPreset, TreePreset, GeneralNetworkPreset, } from './presets/index.js';
export type { GraphPreset } from './presets/index.js';
export type { NodeId, EdgeId, GroupId, Point, Size, Rect, GraphMetadata, GraphNode, GraphEdge, NodeGroup, EdgeGroup, GraphViewportState, SelectionKind, GraphSelectionState, NodeStyle, EdgeStyle, GraphThemeDefinition, ExecutionNodeStatus, GraphFilterState, GraphSearchMatch, GraphSearchResultState, LayoutPosition, LayoutKind, GraphLayoutResult, GraphLayoutOptions, } from './model/types.js';
export { KnowledgeGraphAdapter, CapabilityGraphAdapter, IntentGraphAdapter, WorkflowGraphAdapter, PermissionGraphAdapter, ExecutionGraphAdapter, executionStateFromSource, DependencyGraphAdapter, } from './adapters/index.js';
export type { GraphAdapter, KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeGraphSource, CapabilityGraphCapability, CapabilityGraphAction, CapabilityGraphSource, IntentGraphIntent, IntentGraphSlot, IntentGraphSource, WorkflowGraphStep, WorkflowGraphTransition, WorkflowGraphSource, PermissionGraphRole, PermissionGraphResource, PermissionGraphGrant, PermissionGraphSource, ExecutionGraphNode, ExecutionGraphEdge, ExecutionGraphSource, DependencyGraphPackage, DependencyGraphDependency, DependencyGraphSource, } from './adapters/index.js';
export { GraphInspector } from './inspector/GraphInspector.js';
export type { PropertyKind, GraphProperty, GraphPropertyGroup, GraphMetadataEntry, BadgeTone, GraphBadge, GraphTooltip, GraphOverlay, GraphContextMenuItem, GraphContextMenuTargetKind, GraphContextMenu, GraphInspectorTargetKind, GraphInspectorData, } from './inspector/types.js';
export { Easings, lerpNumber, lerpPoint, lerpViewportState, GraphAnimation, GraphAnimationEngine, animateNodePosition, nodePositionAt, animateEdgeFlow, edgeFlowPhaseAt, animateHighlight, highlightIntensityAt, stopHighlight, animateSelectionEnter, selectionIntensityAt, stopSelectionAnimation, animateExecutionActive, executionIntensityAt, stopExecutionAnimation, animateViewportTransition, viewportStateAt, isViewportTransitionComplete, computeExecutionPathReveal, } from './animation/index.js';
export type { Easing, EasingFn, AnimationSpec, ExecutionPathReveal } from './animation/index.js';
export { exportToSvg, computeContentBounds, exportToPng, exportModelToJson, importModelFromJson, modelToJsonObject, modelFromJsonObject, buildJsonClipboardPayload, buildSvgClipboardPayload, captureSnapshot, exportSnapshotToJson, importSnapshotFromJson, applySnapshot, exportToPrintSvg, } from './export/index.js';
export type { ClipboardPayload, ExportFormat, GraphSnapshot, SvgExportOptions, PngRasterizer, GraphModelJson, } from './export/index.js';
export { HistoryStack, createViewportHistory, createSelectionHistory, createNavigationHistory, } from './history/index.js';
export type { ViewportHistory, SelectionHistory, NavigationHistory, NavigationEntry } from './history/index.js';
export { GraphCommandRegistry, BUILTIN_COMMAND_NAMES } from './commands/index.js';
export type { GraphCommandContext, GraphCommandHandler, BuiltinCommandName, ZoomArgs, CenterArgs, SearchArgs, HighlightArgs, GroupArgs, } from './commands/index.js';
export { DragStateMachine } from './interaction/DragStateMachine.js';
export type { DragPhase, DragState } from './interaction/DragStateMachine.js';
export { ResizeStateMachine } from './interaction/ResizeStateMachine.js';
export type { ResizeHandle, ResizePhase, ResizeState } from './interaction/ResizeStateMachine.js';
export { MarqueeSelection } from './interaction/MarqueeSelection.js';
export type { MarqueePhase, MarqueeState } from './interaction/MarqueeSelection.js';
export { LassoSelection } from './interaction/LassoSelection.js';
export type { LassoPhase, LassoState } from './interaction/LassoSelection.js';
export { TouchGestures } from './interaction/TouchGestures.js';
export type { TouchPoint, TouchGestureState, PinchGesture, PanGesture, MultiTouchGesture } from './interaction/TouchGestures.js';
export { HoverManager } from './interaction/HoverManager.js';
export type { HoverTargetKind, HoverState } from './interaction/HoverManager.js';
export { ClickArbiter } from './interaction/ClickArbiter.js';
export type { ClickTargetKind, PointerDownEvent, ArbitratedClick, ClickArbiterOptions, PointerUpResult, } from './interaction/ClickArbiter.js';
export { FocusManager } from './interaction/FocusManager.js';
export type { FocusState } from './interaction/FocusManager.js';
export { SmartSelection } from './selection/SmartSelection.js';
export { SavedSelections } from './selection/SavedSelections.js';
export { Quadtree } from './spatial/Quadtree.js';
export type { QuadtreeEntry } from './spatial/Quadtree.js';
export { RTree } from './spatial/RTree.js';
export type { RTreeEntry } from './spatial/RTree.js';
export { SpatialIndex } from './spatial/SpatialIndex.js';
export type { SpatialBackend } from './spatial/SpatialIndex.js';
export { VirtualizationEngine } from './virtualization/VirtualizationEngine.js';
export type { LodLevel, VirtualizationOptions, Cluster, VirtualizationResult, VirtualizationDiff, } from './virtualization/VirtualizationEngine.js';
export { ConstraintEngine } from './constraints/ConstraintEngine.js';
export type { LockedAxis, AlignmentRule, DistributionRule, NodeConstraint, ConstraintViolation, } from './constraints/ConstraintEngine.js';
export { SnapEngine } from './snap/SnapEngine.js';
export type { GuideOrientation, GuideSource, SnapGuide, SnapResult, SnapOptions } from './snap/SnapEngine.js';
export { GraphGrouping } from './grouping/GraphGrouping.js';
export type { GroupKind } from './grouping/GraphGrouping.js';
export { computeLayoutTransition, layoutTransitionPositionAt, renderTransitionFrame, isLayoutTransitionComplete, } from './layout/transitions/LayoutTransition.js';
export type { LayoutTransitionResult } from './layout/transitions/LayoutTransition.js';
export { GraphCamera } from './camera/GraphCamera.js';
export { GraphCameraGroup } from './camera/GraphCameraGroup.js';
export { GraphPluginRegistry, installPlugin } from './plugins/GraphPluginRegistry.js';
export type { GraphPlugin, InstallTargets, AnimationFactory, SelectionBehavior, Exporter, Validator, ValidationIssue, Decorator, } from './plugins/GraphPluginRegistry.js';
export { GraphDiagnostics } from './diagnostics/GraphDiagnostics.js';
export type { TimingSample, RenderCostEstimate, MemoryEstimate, Hotspot, } from './diagnostics/GraphDiagnostics.js';
export { inspectGraph, inspectInteraction, inspectSelection, inspectLayout, inspectCamera, inspectPerformance, inspectAnimation, inspectHistory, } from './devtools/inspectors.js';
export type { GraphInspectorSnapshot, InteractionInspectorSnapshot, SelectionInspectorSnapshot, LayoutInspectorSnapshot, CameraInspectorSnapshot, PerformanceInspectorSnapshot, AnimationInspectorSnapshot, HistoryInspectorSnapshot, } from './devtools/inspectors.js';
export { Timeline, EventTimeline, CommandTimeline } from './devtools/Timeline.js';
export type { TimelineEntry, InteractionEventEntry, CommandEntry } from './devtools/Timeline.js';
//# sourceMappingURL=index.d.ts.map