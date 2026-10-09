import type { CameraSnapshot, EntityId } from './types.js'
import { nextId } from './internal/id.js'

/** A deliberately remembered place, distinct from the involuntary trail
 * kept by NavigationHistory. */
export interface RememberedPlace {
  readonly id: string
  readonly label: string | null
  readonly snapshot: CameraSnapshot
  readonly createdAt: number
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
export class SpatialMemory {
  private readonly places = new Map<string, RememberedPlace>()
  private readonly visited = new Set<EntityId>()

  /** Deliberately bookmark a snapshot. Returns the place's id. */
  remember(snapshot: CameraSnapshot, label: string | null = null, now = Date.now()): string {
    const id = nextId('place')
    this.places.set(id, { id, label, snapshot, createdAt: now })
    return id
  }

  forget(id: string): void {
    this.places.delete(id)
  }

  /** Look up a remembered place by id, or by label if a label was given
   * and is unique. Returns the most recently created match. */
  recall(idOrLabel: string): RememberedPlace | null {
    const byId = this.places.get(idOrLabel)
    if (byId) return byId
    let best: RememberedPlace | null = null
    for (const place of this.places.values()) {
      if (place.label === idOrLabel) {
        if (!best || place.createdAt > best.createdAt) best = place
      }
    }
    return best
  }

  /** All remembered places, most recent first. */
  list(): readonly RememberedPlace[] {
    return [...this.places.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Mark an entity as having been visited (entered), independent of
   * whether any place was explicitly remembered there. */
  markVisited(entityId: EntityId): void {
    this.visited.add(entityId)
  }

  hasVisited(entityId: EntityId): boolean {
    return this.visited.has(entityId)
  }

  exploredCount(): number {
    return this.visited.size
  }

  /** Serialize everything atlas knows for this visitor, for the
   * consumer to persist however it likes (localStorage, a server, ...). */
  export(): { places: RememberedPlace[]; visited: EntityId[] } {
    return { places: this.list().slice(), visited: [...this.visited] }
  }

  import(data: { places: RememberedPlace[]; visited: EntityId[] }): void {
    this.places.clear()
    for (const place of data.places) this.places.set(place.id, place)
    this.visited.clear()
    for (const id of data.visited) this.visited.add(id)
  }

  clear(): void {
    this.places.clear()
    this.visited.clear()
  }
}
