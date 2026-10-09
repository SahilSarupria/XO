export const gridLayout = {
    kind: 'grid',
    compute(model, options) {
        const spacingX = options?.spacingX ?? 180;
        const spacingY = options?.spacingY ?? 120;
        const columns = options?.columns ?? Math.max(1, Math.ceil(Math.sqrt(model.nodeCount)));
        const positions = model.nodes.map((node, i) => ({
            id: node.id,
            position: { x: (i % columns) * spacingX, y: Math.floor(i / columns) * spacingY },
        }));
        return { kind: 'grid', positions };
    },
};
//# sourceMappingURL=grid.js.map