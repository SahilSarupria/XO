/** Pass-through layout: keeps each node's already-assigned position. */
export const manualLayout = {
    kind: 'manual',
    compute(model) {
        const positions = model.nodes.map((node) => ({ id: node.id, position: node.position }));
        return { kind: 'manual', positions };
    },
};
//# sourceMappingURL=manual.js.map