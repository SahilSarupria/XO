import type { Capability, CommunityId, MarketplaceWorld, Workflow, XOEntity, XOId } from './types.js';
/**
 * Marketplace-shaped answers to spatial questions, built entirely on
 * top of Atlas's domain-neutral NeighborhoodEngine \u2014 this module adds
 * no new spatial infrastructure, only vocabulary (requirement 8).
 */
export declare class MarketplaceNeighborhoods {
    private readonly engine;
    private readonly world;
    constructor(world: MarketplaceWorld);
    /** What is near this XO, closest first. */
    near(xoId: XOId, k?: number): XOEntity[];
    /** Every XO within a spatial radius of this one. */
    within(xoId: XOId, radius: number): XOEntity[];
    /** Every XO belonging to the given community/ecosystem. */
    ecosystemMembers(communityId: CommunityId): XOEntity[];
    /** The union of capabilities held by XOs spatially near this one \u2014
     * "what capabilities surround this experience". */
    capabilitiesSurrounding(xoId: XOId, radius?: number): Capability[];
    /** Workflows belonging to XOs directly related to this one (via any
     * relationship kind), independent of spatial distance \u2014 "what
     * related workflows exist". */
    relatedWorkflows(xoId: XOId): Workflow[];
    /** The nearest XO to an arbitrary point \u2014 "what is the nearest
     * relevant entity", e.g. for resolving where a camera currently is. */
    nearestTo(position: {
        x: number;
        y: number;
    }): XOEntity | null;
}
//# sourceMappingURL=neighborhoods.d.ts.map