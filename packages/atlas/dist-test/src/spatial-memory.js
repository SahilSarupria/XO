import { nextId } from './internal/id.js';
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
export class SpatialMemory {
    places = new Map();
    visited = new Set();
    /** Deliberately bookmark a snapshot. Returns the place's id. */
    remember(snapshot, label = null, now = Date.now()) {
        const id = nextId('place');
        this.places.set(id, { id, label, snapshot, createdAt: now });
        return id;
    }
    forget(id) {
        this.places.delete(id);
    }
    /** Look up a remembered place by id, or by label if a label was given
     * and is unique. Returns the most recently created match. */
    recall(idOrLabel) {
        const byId = this.places.get(idOrLabel);
        if (byId)
            return byId;
        let best = null;
        for (const place of this.places.values()) {
            if (place.label === idOrLabel) {
                if (!best || place.createdAt > best.createdAt)
                    best = place;
            }
        }
        return best;
    }
    /** All remembered places, most recent first. */
    list() {
        return [...this.places.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
    /** Mark an entity as having been visited (entered), independent of
     * whether any place was explicitly remembered there. */
    markVisited(entityId) {
        this.visited.add(entityId);
    }
    hasVisited(entityId) {
        return this.visited.has(entityId);
    }
    exploredCount() {
        return this.visited.size;
    }
    /** Serialize everything atlas knows for this visitor, for the
     * consumer to persist however it likes (localStorage, a server, ...). */
    export() {
        return { places: this.list().slice(), visited: [...this.visited] };
    }
    import(data) {
        this.places.clear();
        for (const place of data.places)
            this.places.set(place.id, place);
        this.visited.clear();
        for (const id of data.visited)
            this.visited.add(id);
    }
    clear() {
        this.places.clear();
        this.visited.clear();
    }
}
//# sourceMappingURL=spatial-memory.js.map