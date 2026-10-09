/**
 * Classic tree layout: each subtree gets a contiguous horizontal band, a
 * node is centered above its children. Implemented iteratively (BFS down,
 * then a single reverse pass back up) rather than recursively, so it stays
 * stack-safe on very deep trees / long chains at the 100,000+ node scale —
 * a naive recursive DFS would blow the call stack on a linear chain that
 * long.
 */
export const treeLayout = {
    kind: 'tree',
    compute(model, options) {
        const spacingX = options?.spacingX ?? 160;
        const spacingY = options?.spacingY ?? 120;
        const children = new Map();
        const hasParent = new Set();
        for (const edge of model.edges) {
            if (!children.has(edge.source))
                children.set(edge.source, []);
            children.get(edge.source).push(edge.target);
            hasParent.add(edge.target);
        }
        const roots = options?.seed
            ? [options.seed]
            : model.nodes.map((n) => n.id).filter((id) => !hasParent.has(id));
        if (roots.length === 0 && model.nodeCount > 0)
            roots.push(model.nodes[0].id);
        // Pass 1: BFS from the roots (iterative — safe at any depth) to assign
        // each reachable node a single BFS-tree parent + depth, in level order.
        const parent = new Map();
        const depth = new Map();
        const order = [];
        const visited = new Set();
        const queue = [];
        for (const root of roots) {
            if (visited.has(root))
                continue;
            visited.add(root);
            depth.set(root, 0);
            queue.push(root);
        }
        let qi = 0;
        while (qi < queue.length) {
            const id = queue[qi++];
            order.push(id);
            for (const child of children.get(id) ?? []) {
                if (visited.has(child))
                    continue;
                visited.add(child);
                parent.set(child, id);
                depth.set(child, (depth.get(id) ?? 0) + 1);
                queue.push(child);
            }
        }
        // Disconnected nodes unreachable from any root still need a position —
        // treat each as its own depth-0 root, appended after the main pass.
        for (const node of model.nodes) {
            if (visited.has(node.id))
                continue;
            visited.add(node.id);
            depth.set(node.id, 0);
            order.push(node.id);
        }
        // Pass 2: process nodes in reverse BFS order (deepest level first).
        // BFS visits by non-decreasing depth, so every node's children (depth+1)
        // appear later in `order` than the node itself — meaning in the
        // reversed order, children are always processed before their parent.
        // That gives us the same "center over children" result as a recursive
        // post-order DFS, without recursion.
        const xOf = new Map();
        let nextLeafSlot = 0;
        for (let i = order.length - 1; i >= 0; i--) {
            const id = order[i];
            const kids = (children.get(id) ?? []).filter((c) => parent.get(c) === id);
            if (kids.length === 0) {
                xOf.set(id, nextLeafSlot++);
            }
            else {
                const sum = kids.reduce((acc, c) => acc + (xOf.get(c) ?? 0), 0);
                xOf.set(id, sum / kids.length);
            }
        }
        const positions = order.map((id) => ({
            id,
            position: { x: (xOf.get(id) ?? 0) * spacingX, y: (depth.get(id) ?? 0) * spacingY },
        }));
        return { kind: 'tree', positions };
    },
};
//# sourceMappingURL=tree.js.map