import type { GraphModel } from '../model/GraphModel.js';
import type { EdgeId, NodeId, Point } from '../model/types.js';
export type InteractionEventName = 'nodeClick' | 'nodeDoubleClick' | 'nodeHover' | 'nodeUnhover' | 'nodeDragStart' | 'nodeDrag' | 'nodeDragEnd' | 'edgeClick' | 'edgeHover' | 'boxSelectStart' | 'boxSelectEnd' | 'contextMenu' | 'keyboardNavigate';
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
    readonly rect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export interface ContextMenuEvent {
    readonly target: {
        kind: 'node' | 'edge' | 'canvas';
        id?: NodeId | EdgeId;
    };
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
    keyboardNavigate: {
        direction: KeyboardDirection;
        fromNodeId?: NodeId;
    };
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
export declare class GraphInteraction {
    private readonly listeners;
    nodeDragEnabled: boolean;
    constructor(options?: GraphInteractionOptions);
    on<K extends InteractionEventName>(name: K, listener: Listener<K>): () => void;
    off<K extends InteractionEventName>(name: K, listener: Listener<K>): void;
    emit<K extends InteractionEventName>(name: K, event: InteractionEventMap[K]): void;
    setNodeDragEnabled(enabled: boolean): void;
    /**
     * Given the currently focused node, find the neighbor most closely
     * aligned with `direction` (by position, not graph topology) — this is
     * what powers arrow-key navigation across the canvas.
     */
    static findNeighborInDirection(fromNodeId: NodeId, direction: KeyboardDirection, model: GraphModel): NodeId | undefined;
}
export {};
//# sourceMappingURL=GraphInteraction.d.ts.map