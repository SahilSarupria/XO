export const circularLayout = {
    kind: 'circular',
    compute(model, options) {
        const n = model.nodeCount;
        const radius = options?.radius ?? Math.max(120, n * 24);
        const positions = model.nodes.map((node, i) => {
            const angle = (2 * Math.PI * i) / Math.max(1, n);
            return { id: node.id, position: { x: radius * Math.cos(angle), y: radius * Math.sin(angle) } };
        });
        return { kind: 'circular', positions };
    },
};
//# sourceMappingURL=circular.js.map