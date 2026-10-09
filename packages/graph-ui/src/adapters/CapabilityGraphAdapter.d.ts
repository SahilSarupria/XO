import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface CapabilityGraphCapability {
    readonly id: string;
    readonly label: string;
    readonly metadata?: GraphMetadata;
}
export interface CapabilityGraphAction {
    readonly id: string;
    readonly label: string;
    readonly capabilityId: string;
    readonly metadata?: GraphMetadata;
}
export interface CapabilityGraphSource {
    readonly capabilities: readonly CapabilityGraphCapability[];
    readonly actions: readonly CapabilityGraphAction[];
}
/** Converts capabilities-composed-of-actions into a generic GraphModel. */
export declare const CapabilityGraphAdapter: GraphAdapter<CapabilityGraphSource>;
//# sourceMappingURL=CapabilityGraphAdapter.d.ts.map