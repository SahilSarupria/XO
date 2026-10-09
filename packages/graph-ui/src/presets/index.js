import { GraphTheme } from '../theme/GraphTheme.js';
function themeWithNodeStyles(nodeTypeStyles) {
    return GraphTheme.light().extend({ nodeTypeStyles });
}
export const KnowledgeGraphPreset = {
    name: 'knowledge-graph',
    defaultLayout: 'force-directed',
    theme: themeWithNodeStyles({
        entity: { fill: '#dbeafe', stroke: '#3b82f6' },
        concept: { fill: '#ede9fe', stroke: '#8b5cf6' },
    }),
};
export const CapabilityGraphPreset = {
    name: 'capability-graph',
    defaultLayout: 'hierarchical',
    layoutOptions: { direction: 'TB' },
    theme: themeWithNodeStyles({
        capability: { fill: '#dcfce7', stroke: '#22c55e' },
        action: { fill: '#fef9c3', stroke: '#eab308' },
    }),
};
export const IntentGraphPreset = {
    name: 'intent-graph',
    defaultLayout: 'tree',
    theme: themeWithNodeStyles({
        intent: { fill: '#fae8ff', stroke: '#d946ef' },
        slot: { fill: '#e0e7ff', stroke: '#6366f1' },
    }),
};
export const WorkflowGraphPreset = {
    name: 'workflow-graph',
    defaultLayout: 'hierarchical',
    layoutOptions: { direction: 'LR' },
    theme: themeWithNodeStyles({
        step: { fill: '#e0f2fe', stroke: '#0ea5e9' },
        decision: { fill: '#fff7ed', stroke: '#f97316' },
    }),
};
export const PermissionGraphPreset = {
    name: 'permission-graph',
    defaultLayout: 'dag',
    theme: themeWithNodeStyles({
        role: { fill: '#fee2e2', stroke: '#ef4444' },
        resource: { fill: '#f1f5f9', stroke: '#64748b' },
    }),
};
export const DependencyGraphPreset = {
    name: 'dependency-graph',
    defaultLayout: 'dag',
    layoutOptions: { direction: 'TB' },
    theme: themeWithNodeStyles({
        package: { fill: '#ecfccb', stroke: '#84cc16' },
    }),
};
export const ExecutionGraphPreset = {
    name: 'execution-graph',
    defaultLayout: 'hierarchical',
    layoutOptions: { direction: 'LR' },
    theme: GraphTheme.light(),
};
export const DAGPreset = {
    name: 'dag',
    defaultLayout: 'dag',
    theme: GraphTheme.light(),
};
export const TreePreset = {
    name: 'tree',
    defaultLayout: 'tree',
    theme: GraphTheme.light(),
};
export const GeneralNetworkPreset = {
    name: 'general-network',
    defaultLayout: 'force-directed',
    theme: GraphTheme.light(),
};
export const GraphPresets = {
    'knowledge-graph': KnowledgeGraphPreset,
    'capability-graph': CapabilityGraphPreset,
    'intent-graph': IntentGraphPreset,
    'workflow-graph': WorkflowGraphPreset,
    'permission-graph': PermissionGraphPreset,
    'dependency-graph': DependencyGraphPreset,
    'execution-graph': ExecutionGraphPreset,
    dag: DAGPreset,
    tree: TreePreset,
    'general-network': GeneralNetworkPreset,
};
//# sourceMappingURL=index.js.map