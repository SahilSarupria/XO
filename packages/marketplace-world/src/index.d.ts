/**
 * @xo/marketplace-world
 *
 * Translates the actual XO ecosystem into Atlas's spatial model.
 * Sits above @xo/atlas (generic interaction engine) and below the
 * marketplace UI. See README.md for the data flow, the positioning
 * algorithm, and what this package assumes doesn't exist yet in the
 * repository (a real graph-engine/XOIR/runtime).
 */
export type { XOId, CapabilityId, WorkflowId, PublisherId, CommunityId, MarketplaceMetadata, InstallState, Publisher, Capability, Workflow, Community, RelationshipKind, Relationship, XOEntity, MarketplaceWorld, } from './types.js';
export type { SourceGraph, SourceXO, SourceRelationship, SourcePublisher, SourceCapability, SourceWorkflow, SourceCommunity, } from './source-graph.js';
export { projectWorld, type ProjectionOptions } from './projection.js';
export { MARKETPLACE_ALTITUDE_LEVELS, createMarketplaceAltitudeModel } from './altitude.js';
export { buildMarketplaceSemanticZoom, emergenceForXO, visibleFields, type MarketplaceField, type MarketplaceEmergence, } from './semantic.js';
export { MarketplaceNeighborhoods } from './neighborhoods.js';
export { MarketplaceIntent, type ResolvedCandidate } from './intent.js';
export { MarketplaceWorldSession, type MarketplaceEvent, type MarketplaceEventListener, } from './session.js';
export { serializeWorld, deserializeWorld, type SerializedWorld } from './serialization.js';
//# sourceMappingURL=index.d.ts.map