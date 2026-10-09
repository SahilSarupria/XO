import type { EntityId, WorldCoordinates } from './types.js'
import { distance } from './types.js'

/**
 * Neighborhoods.
 *
 * Infrastructure for things organizing themselves in space — no
 * business logic about what a "community" or "district" *means*.
 * Atlas only knows positions, distances, and the groupings a consumer
 * (or a clustering pass) declares on top of them.
 */
export interface NeighborEntry {
  readonly id: EntityId
  readonly distance: number
}

export interface Cluster {
  readonly id: string
  readonly members: readonly EntityId[]
  readonly centroid: WorldCoordinates
}

export class NeighborhoodEngine {
  private readonly positions = new Map<EntityId, WorldCoordinates>()
  private readonly districts = new Map<string, Set<EntityId>>()
  private readonly landmarks = new Set<EntityId>()
  private readonly routes = new Map<string, EntityId[]>()

  // -- positions ------------------------------------------------------

  place(id: EntityId, position: WorldCoordinates): void {
    this.positions.set(id, position)
  }

  remove(id: EntityId): void {
    this.positions.delete(id)
    this.landmarks.delete(id)
    for (const members of this.districts.values()) members.delete(id)
  }

  positionOf(id: EntityId): WorldCoordinates | undefined {
    return this.positions.get(id)
  }

  all(): readonly EntityId[] {
    return [...this.positions.keys()]
  }

  // -- neighbors --------------------------------------------------------

  /** The k nearest entities to a given entity, closest first. */
  neighborsOf(id: EntityId, k: number): NeighborEntry[] {
    const origin = this.positions.get(id)
    if (!origin) return []
    const entries: NeighborEntry[] = []
    for (const [otherId, position] of this.positions) {
      if (otherId === id) continue
      entries.push({ id: otherId, distance: distance(origin, position) })
    }
    entries.sort((a, b) => a.distance - b.distance)
    return entries.slice(0, k)
  }

  /** Every entity within `radius` of a given entity, closest first. */
  within(id: EntityId, radius: number): NeighborEntry[] {
    const origin = this.positions.get(id)
    if (!origin) return []
    const entries: NeighborEntry[] = []
    for (const [otherId, position] of this.positions) {
      if (otherId === id) continue
      const d = distance(origin, position)
      if (d <= radius) entries.push({ id: otherId, distance: d })
    }
    entries.sort((a, b) => a.distance - b.distance)
    return entries
  }

  // -- clusters ---------------------------------------------------------

  /** Single-linkage clustering: entities within `radius` of one another
   * transitively belong to the same cluster. Deterministic for a given
   * set of positions and radius — order of insertion does not matter. */
  clusterByProximity(radius: number): Cluster[] {
    const ids = [...this.positions.keys()].sort()
    const parent = new Map<EntityId, EntityId>()
    const find = (x: EntityId): EntityId => {
      let root = x
      while (parent.get(root)! !== root) root = parent.get(root)!
      let cur = x
      while (parent.get(cur)! !== root) {
        const next = parent.get(cur)!
        parent.set(cur, root)
        cur = next
      }
      return root
    }
    const union = (a: EntityId, b: EntityId): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const id of ids) parent.set(id, id)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!
        const b = ids[j]!
        if (distance(this.positions.get(a)!, this.positions.get(b)!) <= radius) {
          union(a, b)
        }
      }
    }
    const groups = new Map<EntityId, EntityId[]>()
    for (const id of ids) {
      const root = find(id)
      const group = groups.get(root)
      if (group) group.push(id)
      else groups.set(root, [id])
    }
    const clusters: Cluster[] = []
    let index = 0
    for (const members of groups.values()) {
      clusters.push({ id: `cluster_${index}`, members, centroid: centroidOf(members, this.positions) })
      index += 1
    }
    return clusters
  }

  // -- districts (manually declared groupings) ---------------------------

  defineDistrict(id: string, memberIds: readonly EntityId[]): void {
    this.districts.set(id, new Set(memberIds))
  }

  districtOf(entityId: EntityId): string | null {
    for (const [districtId, members] of this.districts) {
      if (members.has(entityId)) return districtId
    }
    return null
  }

  districtMembers(districtId: string): readonly EntityId[] {
    return [...(this.districts.get(districtId) ?? [])]
  }

  // -- landmarks ----------------------------------------------------------

  markLandmark(id: EntityId): void {
    this.landmarks.add(id)
  }

  unmarkLandmark(id: EntityId): void {
    this.landmarks.delete(id)
  }

  isLandmark(id: EntityId): boolean {
    return this.landmarks.has(id)
  }

  /** The nearest marked landmark to a position, or null if none exist. */
  nearestLandmark(position: WorldCoordinates): EntityId | null {
    let best: EntityId | null = null
    let bestDistance = Infinity
    for (const id of this.landmarks) {
      const p = this.positions.get(id)
      if (!p) continue
      const d = distance(position, p)
      if (d < bestDistance) {
        best = id
        bestDistance = d
      }
    }
    return best
  }

  // -- routes (ordered, named paths through the world) --------------------

  defineRoute(id: string, orderedEntityIds: readonly EntityId[]): void {
    this.routes.set(id, [...orderedEntityIds])
  }

  route(id: string): readonly EntityId[] {
    return this.routes.get(id) ?? []
  }

  /** Total length of a route as the sum of the distances between its
   * consecutive stops. Zero for a route with 0 or 1 stops. */
  routeLength(id: string): number {
    const stops = this.routes.get(id)
    if (!stops || stops.length < 2) return 0
    let total = 0
    for (let i = 1; i < stops.length; i++) {
      const a = this.positions.get(stops[i - 1]!)
      const b = this.positions.get(stops[i]!)
      if (a && b) total += distance(a, b)
    }
    return total
  }
}

function centroidOf(
  members: readonly EntityId[],
  positions: Map<EntityId, WorldCoordinates>,
): WorldCoordinates {
  let x = 0
  let y = 0
  for (const id of members) {
    const p = positions.get(id)!
    x += p.x
    y += p.y
  }
  return { x: x / members.length, y: y / members.length }
}
