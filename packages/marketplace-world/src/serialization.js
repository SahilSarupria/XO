export function serializeWorld(world) {
    return {
        xos: sortedBy([...world.xos.values()], (x) => x.id),
        capabilities: sortedBy([...world.capabilities.values()], (c) => c.id),
        workflows: sortedBy([...world.workflows.values()], (w) => w.id),
        publishers: sortedBy([...world.publishers.values()], (p) => p.id),
        communities: sortedBy([...world.communities.values()], (c) => c.id),
        relationships: [...world.relationships],
        positions: sortedBy([...world.positions.entries()].map(([xoId, p]) => ({ xoId, x: p.x, y: p.y })), (p) => p.xoId),
    };
}
export function deserializeWorld(data) {
    return {
        xos: new Map(data.xos.map((x) => [x.id, x])),
        capabilities: new Map(data.capabilities.map((c) => [c.id, c])),
        workflows: new Map(data.workflows.map((w) => [w.id, w])),
        publishers: new Map(data.publishers.map((p) => [p.id, p])),
        communities: new Map(data.communities.map((c) => [c.id, c])),
        relationships: [...data.relationships],
        positions: new Map(data.positions.map((p) => [p.xoId, { x: p.x, y: p.y }])),
    };
}
function sortedBy(items, key) {
    return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}
//# sourceMappingURL=serialization.js.map