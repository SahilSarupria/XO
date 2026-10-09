import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from './GraphSelection.js';
import type { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { GroupId, NodeId } from '../model/types.js';
/**
 * Graph-aware selection algorithms layered on top of GraphSelection +
 * GraphModel connectivity. Every function here is pure: (model, ...) ->
 * new GraphSelection (or NodeId[]) — nothing is mutated, and there's no
 * hidden traversal state carried between calls.
 */
export declare class SmartSelection {
    /** All nodes reachable from `seedId` ignoring edge direction (the connected component containing it). */
    static connectedComponent(model: GraphModel, seedId: NodeId): readonly NodeId[];
    /** All nodes that can reach `seedId` by following edges forward (ancestors — "what feeds into this"). */
    static upstream(model: GraphModel, seedId: NodeId): readonly NodeId[];
    /** All nodes reachable forward from `seedId` (descendants — "what this feeds into"). Also serves as the dependency chain / downstream impact set. */
    static downstream(model: GraphModel, seedId: NodeId): readonly NodeId[];
    /** Alias of downstream — the set of nodes that transitively depend on `seedId`. */
    static dependencyChain(model: GraphModel, seedId: NodeId): readonly NodeId[];
    /** The nodes on a GraphExecutionState's recorded execution path, in traversal order. */
    static executionPath(execution: GraphExecutionState): readonly NodeId[];
    /** All descendants of a group (its direct members plus, if `nested` groups reference it via parentGroupId, their members too). */
    static hierarchy(model: GraphModel, groupId: GroupId): readonly NodeId[];
    /** All members of a single group (flat, no nesting). */
    static group(model: GraphModel, groupId: GroupId): readonly NodeId[];
    /** Range selection between two nodes, using the model's deterministic node order (like shift-click in a list). */
    static range(model: GraphModel, fromId: NodeId, toId: NodeId): readonly NodeId[];
    /** Every visible node NOT currently selected. */
    static invert(model: GraphModel, selection: GraphSelection): GraphSelection;
    /** Grows the selection by one hop: adds every direct neighbor of every currently-selected node. */
    static expand(model: GraphModel, selection: GraphSelection): GraphSelection;
    /** Shrinks the selection to only nodes all of whose neighbors are also selected (the "interior" of the current selection). */
    static contract(model: GraphModel, selection: GraphSelection): GraphSelection;
}
//# sourceMappingURL=SmartSelection.d.ts.map