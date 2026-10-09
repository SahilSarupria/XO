import type { CameraSnapshot, EntityId, WorldCoordinates } from './types.js';
import { type SpringConfig } from './internal/motion.js';
import { AltitudeModel } from './altitude.js';
import { NavigationHistory } from './navigation-history.js';
import { SpatialMemory } from './spatial-memory.js';
/**
 * The camera is navigation.
 *
 * There is no router. There is no "page." The camera has a position
 * on the plane and an altitude — how deep it is — and every method
 * on this class describes a way of moving one or both of those
 * through physical, continuous motion. Nothing here ever jumps
 * without `jump` being called explicitly (used only for restoring a
 * remembered place), and nothing here ever produces a hard cut.
 */
export type CameraListener = (snapshot: CameraSnapshot) => void;
export interface CameraOptions {
    altitudeModel?: AltitudeModel;
    history?: NavigationHistory;
    memory?: SpatialMemory;
    initialPosition?: WorldCoordinates;
    initialAltitude?: number;
    spring?: SpringConfig;
    now?: () => number;
}
export declare class Camera {
    readonly altitudeModel: AltitudeModel | undefined;
    readonly history: NavigationHistory;
    readonly memory: SpatialMemory;
    private readonly positionSpring;
    private readonly altitudeSpring;
    private focusId;
    private orbitState;
    private followState;
    private readonly listeners;
    private readonly now;
    constructor(options?: CameraOptions);
    get position(): WorldCoordinates;
    get altitude(): number;
    get focused(): EntityId | null;
    /** Whether every underlying spring has settled — i.e. nothing is
     * currently moving. Orbiting and following are never "settled". */
    get isMoving(): boolean;
    snapshot(): CameraSnapshot;
    /** Be notified on every tick(). Returns an unsubscribe function. */
    subscribe(listener: CameraListener): () => void;
    private notify;
    /** Advance all motion by dtSeconds. The consumer drives the clock —
     * atlas does not assume a browser, a frame rate, or a runtime. A
     * React (or any other) binding is expected to call this once per
     * frame; a test can call it with whatever dt it likes. */
    tick(dtSeconds: number): CameraSnapshot;
    /** Move toward a position in the plane. Cancels orbit/follow. */
    flyTo(position: WorldCoordinates, options?: {
        altitude?: number;
        commit?: boolean;
    }): void;
    /** Move to a specific altitude (a level id, if an AltitudeModel is
     * configured, or a raw number). Position is unchanged. */
    zoomTo(altitude: number | string, options?: {
        commit?: boolean;
    }): void;
    /** Focus on an entity at a position, without necessarily changing
     * altitude. This is "attention", distinct from "depth". */
    focus(entityId: EntityId, position: WorldCoordinates, options?: {
        altitude?: number;
    }): void;
    unfocus(options?: {
        rise?: boolean;
    }): void;
    /** Enter an entity: focus on it and move one level deeper. This is
     * the closest thing atlas has to "opening" something — except
     * nothing opens, the camera simply gets closer. */
    enter(entityId: EntityId, position: WorldCoordinates): void;
    /** Leave the current focus: rise one level shallower and return
     * focus to whatever was focused before, if navigation history knows. */
    leave(): void;
    /** Orbit continuously around a center point until another movement
     * command is issued. Used for ambient motion — a camera watching
     * something rather than travelling toward it. */
    orbit(center: WorldCoordinates, options?: {
        radius: number;
        angularSpeed?: number;
    }): void;
    /** Softly track a moving position — e.g. an entity that is itself
     * animating — until stopped or overridden by another command. */
    follow(entityId: EntityId, getPosition: () => WorldCoordinates): void;
    stopOrbit(): void;
    stopFollow(): void;
    private cancelAmbientMotion;
    /** Deliberately remember the current place. Returns its id. */
    remember(label?: string | null): string;
    /** Fly back to a remembered place (by id or label). Returns false if
     * nothing matched. */
    restore(idOrLabel: string): boolean;
    back(): boolean;
    forward(): boolean;
    /** Push the current target state into navigation history. Called
     * automatically by every committing movement method; exposed in
     * case a consumer builds a custom movement command on top of the
     * springs directly. */
    commit(): void;
    private jumpTo;
    private clampAltitude;
    private resolveLevelId;
}
export declare function clampToRange(value: number, min: number, max: number): number;
//# sourceMappingURL=camera.d.ts.map