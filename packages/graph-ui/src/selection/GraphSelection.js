const EMPTY_STATE = {
    nodeIds: new Set(),
    edgeIds: new Set(),
    groupIds: new Set(),
};
/**
 * Immutable selection set supporting single, multi, and box selection.
 */
export class GraphSelection {
    state;
    constructor(state = EMPTY_STATE) {
        this.state = state;
    }
    static empty() {
        return new GraphSelection();
    }
    get isEmpty() {
        return this.state.nodeIds.size === 0 && this.state.edgeIds.size === 0 && this.state.groupIds.size === 0;
    }
    hasNode(id) {
        return this.state.nodeIds.has(id);
    }
    hasEdge(id) {
        return this.state.edgeIds.has(id);
    }
    selectNode(id, options = {}) {
        if (options.additive) {
            return new GraphSelection({ ...this.state, nodeIds: new Set([...this.state.nodeIds, id]) });
        }
        return new GraphSelection({ nodeIds: new Set([id]), edgeIds: new Set(), groupIds: new Set() });
    }
    selectNodes(ids, options = {}) {
        const base = options.additive ? this.state.nodeIds : new Set();
        return new GraphSelection({
            nodeIds: new Set([...base, ...ids]),
            edgeIds: options.additive ? this.state.edgeIds : new Set(),
            groupIds: options.additive ? this.state.groupIds : new Set(),
        });
    }
    selectEdge(id, options = {}) {
        if (options.additive) {
            return new GraphSelection({ ...this.state, edgeIds: new Set([...this.state.edgeIds, id]) });
        }
        return new GraphSelection({ nodeIds: new Set(), edgeIds: new Set([id]), groupIds: new Set() });
    }
    toggleNode(id) {
        const nodeIds = new Set(this.state.nodeIds);
        if (nodeIds.has(id))
            nodeIds.delete(id);
        else
            nodeIds.add(id);
        return new GraphSelection({ ...this.state, nodeIds });
    }
    toggleEdge(id) {
        const edgeIds = new Set(this.state.edgeIds);
        if (edgeIds.has(id))
            edgeIds.delete(id);
        else
            edgeIds.add(id);
        return new GraphSelection({ ...this.state, edgeIds });
    }
    selectGroup(id, options = {}) {
        if (options.additive) {
            return new GraphSelection({ ...this.state, groupIds: new Set([...this.state.groupIds, id]) });
        }
        return new GraphSelection({ nodeIds: new Set(), edgeIds: new Set(), groupIds: new Set([id]) });
    }
    deselectNode(id) {
        const nodeIds = new Set(this.state.nodeIds);
        nodeIds.delete(id);
        return new GraphSelection({ ...this.state, nodeIds });
    }
    clear() {
        return GraphSelection.empty();
    }
    /** Select every node whose position+size rect intersects `rect` (box/rubber-band selection). */
    static fromBox(rect, model) {
        const nodeIds = [];
        for (const node of model.nodes) {
            const size = node.size ?? { width: 120, height: 40 };
            const intersects = node.position.x < rect.x + rect.width &&
                node.position.x + size.width > rect.x &&
                node.position.y < rect.y + rect.height &&
                node.position.y + size.height > rect.y;
            if (intersects)
                nodeIds.push(node.id);
        }
        return new GraphSelection({ nodeIds: new Set(nodeIds), edgeIds: new Set(), groupIds: new Set() });
    }
}
//# sourceMappingURL=GraphSelection.js.map