import { GraphModel } from '../model/GraphModel.js';
/** Converts a package/dependency graph into a generic GraphModel. */
export const DependencyGraphAdapter = {
    kind: 'dependency-graph',
    toGraphModel(source) {
        const nodes = source.packages.map((p) => ({
            id: p.id,
            type: 'package',
            label: p.version ? `${p.label}@${p.version}` : p.label,
            position: { x: 0, y: 0 },
            ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
        }));
        const edges = source.dependencies.map((d) => ({
            id: d.id,
            type: 'depends_on',
            source: d.from,
            target: d.to,
            ...(d.versionRange !== undefined ? { label: d.versionRange } : {}),
            ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        }));
        return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
    },
};
//# sourceMappingURL=DependencyGraphAdapter.js.map