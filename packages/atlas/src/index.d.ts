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
export { type WorldCoordinates, type EntityId, type CameraSnapshot, worldCoordinates, distance, } from './types.js';
export { Camera, type CameraOptions, type CameraListener } from './camera.js';
export { AltitudeModel, type AltitudeLevel } from './altitude.js';
export { SemanticZoomRegistry, type SemanticZoomRule, type EmergenceState, } from './semantic-zoom.js';
export { NavigationHistory } from './navigation-history.js';
export { SpatialMemory, type RememberedPlace } from './spatial-memory.js';
export { NeighborhoodEngine, type Cluster, type NeighborEntry, } from './neighborhoods.js';
export { IntentFocus, type IntentCandidate, type IntentFocusOptions, } from './intent-focus.js';
//# sourceMappingURL=index.d.ts.map