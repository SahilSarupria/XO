import type { CameraSnapshot, EntityId } from './types.js';
/** A deliberately remembered place, distinct from the involuntary trail
 * kept by NavigationHistory. */
export interface RememberedPlace {
    readonly id: string;
    readonly label: string | null;
    readonly snapshot: CameraSnapshot;
    readonly createdAt: number;
}
/**
 * Spatial memory.
 *
 * Where a visitor has been, what they lingered over, and which places
 * they (or the system, on their behalf) marked as worth returning to.
 * This is what makes the ecosystem feel like it remembers a visitor
 * across sessions rather than resetting to zero every time — but
 * atlas only holds the data; persisting it across sessions is the
 * consumer's responsibility (serialize `export()`, restore with
 * `import()`).
 */
export declare class SpatialMemory {
    private readonly places;
    private readonly visited;
    /** Deliberately bookmark a snapshot. Returns the place's id. */
    remember(snapshot: CameraSnapshot, label?: string | null, now?: number): string;
    forget(id: string): void;
    /** Look up a remembered place by id, or by label if a label was given
     * and is unique. Returns the most recently created match. */
    recall(idOrLabel: string): RememberedPlace | null;
    /** All remembered places, most recent first. */
    list(): readonly RememberedPlace[];
    /** Mark an entity as having been visited (entered), independent of
     * whether any place was explicitly remembered there. */
    markVisited(entityId: EntityId): void;
    hasVisited(entityId: EntityId): boolean;
    exploredCount(): number;
    /** Serialize everything atlas knows for this visitor, for the
     * consumer to persist however it likes (localStorage, a server, ...). */
    export(): {
        places: RememberedPlace[];
        visited: EntityId[];
    };
    import(data: {
        places: RememberedPlace[];
        visited: EntityId[];
    }): void;
    clear(): void;
}
//# sourceMappingURL=spatial-memory.d.ts.map