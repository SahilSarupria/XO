const lightTheme = {
    name: 'light',
    background: '#ffffff',
    defaultNodeStyle: { fill: '#f4f4f5', stroke: '#a1a1aa', strokeWidth: 1, textColor: '#18181b', radius: 6 },
    defaultEdgeStyle: { stroke: '#a1a1aa', strokeWidth: 1.5, arrow: true },
    selectionStyle: {
        node: { stroke: '#2563eb', strokeWidth: 2.5 },
        edge: { stroke: '#2563eb', strokeWidth: 2.5 },
    },
    hoverStyle: {
        node: { stroke: '#71717a', strokeWidth: 2 },
        edge: { stroke: '#71717a', strokeWidth: 2 },
    },
    executionStyles: {
        pending: { fill: '#f4f4f5', stroke: '#a1a1aa' },
        active: { fill: '#fef9c3', stroke: '#eab308', strokeWidth: 2.5 },
        completed: { fill: '#dcfce7', stroke: '#22c55e' },
        failed: { fill: '#fee2e2', stroke: '#ef4444', strokeWidth: 2.5 },
    },
};
const darkTheme = {
    name: 'dark',
    background: '#18181b',
    defaultNodeStyle: { fill: '#27272a', stroke: '#52525b', strokeWidth: 1, textColor: '#fafafa', radius: 6 },
    defaultEdgeStyle: { stroke: '#52525b', strokeWidth: 1.5, arrow: true },
    selectionStyle: {
        node: { stroke: '#60a5fa', strokeWidth: 2.5 },
        edge: { stroke: '#60a5fa', strokeWidth: 2.5 },
    },
    hoverStyle: {
        node: { stroke: '#a1a1aa', strokeWidth: 2 },
        edge: { stroke: '#a1a1aa', strokeWidth: 2 },
    },
    executionStyles: {
        pending: { fill: '#27272a', stroke: '#52525b' },
        active: { fill: '#422006', stroke: '#facc15', strokeWidth: 2.5 },
        completed: { fill: '#052e16', stroke: '#4ade80' },
        failed: { fill: '#450a0a', stroke: '#f87171', strokeWidth: 2.5 },
    },
};
const highContrastTheme = {
    name: 'high-contrast',
    background: '#000000',
    defaultNodeStyle: { fill: '#000000', stroke: '#ffffff', strokeWidth: 2, textColor: '#ffffff', radius: 4 },
    defaultEdgeStyle: { stroke: '#ffffff', strokeWidth: 2, arrow: true },
    selectionStyle: {
        node: { stroke: '#ffff00', strokeWidth: 3 },
        edge: { stroke: '#ffff00', strokeWidth: 3 },
    },
    hoverStyle: {
        node: { stroke: '#00ffff', strokeWidth: 3 },
        edge: { stroke: '#00ffff', strokeWidth: 3 },
    },
    executionStyles: {
        pending: { fill: '#000000', stroke: '#ffffff' },
        active: { fill: '#000000', stroke: '#ffff00', strokeWidth: 3 },
        completed: { fill: '#000000', stroke: '#00ff00', strokeWidth: 3 },
        failed: { fill: '#000000', stroke: '#ff0000', strokeWidth: 3 },
    },
};
const BUILTIN_THEMES = {
    light: lightTheme,
    dark: darkTheme,
    'high-contrast': highContrastTheme,
};
function mergeStyle(...styles) {
    return Object.assign({}, ...styles.filter(Boolean));
}
/**
 * GraphTheme resolves the effective style for a node/edge by cascading:
 * default -> type-specific -> execution-status -> hover -> selected.
 * Fully immutable; `custom` produces a new theme instance.
 */
export class GraphTheme {
    definition;
    constructor(definition = lightTheme) {
        this.definition = definition;
    }
    static light() {
        return new GraphTheme(lightTheme);
    }
    static dark() {
        return new GraphTheme(darkTheme);
    }
    static highContrast() {
        return new GraphTheme(highContrastTheme);
    }
    static named(name) {
        const def = BUILTIN_THEMES[name];
        if (!def)
            throw new Error(`Unknown built-in theme: "${name}". Available: ${Object.keys(BUILTIN_THEMES).join(', ')}`);
        return new GraphTheme(def);
    }
    static custom(definition) {
        return new GraphTheme(definition);
    }
    extend(overrides) {
        return new GraphTheme({ ...this.definition, ...overrides, name: overrides.name ?? `${this.definition.name}-custom` });
    }
    resolveNodeStyle(node, state = {}) {
        const d = this.definition;
        return mergeStyle(d.defaultNodeStyle, d.nodeTypeStyles?.[node.type], state.executionStatus ? d.executionStyles?.[state.executionStatus] : undefined, state.hovered ? d.hoverStyle.node : undefined, state.selected ? d.selectionStyle.node : undefined);
    }
    resolveEdgeStyle(edge, state = {}) {
        const d = this.definition;
        return mergeStyle(d.defaultEdgeStyle, d.edgeTypeStyles?.[edge.type], state.animated ? { animated: true } : undefined, state.hovered ? d.hoverStyle.edge : undefined, state.selected ? d.selectionStyle.edge : undefined);
    }
}
//# sourceMappingURL=GraphTheme.js.map