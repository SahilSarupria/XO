import { SemanticZoomRegistry, type EmergenceState } from '@xo/atlas';
import type { MarketplaceWorld, XOId } from './types.js';
/**
 * The fields of an XO that emerge at different depths. Deliberately a
 * closed set matching the altitude model in altitude.ts — identity
 * appears shallow, capability and workflow appear mid-depth, and
 * reasoning/memory/execution (all still provisional; see altitude.ts)
 * appear deepest.
 */
export type MarketplaceField = 'identity' | 'capabilities' | 'workflows' | 'reasoning' | 'memory' | 'execution';
export interface MarketplaceEmergence {
    readonly xoId: XOId;
    readonly field: MarketplaceField;
    readonly visibility: number;
}
/**
 * Builds a SemanticZoomRegistry with one rule per (XO, field) pair,
 * reusing Atlas's registry directly rather than inventing a second
 * visibility system, per requirement 6.
 */
export declare function buildMarketplaceSemanticZoom(world: MarketplaceWorld): SemanticZoomRegistry<MarketplaceEmergence>;
/** Every field's emergence state for one XO at a given altitude. */
export declare function emergenceForXO(registry: SemanticZoomRegistry<MarketplaceEmergence>, xoId: XOId, altitude: number): EmergenceState<MarketplaceEmergence>[];
/** Every (XO, field) pair currently emerged at all, most visible
 * first \u2014 useful for a consumer deciding what to render this frame
 * without iterating every XO in the world. */
export declare function visibleFields(registry: SemanticZoomRegistry<MarketplaceEmergence>, altitude: number): EmergenceState<MarketplaceEmergence>[];
//# sourceMappingURL=semantic.d.ts.map