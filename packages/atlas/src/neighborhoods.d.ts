import type { EntityId, WorldCoordinates } from './types.js';
/**
 * Neighborhoods.
 *
 * Infrastructure for things organizing themselves in space — no
 * business logic about what a "community" or "district" *means*.
 * Atlas only knows positions, distances, and the groupings a consumer
 * (or a clustering pass) declares on top of them.
 */
export interface NeighborEntry {
    readonly id: EntityId;
    readonly distance: number;
}
export interface Cluster {
    readonly id: string;
    readonly members: readonly EntityId[];
    readonly centroid: WorldCoordinates;
}
export declare class NeighborhoodEngine {
    private readonly positions;
    private readonly districts;
    private readonly landmarks;
    private readonly routes;
    place(id: EntityId, position: WorldCoordinates): void;
    remove(id: EntityId): void;
    positionOf(id: EntityId): WorldCoordinates | undefined;
    all(): readonly EntityId[];
    /** The k nearest entities to a given entity, closest first. */
    neighborsOf(id: EntityId, k: number): NeighborEntry[];
    /** Every entity within `radius` of a given entity, closest first. */
    within(id: EntityId, radius: number): NeighborEntry[];
    /** Single-linkage clustering: entities within `radius` of one another
     * transitively belong to the same cluster. Deterministic for a given
     * set of positions and radius — order of insertion does not matter. */
    clusterByProximity(radius: number): Cluster[];
    defineDistrict(id: string, memberIds: readonly EntityId[]): void;
    districtOf(entityId: EntityId): string | null;
    districtMembers(districtId: string): readonly EntityId[];
    markLandmark(id: EntityId): void;
    unmarkLandmark(id: EntityId): void;
    isLandmark(id: EntityId): boolean;
    /** The nearest marked landmark to a position, or null if none exist. */
    nearestLandmark(position: WorldCoordinates): EntityId | null;
    defineRoute(id: string, orderedEntityIds: readonly EntityId[]): void;
    route(id: string): readonly EntityId[];
    /** Total length of a route as the sum of the distances between its
     * consecutive stops. Zero for a route with 0 or 1 stops. */
    routeLength(id: string): number;
}
//# sourceMappingURL=neighborhoods.d.ts.map