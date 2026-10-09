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
export declare const KnowledgeGraphPreset: GraphPreset;
export declare const CapabilityGraphPreset: GraphPreset;
export declare const IntentGraphPreset: GraphPreset;
export declare const WorkflowGraphPreset: GraphPreset;
export declare const PermissionGraphPreset: GraphPreset;
export declare const DependencyGraphPreset: GraphPreset;
export declare const ExecutionGraphPreset: GraphPreset;
export declare const DAGPreset: GraphPreset;
export declare const TreePreset: GraphPreset;
export declare const GeneralNetworkPreset: GraphPreset;
export declare const GraphPresets: Readonly<Record<string, GraphPreset>>;
//# sourceMappingURL=index.d.ts.map