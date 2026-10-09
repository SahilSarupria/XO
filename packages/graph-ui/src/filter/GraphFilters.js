import { GraphModel } from '../model/GraphModel.js';
/**
 * GraphFilters computes a *derived* visible GraphModel from a base model +
 * filter predicates. The base model is never mutated; filtering is a pure
 * projection applied at render/query time.
 */
export class GraphFilters {
    state;
    constructor(state = {}) {
        this.state = state;
    }
    static empty() {
        return new GraphFilters();
    }
    withNodeTypes(types) {
        return new GraphFilters({ ...this.state, nodeTypes: new Set(types) });
    }
    withEdgeTypes(types) {
        return new GraphFilters({ ...this.state, edgeTypes: new Set(types) });
    }
    withLabelQuery(query) {
        return new GraphFilters({ ...this.state, labelQuery: query });
    }
    withMetadataPredicate(predicate) {
        return new GraphFilters({ ...this.state, metadataPredicate: predicate });
    }
    withHiddenNodes(ids) {
        return new GraphFilters({ ...this.state, hiddenNodeIds: new Set(ids) });
    }
    withHiddenEdges(ids) {
        return new GraphFilters({ ...this.state, hiddenEdgeIds: new Set(ids) });
    }
    withCollapsedGroups(ids) {
        return new GraphFilters({ ...this.state, collapsedGroupIds: new Set(ids) });
    }
    clear() {
        return GraphFilters.empty();
    }
    nodePasses(node) {
        const { nodeTypes, labelQuery, metadataPredicate, hiddenNodeIds, collapsedGroupIds } = this.state;
        if (node.hidden)
            return false;
        if (hiddenNodeIds?.has(node.id))
            return false;
        if (nodeTypes && nodeTypes.size > 0 && !nodeTypes.has(node.type))
            return false;
        if (labelQuery && !node.label.toLowerCase().includes(labelQuery.toLowerCase()))
            return false;
        if (metadataPredicate && !metadataPredicate(node.metadata))
            return false;
        if (collapsedGroupIds && node.groupId && collapsedGroupIds.has(node.groupId))
            return false;
        return true;
    }
    /** Apply this filter set to a model, returning a new, smaller GraphModel. */
    apply(model) {
        const { edgeTypes, hiddenEdgeIds } = this.state;
        const visibleNodes = model.nodes.filter((n) => this.nodePasses(n));
        const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
        const visibleEdges = model.edges.filter((e) => {
            if (e.hidden)
                return false;
            if (hiddenEdgeIds?.has(e.id))
                return false;
            if (edgeTypes && edgeTypes.size > 0 && !edgeTypes.has(e.type))
                return false;
            return visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target);
        });
        return new GraphModel({
            nodes: visibleNodes,
            edges: visibleEdges,
            nodeGroups: model.nodeGroups,
            edgeGroups: model.edgeGroups,
        });
    }
}
//# sourceMappingURL=GraphFilters.js.map