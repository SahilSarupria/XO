import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface WorkflowGraphStep {
    readonly id: string;
    readonly label: string;
    readonly kind?: 'step' | 'decision';
    readonly metadata?: GraphMetadata;
}
export interface WorkflowGraphTransition {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly label?: string;
    readonly metadata?: GraphMetadata;
}
export interface WorkflowGraphSource {
    readonly steps: readonly WorkflowGraphStep[];
    readonly transitions: readonly WorkflowGraphTransition[];
}
/** Converts steps + transitions (with optional decision branches) into a generic GraphModel. */
export declare const WorkflowGraphAdapter: GraphAdapter<WorkflowGraphSource>;
//# sourceMappingURL=WorkflowGraphAdapter.d.ts.map