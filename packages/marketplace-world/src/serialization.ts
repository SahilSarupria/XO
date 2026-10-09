import type {
  Capability,
  Community,
  MarketplaceWorld,
  Publisher,
  Relationship,
  Workflow,
  XOEntity,
} from './types.js'

/**
 * A plain-JSON-safe form of MarketplaceWorld \u2014 Maps replaced with
 * sorted arrays so serialization is itself deterministic (two
 * projections of the same source graph serialize to byte-identical
 * JSON, not just structurally-equal objects).
 */
export interface SerializedWorld {
  readonly xos: readonly XOEntity[]
  readonly capabilities: readonly Capability[]
  readonly workflows: readonly Workflow[]
  readonly publishers: readonly Publisher[]
  readonly communities: readonly Community[]
  readonly relationships: readonly Relationship[]
  readonly positions: readonly { readonly xoId: string; readonly x: number; readonly y: number }[]
}

export function serializeWorld(world: MarketplaceWorld): SerializedWorld {
  return {
    xos: sortedBy([...world.xos.values()], (x) => x.id),
    capabilities: sortedBy([...world.capabilities.values()], (c) => c.id),
    workflows: sortedBy([...world.workflows.values()], (w) => w.id),
    publishers: sortedBy([...world.publishers.values()], (p) => p.id),
    communities: sortedBy([...world.communities.values()], (c) => c.id),
    relationships: [...world.relationships],
    positions: sortedBy(
      [...world.positions.entries()].map(([xoId, p]) => ({ xoId, x: p.x, y: p.y })),
      (p) => p.xoId,
    ),
  }
}

export function deserializeWorld(data: SerializedWorld): MarketplaceWorld {
  return {
    xos: new Map(data.xos.map((x) => [x.id, x])),
    capabilities: new Map(data.capabilities.map((c) => [c.id, c])),
    workflows: new Map(data.workflows.map((w) => [w.id, w])),
    publishers: new Map(data.publishers.map((p) => [p.id, p])),
    communities: new Map(data.communities.map((c) => [c.id, c])),
    relationships: [...data.relationships],
    positions: new Map(data.positions.map((p) => [p.xoId, { x: p.x, y: p.y }])),
  }
}

function sortedBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)))
}
