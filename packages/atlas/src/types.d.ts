/**
 * Shared vocabulary for the atlas engine.
 *
 * These types carry no business logic. They describe *space*, not
 * marketplaces, experiences, or products. Anything domain-specific
 * belongs to the consumer, never to atlas.
 */
/** A position on the plane at a given altitude. */
export interface WorldCoordinates {
    readonly x: number;
    readonly y: number;
}
/** The identifier of anything atlas is asked to move toward, cluster,
 * remember, or focus on. Atlas never inspects what an id refers to. */
export type EntityId = string;
/** A complete, serializable description of where the camera is. */
export interface CameraSnapshot {
    readonly position: WorldCoordinates;
    readonly altitude: number;
    readonly focusId: EntityId | null;
    readonly timestamp: number;
}
export declare function worldCoordinates(x: number, y: number): WorldCoordinates;
export declare function distance(a: WorldCoordinates, b: WorldCoordinates): number;
export declare function lerp(from: number, to: number, t: number): number;
export declare function clamp(value: number, min: number, max: number): number;
export declare function clamp01(value: number): number;
//# sourceMappingURL=types.d.ts.map