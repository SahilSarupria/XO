import type { GraphModel } from '../model/GraphModel.js';
import type { NodeId, Point } from '../model/types.js';
export type LockedAxis = 'x' | 'y' | 'both' | 'none';
export interface AlignmentRule {
    readonly kind: 'align';
    readonly axis: 'x' | 'y';
    readonly nodeIds: readonly NodeId[];
}
export interface DistributionRule {
    readonly kind: 'distribute';
    readonly axis: 'x' | 'y';
    readonly nodeIds: readonly NodeId[];
}
export interface NodeConstraint {
    readonly lockedAxis?: LockedAxis;
    readonly lockedPosition?: Point;
    readonly snapGroupId?: string;
    readonly minSpacing?: number;
    readonly parentId?: NodeId;
    readonly childIds?: readonly NodeId[];
    readonly gridSize?: number;
}
export interface ConstraintViolation {
    readonly nodeId: NodeId;
    readonly reason: string;
}
/**
 * Immutable registry of per-node declarative constraints
 * (locked axis/position, snap groups, minimum spacing, parent/child
 * relationships, per-node grid size) plus the pure resolution function
 * that reconciles a batch of proposed moves against them. Alignment and
 * distribution are expressed as one-shot rules rather than persistent
 * per-node constraints, since they describe a relationship between a set
 * of nodes at the moment they're invoked.
 */
export declare class ConstraintEngine {
    private readonly byNode;
    private constructor();
    static empty(): ConstraintEngine;
    setConstraint(nodeId: NodeId, constraint: NodeConstraint): ConstraintEngine;
    clearConstraint(nodeId: NodeId): ConstraintEngine;
    getConstraint(nodeId: NodeId): NodeConstraint | undefined;
    /** Resolves a batch of proposed node moves against every registered constraint: axis/position locks, per-node grid snapping, and — for nodes sharing a snapGroupId — a minimum-spacing pass along the dominant axis of movement. */
    resolve(model: GraphModel, proposedPositions: ReadonlyMap<NodeId, Point>): Map<NodeId, Point>;
    private enforceMinSpacing;
    /** Aligns the given nodes' positions along one axis to their shared mean — a pure computation returning new positions, not a mutation. */
    static align(model: GraphModel, rule: AlignmentRule): Map<NodeId, Point>;
    /** Distributes the given nodes evenly along one axis between their current min and max. */
    static distribute(model: GraphModel, rule: DistributionRule): Map<NodeId, Point>;
    /** Applies a resolved position map back onto a model, returning a new model. */
    static applyPositions(model: GraphModel, positions: ReadonlyMap<NodeId, Point>): GraphModel;
}
//# sourceMappingURL=ConstraintEngine.d.ts.map