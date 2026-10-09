function stringifyValue(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value === null || value === undefined)
        return '';
    return JSON.stringify(value);
}
function propertyKindOf(value) {
    if (typeof value === 'number')
        return 'number';
    if (typeof value === 'boolean')
        return 'boolean';
    return 'text';
}
function metadataEntries(metadata) {
    if (!metadata)
        return [];
    return Object.entries(metadata).map(([key, value]) => ({
        key,
        label: key,
        value: stringifyValue(value),
    }));
}
function metadataPropertyGroup(metadata) {
    if (!metadata || Object.keys(metadata).length === 0)
        return undefined;
    const properties = Object.entries(metadata).map(([key, value]) => ({
        key,
        label: key,
        value: stringifyValue(value),
        kind: propertyKindOf(value),
    }));
    return { id: 'metadata', label: 'Metadata', properties };
}
/**
 * Pure builders that turn a GraphNode/GraphEdge into GraphInspectorData.
 * These only read what's already on the node/edge (id, type, label,
 * metadata) — no UI framework, no side effects.
 */
export class GraphInspector {
    static fromNode(node, options = {}) {
        const identity = {
            id: 'identity',
            label: 'Identity',
            properties: [
                { key: 'id', label: 'ID', value: node.id, kind: 'text' },
                { key: 'type', label: 'Type', value: node.type, kind: 'text' },
            ],
        };
        const metadataGroup = metadataPropertyGroup(node.metadata);
        return {
            targetKind: 'node',
            targetId: node.id,
            title: node.label,
            badges: options.badges ?? [],
            propertyGroups: metadataGroup ? [identity, metadataGroup] : [identity],
            metadataEntries: metadataEntries(node.metadata),
        };
    }
    static fromEdge(edge, options = {}) {
        const identity = {
            id: 'identity',
            label: 'Identity',
            properties: [
                { key: 'id', label: 'ID', value: edge.id, kind: 'text' },
                { key: 'type', label: 'Type', value: edge.type, kind: 'text' },
                { key: 'source', label: 'Source', value: edge.source, kind: 'text' },
                { key: 'target', label: 'Target', value: edge.target, kind: 'text' },
            ],
        };
        const metadataGroup = metadataPropertyGroup(edge.metadata);
        return {
            targetKind: 'edge',
            targetId: edge.id,
            title: edge.label ?? edge.id,
            badges: options.badges ?? [],
            propertyGroups: metadataGroup ? [identity, metadataGroup] : [identity],
            metadataEntries: metadataEntries(edge.metadata),
        };
    }
}
//# sourceMappingURL=GraphInspector.js.map