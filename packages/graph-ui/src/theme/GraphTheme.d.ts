import type { EdgeStyle, ExecutionNodeStatus, GraphEdge, GraphNode, GraphThemeDefinition, NodeStyle } from '../model/types.js';
/**
 * GraphTheme resolves the effective style for a node/edge by cascading:
 * default -> type-specific -> execution-status -> hover -> selected.
 * Fully immutable; `custom` produces a new theme instance.
 */
export declare class GraphTheme {
    readonly definition: GraphThemeDefinition;
    constructor(definition?: GraphThemeDefinition);
    static light(): GraphTheme;
    static dark(): GraphTheme;
    static highContrast(): GraphTheme;
    static named(name: string): GraphTheme;
    static custom(definition: GraphThemeDefinition): GraphTheme;
    extend(overrides: Partial<GraphThemeDefinition>): GraphTheme;
    resolveNodeStyle(node: GraphNode, state?: {
        selected?: boolean;
        hovered?: boolean;
        executionStatus?: ExecutionNodeStatus;
    }): NodeStyle;
    resolveEdgeStyle(edge: GraphEdge, state?: {
        selected?: boolean;
        hovered?: boolean;
        animated?: boolean;
    }): EdgeStyle;
}
//# sourceMappingURL=GraphTheme.d.ts.map