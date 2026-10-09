import { NeighborhoodEngine } from '@xo/atlas'
import type { Capability, CommunityId, MarketplaceWorld, Workflow, XOEntity, XOId } from './types.js'

/**
 * Marketplace-shaped answers to spatial questions, built entirely on
 * top of Atlas's domain-neutral NeighborhoodEngine \u2014 this module adds
 * no new spatial infrastructure, only vocabulary (requirement 8).
 */
export class MarketplaceNeighborhoods {
  private readonly engine = new NeighborhoodEngine()
  private readonly world: MarketplaceWorld

  constructor(world: MarketplaceWorld) {
    this.world = world
    const xoIds = [...world.xos.keys()].sort()
    for (const id of xoIds) {
      const position = world.positions.get(id)
      if (position) this.engine.place(id, position)
    }
    for (const community of world.communities.values()) {
      this.engine.defineDistrict(community.id, community.memberIds)
    }
  }

  /** What is near this XO, closest first. */
  near(xoId: XOId, k = 5): XOEntity[] {
    return this.engine.neighborsOf(xoId, k).map((n) => this.world.xos.get(n.id)!).filter(Boolean)
  }

  /** Every XO within a spatial radius of this one. */
  within(xoId: XOId, radius: number): XOEntity[] {
    return this.engine.within(xoId, radius).map((n) => this.world.xos.get(n.id)!).filter(Boolean)
  }

  /** Every XO belonging to the given community/ecosystem. */
  ecosystemMembers(communityId: CommunityId): XOEntity[] {
    return this.engine
      .districtMembers(communityId)
      .map((id) => this.world.xos.get(id)!)
      .filter(Boolean)
  }

  /** The union of capabilities held by XOs spatially near this one \u2014
   * "what capabilities surround this experience". */
  capabilitiesSurrounding(xoId: XOId, radius = 20): Capability[] {
    const nearby = this.within(xoId, radius)
    const ids = new Set<string>()
    for (const xo of nearby) for (const capId of xo.capabilityIds) ids.add(capId)
    return [...ids]
      .sort()
      .map((id) => this.world.capabilities.get(id))
      .filter((c): c is Capability => Boolean(c))
  }

  /** Workflows belonging to XOs directly related to this one (via any
   * relationship kind), independent of spatial distance \u2014 "what
   * related workflows exist". */
  relatedWorkflows(xoId: XOId): Workflow[] {
    const relatedXOIds = new Set<string>()
    for (const rel of this.world.relationships) {
      if (rel.fromId === xoId) relatedXOIds.add(rel.toId)
      else if (rel.toId === xoId) relatedXOIds.add(rel.fromId)
    }
    const workflowIds = new Set<string>()
    for (const id of relatedXOIds) {
      const xo = this.world.xos.get(id)
      if (!xo) continue
      for (const workflowId of xo.workflowIds) workflowIds.add(workflowId)
    }
    return [...workflowIds]
      .sort()
      .map((id) => this.world.workflows.get(id))
      .filter((w): w is Workflow => Boolean(w))
  }

  /** The nearest XO to an arbitrary point \u2014 "what is the nearest
   * relevant entity", e.g. for resolving where a camera currently is. */
  nearestTo(position: { x: number; y: number }): XOEntity | null {
    let best: XOId | null = null
    let bestDistance = Infinity
    const xoIds = [...this.world.xos.keys()].sort()
    for (const id of xoIds) {
      const p = this.world.positions.get(id)
      if (!p) continue
      const d = Math.hypot(p.x - position.x, p.y - position.y)
      if (d < bestDistance) {
        bestDistance = d
        best = id
      }
    }
    return best ? this.world.xos.get(best) ?? null : null
  }
}
