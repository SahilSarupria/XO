import type { GraphModel } from '../model/GraphModel.js';
import type { EdgeId, GraphSelectionState, GroupId, NodeId, Rect } from '../model/types.js';
/**
 * Immutable selection set supporting single, multi, and box selection.
 */
export declare class GraphSelection {
    readonly state: GraphSelectionState;
    constructor(state?: GraphSelectionState);
    static empty(): GraphSelection;
    get isEmpty(): boolean;
    hasNode(id: NodeId): boolean;
    hasEdge(id: EdgeId): boolean;
    selectNode(id: NodeId, options?: {
        additive?: boolean;
    }): GraphSelection;
    selectNodes(ids: readonly NodeId[], options?: {
        additive?: boolean;
    }): GraphSelection;
    selectEdge(id: EdgeId, options?: {
        additive?: boolean;
    }): GraphSelection;
    toggleNode(id: NodeId): GraphSelection;
    toggleEdge(id: EdgeId): GraphSelection;
    selectGroup(id: GroupId, options?: {
        additive?: boolean;
    }): GraphSelection;
    deselectNode(id: NodeId): GraphSelection;
    clear(): GraphSelection;
    /** Select every node whose position+size rect intersects `rect` (box/rubber-band selection). */
    static fromBox(rect: Rect, model: GraphModel): GraphSelection;
}
//# sourceMappingURL=GraphSelection.d.ts.map