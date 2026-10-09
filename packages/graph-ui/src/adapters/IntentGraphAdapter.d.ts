import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface IntentGraphIntent {
    readonly id: string;
    readonly label: string;
    readonly metadata?: GraphMetadata;
}
export interface IntentGraphSlot {
    readonly id: string;
    readonly label: string;
    readonly intentId: string;
    readonly required?: boolean;
    readonly metadata?: GraphMetadata;
}
export interface IntentGraphSource {
    readonly intents: readonly IntentGraphIntent[];
    readonly slots: readonly IntentGraphSlot[];
}
/** Converts intents-with-slots into a generic GraphModel. */
export declare const IntentGraphAdapter: GraphAdapter<IntentGraphSource>;
//# sourceMappingURL=IntentGraphAdapter.d.ts.map