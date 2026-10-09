/**
 * @xo/marketplace-world
 *
 * Translates the actual XO ecosystem into Atlas's spatial model.
 * Sits above @xo/atlas (generic interaction engine) and below the
 * marketplace UI. See README.md for the data flow, the positioning
 * algorithm, and what this package assumes doesn't exist yet in the
 * repository (a real graph-engine/XOIR/runtime).
 */
export { projectWorld } from './projection.js';
export { MARKETPLACE_ALTITUDE_LEVELS, createMarketplaceAltitudeModel } from './altitude.js';
export { buildMarketplaceSemanticZoom, emergenceForXO, visibleFields, } from './semantic.js';
export { MarketplaceNeighborhoods } from './neighborhoods.js';
export { MarketplaceIntent } from './intent.js';
export { MarketplaceWorldSession, } from './session.js';
export { serializeWorld, deserializeWorld } from './serialization.js';
//# sourceMappingURL=index.js.map