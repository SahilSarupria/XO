import type { GraphLayoutOptions, LayoutKind, NodeStyle } from '../model/types.js';
import { GraphTheme } from '../theme/GraphTheme.js';

/**
 * A preset is *only* a default layout choice + default per-node-type
 * styling. The rendering engine underneath stays fully generic — presets
 * never add behavior, they just pick sane defaults for a schema shape.
 */
export interface GraphPreset {
  readonly name: string;
  readonly defaultLayout: LayoutKind;
  readonly layoutOptions?: GraphLayoutOptions;
  readonly theme: GraphTheme;
  readonly nodeTypeStyles?: Readonly<Record<string, NodeStyle>>;
}

function themeWithNodeStyles(nodeTypeStyles: Record<string, NodeStyle>): GraphTheme {
  return GraphTheme.light().extend({ nodeTypeStyles });
}

export const KnowledgeGraphPreset: GraphPreset = {
  name: 'knowledge-graph',
  defaultLayout: 'force-directed',
  theme: themeWithNodeStyles({
    entity: { fill: '#dbeafe', stroke: '#3b82f6' },
    concept: { fill: '#ede9fe', stroke: '#8b5cf6' },
  }),
};

export const CapabilityGraphPreset: GraphPreset = {
  name: 'capability-graph',
  defaultLayout: 'hierarchical',
  layoutOptions: { direction: 'TB' },
  theme: themeWithNodeStyles({
    capability: { fill: '#dcfce7', stroke: '#22c55e' },
    action: { fill: '#fef9c3', stroke: '#eab308' },
  }),
};

export const IntentGraphPreset: GraphPreset = {
  name: 'intent-graph',
  defaultLayout: 'tree',
  theme: themeWithNodeStyles({
    intent: { fill: '#fae8ff', stroke: '#d946ef' },
    slot: { fill: '#e0e7ff', stroke: '#6366f1' },
  }),
};

export const WorkflowGraphPreset: GraphPreset = {
  name: 'workflow-graph',
  defaultLayout: 'hierarchical',
  layoutOptions: { direction: 'LR' },
  theme: themeWithNodeStyles({
    step: { fill: '#e0f2fe', stroke: '#0ea5e9' },
    decision: { fill: '#fff7ed', stroke: '#f97316' },
  }),
};

export const PermissionGraphPreset: GraphPreset = {
  name: 'permission-graph',
  defaultLayout: 'dag',
  theme: themeWithNodeStyles({
    role: { fill: '#fee2e2', stroke: '#ef4444' },
    resource: { fill: '#f1f5f9', stroke: '#64748b' },
  }),
};

export const DependencyGraphPreset: GraphPreset = {
  name: 'dependency-graph',
  defaultLayout: 'dag',
  layoutOptions: { direction: 'TB' },
  theme: themeWithNodeStyles({
    package: { fill: '#ecfccb', stroke: '#84cc16' },
  }),
};

export const ExecutionGraphPreset: GraphPreset = {
  name: 'execution-graph',
  defaultLayout: 'hierarchical',
  layoutOptions: { direction: 'LR' },
  theme: GraphTheme.light(),
};

export const DAGPreset: GraphPreset = {
  name: 'dag',
  defaultLayout: 'dag',
  theme: GraphTheme.light(),
};

export const TreePreset: GraphPreset = {
  name: 'tree',
  defaultLayout: 'tree',
  theme: GraphTheme.light(),
};

export const GeneralNetworkPreset: GraphPreset = {
  name: 'general-network',
  defaultLayout: 'force-directed',
  theme: GraphTheme.light(),
};

export const GraphPresets: Readonly<Record<string, GraphPreset>> = {
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
