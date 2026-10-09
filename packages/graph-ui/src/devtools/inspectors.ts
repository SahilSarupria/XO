import type { GraphModel } from '../model/GraphModel.js';
import type { GraphCamera } from '../camera/GraphCamera.js';
import type { GraphSelection } from '../selection/GraphSelection.js';
import type { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import type { HistoryStack } from '../history/HistoryStack.js';
import type { DragState } from '../interaction/DragStateMachine.js';
import type { ResizeState } from '../interaction/ResizeStateMachine.js';
import type { HoverState } from '../interaction/HoverManager.js';
import type { FocusState } from '../interaction/FocusManager.js';
import { GraphDiagnostics, type MemoryEstimate, type RenderCostEstimate } from '../diagnostics/GraphDiagnostics.js';
import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import type { GraphLayoutOptions, LayoutKind, NodeId } from '../model/types.js';

/**
 * Developer-tool "inspector" data models: each function is a pure snapshot
 * builder that reads already-public state from the corresponding engine
 * and returns a plain, JSON-serializable object. None of these render
 * anything — a host devtools panel (in Studio or elsewhere) is
 * responsible for actually displaying them.
 */

export interface GraphInspectorSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly groupCount: number;
  readonly nodeTypeCounts: Readonly<Record<string, number>>;
  readonly edgeTypeCounts: Readonly<Record<string, number>>;
}

export function inspectGraph(model: GraphModel): GraphInspectorSnapshot {
  const nodeTypeCounts: Record<string, number> = {};
  for (const node of model.nodes) nodeTypeCounts[node.type] = (nodeTypeCounts[node.type] ?? 0) + 1;
  const edgeTypeCounts: Record<string, number> = {};
  for (const edge of model.edges) edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1;
  return { nodeCount: model.nodeCount, edgeCount: model.edgeCount, groupCount: model.nodeGroups.length, nodeTypeCounts, edgeTypeCounts };
}

export interface InteractionInspectorSnapshot {
  readonly drag: DragState;
  readonly resize: ResizeState;
  readonly hover: HoverState;
  readonly focus: FocusState;
}

export function inspectInteraction(drag: DragState, resize: ResizeState, hover: HoverState, focus: FocusState): InteractionInspectorSnapshot {
  return { drag, resize, hover, focus };
}

export interface SelectionInspectorSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly groupCount: number;
  readonly sampleNodeIds: readonly NodeId[];
}

export function inspectSelection(selection: GraphSelection, sampleSize = 10): SelectionInspectorSnapshot {
  return {
    nodeCount: selection.state.nodeIds.size,
    edgeCount: selection.state.edgeIds.size,
    groupCount: selection.state.groupIds.size,
    sampleNodeIds: [...selection.state.nodeIds].slice(0, sampleSize),
  };
}

export interface LayoutInspectorSnapshot {
  readonly availableKinds: readonly string[];
  readonly lastComputed?: { readonly kind: LayoutKind | string; readonly options?: GraphLayoutOptions; readonly ms: number };
}

export function inspectLayout(availableKinds: readonly string[], lastComputed?: LayoutInspectorSnapshot['lastComputed']): LayoutInspectorSnapshot {
  return lastComputed !== undefined ? { availableKinds, lastComputed } : { availableKinds };
}

export interface CameraInspectorSnapshot {
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly bookmarkNames: readonly string[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function inspectCamera(camera: GraphCamera): CameraInspectorSnapshot {
  return { viewport: camera.viewport.state, bookmarkNames: camera.bookmarkNames, canUndo: camera.canUndo, canRedo: camera.canRedo };
}

export interface PerformanceInspectorSnapshot {
  readonly renderCost: RenderCostEstimate;
  readonly memory: MemoryEstimate;
  readonly recommendations: readonly string[];
}

export function inspectPerformance(model: GraphModel, frame: Pick<RenderFrame, 'nodes' | 'edges'>, activeLayoutKind?: string): PerformanceInspectorSnapshot {
  const renderCost = GraphDiagnostics.estimateRenderCost(frame);
  const memory = GraphDiagnostics.estimateMemory(model);
  const recommendations = GraphDiagnostics.recommendations({
    nodeCount: model.nodeCount,
    edgeCount: model.edgeCount,
    ...(activeLayoutKind !== undefined ? { activeLayoutKind } : {}),
  });
  return { renderCost, memory, recommendations };
}

export interface AnimationInspectorSnapshot {
  readonly activeIds: readonly string[];
  readonly count: number;
}

export function inspectAnimation(engine: GraphAnimationEngine): AnimationInspectorSnapshot {
  return { activeIds: engine.activeIds, count: engine.size };
}

export interface HistoryInspectorSnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly pastLength: number;
  readonly futureLength: number;
}

export function inspectHistory<T>(history: HistoryStack<T>): HistoryInspectorSnapshot {
  return { canUndo: history.canUndo, canRedo: history.canRedo, pastLength: history.past.length, futureLength: history.future.length };
}
