import { HistoryStack } from './HistoryStack.js';
import type { GraphSelectionState, GraphViewportState, NodeId } from '../model/types.js';

/** Undo/redo over viewport states (pan/zoom history). */
export type ViewportHistory = HistoryStack<GraphViewportState>;

/** Undo/redo over selection states. */
export type SelectionHistory = HistoryStack<GraphSelectionState>;

/** A single navigation "stop" — the viewport at the time, and what (if anything) it was centered on. */
export interface NavigationEntry {
  readonly viewport: GraphViewportState;
  readonly targetNodeId?: NodeId;
  readonly label?: string;
}

/** Back/forward navigation history (like browser history, but for viewport position). */
export type NavigationHistory = HistoryStack<NavigationEntry>;

export function createViewportHistory(initial: GraphViewportState): ViewportHistory {
  return HistoryStack.init(initial);
}

export function createSelectionHistory(initial: GraphSelectionState): SelectionHistory {
  return HistoryStack.init(initial);
}

export function createNavigationHistory(initial: NavigationEntry): NavigationHistory {
  return HistoryStack.init(initial);
}
