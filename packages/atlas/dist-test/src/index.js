/**
 * @xo/atlas — the interaction engine for XO.
 *
 * There is only one place. Users never navigate away; they only move
 * closer or further. This package is the infrastructure that makes
 * that true: a physically-animated camera, a configurable notion of
 * depth, semantic zoom, spatial memory, navigation history, and
 * neighborhoods — with no business logic and no UI framework baked
 * in. See README.md for the philosophy and integration guide.
 *
 * Only what's exported here is stable. Everything under `internal/`
 * may change at any time without notice.
 */
export { worldCoordinates, distance, } from './types.js';
export { Camera } from './camera.js';
export { AltitudeModel } from './altitude.js';
export { SemanticZoomRegistry, } from './semantic-zoom.js';
export { NavigationHistory } from './navigation-history.js';
export { SpatialMemory } from './spatial-memory.js';
export { NeighborhoodEngine, } from './neighborhoods.js';
export { IntentFocus, } from './intent-focus.js';
//# sourceMappingURL=index.js.map