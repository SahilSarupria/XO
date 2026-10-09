import type { GraphModel } from '../model/GraphModel.js';
import type { EdgeId, NodeId, Point } from '../model/types.js';

export type InteractionEventName =
  | 'nodeClick'
  | 'nodeDoubleClick'
  | 'nodeHover'
  | 'nodeUnhover'
  | 'nodeDragStart'
  | 'nodeDrag'
  | 'nodeDragEnd'
  | 'edgeClick'
  | 'edgeHover'
  | 'boxSelectStart'
  | 'boxSelectEnd'
  | 'contextMenu'
  | 'keyboardNavigate';

export interface NodeInteractionEvent {
  readonly nodeId: NodeId;
  readonly position?: Point;
  readonly additive?: boolean;
}

export interface EdgeInteractionEvent {
  readonly edgeId: EdgeId;
  readonly additive?: boolean;
}

export interface BoxSelectEvent {
  readonly rect: { x: number; y: number; width: number; height: number };
}

export interface ContextMenuEvent {
  readonly target: { kind: 'node' | 'edge' | 'canvas'; id?: NodeId | EdgeId };
  readonly screenPoint: Point;
}

export type KeyboardDirection = 'up' | 'down' | 'left' | 'right';

export interface InteractionEventMap {
  nodeClick: NodeInteractionEvent;
  nodeDoubleClick: NodeInteractionEvent;
  nodeHover: NodeInteractionEvent;
  nodeUnhover: NodeInteractionEvent;
  nodeDragStart: NodeInteractionEvent;
  nodeDrag: NodeInteractionEvent;
  nodeDragEnd: NodeInteractionEvent;
  edgeClick: EdgeInteractionEvent;
  edgeHover: EdgeInteractionEvent;
  boxSelectStart: BoxSelectEvent;
  boxSelectEnd: BoxSelectEvent;
  contextMenu: ContextMenuEvent;
  keyboardNavigate: { direction: KeyboardDirection; fromNodeId?: NodeId };
}

type Listener<K extends InteractionEventName> = (event: InteractionEventMap[K]) => void;

export interface GraphInteractionOptions {
  readonly nodeDragEnabled?: boolean;
}

/**
 * Minimal, dependency-free event bus for pointer/keyboard interaction,
 * plus spatial-nearest-neighbor keyboard navigation. Adapters (DOM, React
 * Flow, ...) translate native browser events into calls on `emit`; host
 * applications subscribe with `on`.
 */
export class GraphInteraction {
  private readonly listeners = new Map<InteractionEventName, Set<Listener<InteractionEventName>>>();
  nodeDragEnabled: boolean;

  constructor(options: GraphInteractionOptions = {}) {
    this.nodeDragEnabled = options.nodeDragEnabled ?? false;
  }

  on<K extends InteractionEventName>(name: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener as Listener<InteractionEventName>);
    return () => this.off(name, listener);
  }

  off<K extends InteractionEventName>(name: K, listener: Listener<K>): void {
    this.listeners.get(name)?.delete(listener as Listener<InteractionEventName>);
  }

  emit<K extends InteractionEventName>(name: K, event: InteractionEventMap[K]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  setNodeDragEnabled(enabled: boolean): void {
    this.nodeDragEnabled = enabled;
  }

  /**
   * Given the currently focused node, find the neighbor most closely
   * aligned with `direction` (by position, not graph topology) — this is
   * what powers arrow-key navigation across the canvas.
   */
  static findNeighborInDirection(fromNodeId: NodeId, direction: KeyboardDirection, model: GraphModel): NodeId | undefined {
    const from = model.getNode(fromNodeId);
    if (!from) return undefined;
    let best: { id: NodeId; distance: number } | undefined;

    for (const node of model.nodes) {
      if (node.id === fromNodeId) continue;
      const dx = node.position.x - from.position.x;
      const dy = node.position.y - from.position.y;
      const aligned =
        (direction === 'right' && dx > 0 && Math.abs(dy) <= Math.abs(dx)) ||
        (direction === 'left' && dx < 0 && Math.abs(dy) <= Math.abs(dx)) ||
        (direction === 'down' && dy > 0 && Math.abs(dx) <= Math.abs(dy)) ||
        (direction === 'up' && dy < 0 && Math.abs(dx) <= Math.abs(dy));
      if (!aligned) continue;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (!best || distance < best.distance) best = { id: node.id, distance };
    }
    return best?.id;
  }
}
