function toStyle(style) {
    return {
        background: style.fill,
        borderColor: style.stroke,
        borderWidth: style.strokeWidth,
        color: style.textColor,
    };
}
/**
 * Creates a GraphRenderAdapter that drives an externally-owned React Flow
 * instance via dependency-injected setter functions. graph-ui itself never
 * imports React or React Flow — the host application wires its own
 * `useNodesState`/`useEdgesState` setters in and hands them here. This is
 * how graph-ui stays framework-agnostic while still supporting React Flow
 * as one interchangeable rendering backend among several.
 */
export function createReactFlowAdapter(bindings) {
    return {
        name: 'react-flow',
        render(frame) {
            bindings.setNodes(frame.nodes.map((n) => ({
                id: n.node.id,
                position: n.node.position,
                data: { label: n.node.label },
                style: toStyle(n.style),
                selected: n.selected,
            })));
            bindings.setEdges(frame.edges.map((e) => ({
                id: e.edge.id,
                source: e.edge.source,
                target: e.edge.target,
                ...(e.edge.label !== undefined ? { label: e.edge.label } : {}),
                ...(e.style.animated !== undefined ? { animated: e.style.animated } : {}),
                style: { stroke: e.style.stroke, strokeWidth: e.style.strokeWidth },
                selected: e.selected,
            })));
        },
    };
}
//# sourceMappingURL=ReactFlowAdapter.js.map