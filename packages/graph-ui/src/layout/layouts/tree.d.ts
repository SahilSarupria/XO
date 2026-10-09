import type { LayoutEngine } from '../types.js';
/**
 * Classic tree layout: each subtree gets a contiguous horizontal band, a
 * node is centered above its children. Implemented iteratively (BFS down,
 * then a single reverse pass back up) rather than recursively, so it stays
 * stack-safe on very deep trees / long chains at the 100,000+ node scale —
 * a naive recursive DFS would blow the call stack on a linear chain that
 * long.
 */
export declare const treeLayout: LayoutEngine;
//# sourceMappingURL=tree.d.ts.map