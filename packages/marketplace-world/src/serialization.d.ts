import type { Capability, Community, MarketplaceWorld, Publisher, Relationship, Workflow, XOEntity } from './types.js';
/**
 * A plain-JSON-safe form of MarketplaceWorld \u2014 Maps replaced with
 * sorted arrays so serialization is itself deterministic (two
 * projections of the same source graph serialize to byte-identical
 * JSON, not just structurally-equal objects).
 */
export interface SerializedWorld {
    readonly xos: readonly XOEntity[];
    readonly capabilities: readonly Capability[];
    readonly workflows: readonly Workflow[];
    readonly publishers: readonly Publisher[];
    readonly communities: readonly Community[];
    readonly relationships: readonly Relationship[];
    readonly positions: readonly {
        readonly xoId: string;
        readonly x: number;
        readonly y: number;
    }[];
}
export declare function serializeWorld(world: MarketplaceWorld): SerializedWorld;
export declare function deserializeWorld(data: SerializedWorld): MarketplaceWorld;
//# sourceMappingURL=serialization.d.ts.map