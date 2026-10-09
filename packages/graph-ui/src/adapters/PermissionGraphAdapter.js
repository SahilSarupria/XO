import { GraphModel } from '../model/GraphModel.js';
/** Converts roles/resources/grants into a generic GraphModel. */
export const PermissionGraphAdapter = {
    kind: 'permission-graph',
    toGraphModel(source) {
        const roleNodes = source.roles.map((r) => ({
            id: r.id,
            type: 'role',
            label: r.label,
            position: { x: 0, y: 0 },
            ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
        }));
        const resourceNodes = source.resources.map((r) => ({
            id: r.id,
            type: 'resource',
            label: r.label,
            position: { x: 0, y: 0 },
            ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
        }));
        const edges = source.grants.map((g) => ({
            id: g.id,
            type: g.action ?? 'grants',
            source: g.roleId,
            target: g.resourceId,
            ...(g.metadata !== undefined ? { metadata: g.metadata } : {}),
        }));
        return GraphModel.empty().upsertNodes(roleNodes).upsertNodes(resourceNodes).upsertEdges(edges);
    },
};
//# sourceMappingURL=PermissionGraphAdapter.js.map