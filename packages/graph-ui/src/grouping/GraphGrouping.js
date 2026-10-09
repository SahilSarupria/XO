const DEFAULT_NODE_SIZE = { width: 120, height: 40 };
/**
 * Pure helpers for working with NodeGroup, including nested groups (via
 * the additive, optional `parentGroupId` field), group transforms, and
 * "temporary"/"selection" groups that don't need to be committed to the
 * model at all. None of this touches rendering — a group is just data.
 */
export class GraphGrouping {
    /** Direct + transitive child groups of `groupId`, via parentGroupId chains. */
    static nestedChildren(model, groupId) {
        const result = [];
        const frontier = new Set([groupId]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const group of model.nodeGroups) {
                if (group.parentGroupId && frontier.has(group.parentGroupId) && !frontier.has(group.id)) {
                    frontier.add(group.id);
                    result.push(group);
                    grew = true;
                }
            }
        }
        return result;
    }
    /** All node ids belonging to a group and (recursively) its nested child groups. */
    static allMemberNodeIds(model, groupId) {
        const groupIds = new Set([groupId, ...GraphGrouping.nestedChildren(model, groupId).map((g) => g.id)]);
        const ids = new Set();
        for (const group of model.nodeGroups) {
            if (!groupIds.has(group.id))
                continue;
            for (const id of group.nodeIds)
                ids.add(id);
        }
        for (const node of model.nodes) {
            if (node.groupId && groupIds.has(node.groupId))
                ids.add(node.id);
        }
        return [...ids];
    }
    /** The bounding rect enclosing every member node of a group. */
    static bounds(model, groupId) {
        const ids = GraphGrouping.allMemberNodeIds(model, groupId);
        const rects = ids
            .map((id) => model.getNode(id))
            .filter((n) => !!n)
            .map((n) => {
            const size = n.size ?? DEFAULT_NODE_SIZE;
            return { x: n.position.x, y: n.position.y, width: size.width, height: size.height };
        });
        if (rects.length === 0)
            return undefined;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const r of rects) {
            minX = Math.min(minX, r.x);
            minY = Math.min(minY, r.y);
            maxX = Math.max(maxX, r.x + r.width);
            maxY = Math.max(maxY, r.y + r.height);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    static toggleCollapse(model, groupId) {
        const group = model.getNodeGroup(groupId);
        if (!group)
            return model;
        return model.upsertNodeGroup({ ...group, collapsed: !group.collapsed });
    }
    /** Turns the current selection into a persisted NodeGroup of the given kind (stored in group.metadata.kind — a plain, additive convention, not a new NodeGroup field). */
    static fromSelection(model, selection, groupId, label, kind = 'selection') {
        const nodeIds = [...selection.state.nodeIds];
        const metadata = { kind };
        return model.upsertNodeGroup({ id: groupId, label, nodeIds, metadata });
    }
    /** A temporary/ephemeral group: computed data only, never written into the model — useful for a transient "these nodes are being dragged together" grouping that shouldn't persist. */
    static temporary(nodeIds, label = 'Temporary Group') {
        return { id: `temp:${nodeIds.join(',')}`, label, nodeIds, metadata: { kind: 'temporary' } };
    }
    static kindOf(group) {
        const kind = group.metadata?.kind;
        return typeof kind === 'string' ? kind : undefined;
    }
    /** Translates every member node of a group by `delta`, returning a new model. */
    static translate(model, groupId, delta) {
        const ids = GraphGrouping.allMemberNodeIds(model, groupId);
        let next = model;
        for (const id of ids) {
            const node = next.getNode(id);
            if (!node)
                continue;
            next = next.upsertNode({ ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } });
        }
        return next;
    }
}
//# sourceMappingURL=GraphGrouping.js.map