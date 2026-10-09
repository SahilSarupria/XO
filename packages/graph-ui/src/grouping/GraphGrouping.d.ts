import { GraphModel } from '../model/GraphModel.js';
import type { GraphSelection } from '../selection/GraphSelection.js';
import type { GroupId, NodeGroup, NodeId, Point, Rect } from '../model/types.js';
export type GroupKind = 'semantic' | 'visual' | 'bounding' | 'selection' | 'temporary';
/**
 * Pure helpers for working with NodeGroup, including nested groups (via
 * the additive, optional `parentGroupId` field), group transforms, and
 * "temporary"/"selection" groups that don't need to be committed to the
 * model at all. None of this touches rendering — a group is just data.
 */
export declare class GraphGrouping {
    /** Direct + transitive child groups of `groupId`, via parentGroupId chains. */
    static nestedChildren(model: GraphModel, groupId: GroupId): readonly NodeGroup[];
    /** All node ids belonging to a group and (recursively) its nested child groups. */
    static allMemberNodeIds(model: GraphModel, groupId: GroupId): readonly NodeId[];
    /** The bounding rect enclosing every member node of a group. */
    static bounds(model: GraphModel, groupId: GroupId): Rect | undefined;
    static toggleCollapse(model: GraphModel, groupId: GroupId): GraphModel;
    /** Turns the current selection into a persisted NodeGroup of the given kind (stored in group.metadata.kind — a plain, additive convention, not a new NodeGroup field). */
    static fromSelection(model: GraphModel, selection: GraphSelection, groupId: GroupId, label: string, kind?: GroupKind): GraphModel;
    /** A temporary/ephemeral group: computed data only, never written into the model — useful for a transient "these nodes are being dragged together" grouping that shouldn't persist. */
    static temporary(nodeIds: readonly NodeId[], label?: string): NodeGroup;
    static kindOf(group: NodeGroup): GroupKind | undefined;
    /** Translates every member node of a group by `delta`, returning a new model. */
    static translate(model: GraphModel, groupId: GroupId, delta: Point): GraphModel;
}
//# sourceMappingURL=GraphGrouping.d.ts.map