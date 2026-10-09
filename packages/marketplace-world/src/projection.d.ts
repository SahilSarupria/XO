import type { MarketplaceWorld } from './types.js';
import type { SourceGraph } from './source-graph.js';
export interface ProjectionOptions {
    readonly area?: {
        readonly width: number;
        readonly height: number;
    };
    readonly iterations?: number;
}
/**
 * Project a SourceGraph into a MarketplaceWorld.
 *
 * Deterministic: the same SourceGraph (in any array order — every
 * internal collection is sorted before it can affect layout) always
 * produces an identical MarketplaceWorld, including identical
 * positions. See tests/determinism.test.ts.
 */
export declare function projectWorld(source: SourceGraph, options?: ProjectionOptions): MarketplaceWorld;
//# sourceMappingURL=projection.d.ts.map