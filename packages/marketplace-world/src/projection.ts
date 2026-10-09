import type {
  Capability,
  CapabilityId,
  Community,
  MarketplaceWorld,
  Publisher,
  Relationship,
  RelationshipKind,
  Workflow,
  XOEntity,
  XOId,
} from './types.js'
import type { SourceGraph, SourceXO } from './source-graph.js'
import { relax, type LayoutEdge } from './internal/layout.js'

/**
 * Relationship weights by kind, used only when the source graph
 * doesn't supply an explicit weight. Explicit dependencies pull
 * harder than a merely-shared capability, matching how strongly each
 * kind of connection should read spatially.
 */
const DEFAULT_WEIGHT_BY_KIND: Record<RelationshipKind, number> = {
  dependsOn: 1.6,
  workflowLink: 1.2,
  sharesCapability: 0.7,
  communityLink: 0.5,
  custom: 1,
}

export interface ProjectionOptions {
  readonly area?: { readonly width: number; readonly height: number }
  readonly iterations?: number
}

/**
 * Project a SourceGraph into a MarketplaceWorld.
 *
 * Deterministic: the same SourceGraph (in any array order — every
 * internal collection is sorted before it can affect layout) always
 * produces an identical MarketplaceWorld, including identical
 * positions. See tests/determinism.test.ts.
 */
export function projectWorld(source: SourceGraph, options: ProjectionOptions = {}): MarketplaceWorld {
  const xos = new Map<XOId, XOEntity>()
  const capabilities = new Map<CapabilityId, Capability>()
  const workflows = new Map<string, Workflow>()
  const publishers = new Map<string, Publisher>()
  const communities = new Map<string, Community>()

  for (const publisher of source.publishers ?? []) {
    publishers.set(publisher.id, {
      id: publisher.id,
      name: publisher.name,
      ...(publisher.verified !== undefined ? { verified: publisher.verified } : {}),
    })
  }
  for (const community of source.communities ?? []) {
    communities.set(community.id, {
      id: community.id,
      label: community.label,
      memberIds: [...community.memberIds].sort(),
    })
  }
  for (const capability of source.capabilities ?? []) {
    capabilities.set(capability.id, {
      id: capability.id,
      label: capability.label,
      ...(capability.description !== undefined ? { description: capability.description } : {}),
    })
  }
  for (const workflow of source.workflows ?? []) {
    workflows.set(workflow.id, {
      id: workflow.id,
      label: workflow.label,
      ...(workflow.description !== undefined ? { description: workflow.description } : {}),
    })
  }

  // Synthesize a minimal capability/workflow entry for any id an XO
  // references that wasn't explicitly cataloged, so a source graph
  // never has to duplicate a label it doesn't have yet.
  for (const xo of source.xos) {
    for (const capId of xo.capabilityIds) {
      if (!capabilities.has(capId)) capabilities.set(capId, { id: capId, label: capId })
    }
    for (const workflowId of xo.workflowIds ?? []) {
      if (!workflows.has(workflowId)) workflows.set(workflowId, { id: workflowId, label: workflowId })
    }
  }

  for (const xo of source.xos) {
    xos.set(xo.id, toXOEntity(xo))
  }

  const relationships = deriveRelationships(source, xos)
  const positions = computeLayout(source, relationships, options)

  return {
    xos,
    capabilities,
    workflows,
    publishers,
    communities,
    relationships,
    positions,
  }
}

/** Optional fields are omitted entirely when absent, rather than set to
 * `undefined` \u2014 `undefined`-valued keys silently vanish under
 * JSON.stringify, which would make serializeWorld() lie about being
 * JSON-safe (a round trip would drop them). Omitting them up front
 * means the in-memory shape and the serialized shape always agree. */
function toXOEntity(xo: SourceXO): XOEntity {
  return {
    id: xo.id,
    name: xo.name,
    kind: xo.kind,
    ...(xo.status !== undefined ? { status: xo.status } : {}),
    ...(xo.description !== undefined ? { description: xo.description } : {}),
    ...(xo.publisherId !== undefined ? { publisherId: xo.publisherId } : {}),
    capabilityIds: [...xo.capabilityIds].sort(),
    workflowIds: [...(xo.workflowIds ?? [])].sort(),
    ...(xo.communityId !== undefined ? { communityId: xo.communityId } : {}),
    installState: xo.installState ?? 'available',
    metadata: xo.metadata ?? {},
  }
}

/**
 * Explicit relationships from the source graph, plus implicit ones
 * derived from structure already present on it: XOs that share a
 * capability, share a workflow, or belong to the same community all
 * get an implicit relationship — this is what lets "shared
 * capabilities" and "ecosystem/community relationships" (requirement
 * 4) pull XOs together even when no explicit edge was ever declared.
 */
function deriveRelationships(source: SourceGraph, xos: ReadonlyMap<XOId, XOEntity>): Relationship[] {
  const relationships: Relationship[] = []
  const seen = new Set<string>()

  const add = (fromId: string, toId: string, kind: RelationshipKind, weight: number): void => {
    if (fromId === toId) return
    if (!xos.has(fromId) || !xos.has(toId)) return
    const [a, b] = [fromId, toId].sort()
    const key = `${kind}:${a}:${b}`
    if (seen.has(key)) return
    seen.add(key)
    relationships.push({ fromId: a, toId: b, kind, weight })
  }

  for (const rel of source.relationships ?? []) {
    const kind = (rel.kind as RelationshipKind) ?? 'custom'
    add(rel.fromId, rel.toId, kind, rel.weight ?? DEFAULT_WEIGHT_BY_KIND[kind] ?? DEFAULT_WEIGHT_BY_KIND.custom)
  }

  const byCapability = groupBy(xos, (xo) => xo.capabilityIds)
  for (const members of byCapability.values()) {
    forEachPair(members, (a, b) => add(a, b, 'sharesCapability', DEFAULT_WEIGHT_BY_KIND.sharesCapability))
  }

  const byWorkflow = groupBy(xos, (xo) => xo.workflowIds)
  for (const members of byWorkflow.values()) {
    forEachPair(members, (a, b) => add(a, b, 'workflowLink', DEFAULT_WEIGHT_BY_KIND.workflowLink))
  }

  for (const community of source.communities ?? []) {
    forEachPair([...community.memberIds].sort(), (a, b) =>
      add(a, b, 'communityLink', DEFAULT_WEIGHT_BY_KIND.communityLink),
    )
  }

  return relationships.sort((r1, r2) => (r1.fromId + r1.toId + r1.kind).localeCompare(r2.fromId + r2.toId + r2.kind))
}

function groupBy(
  xos: ReadonlyMap<XOId, XOEntity>,
  keysOf: (xo: XOEntity) => readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  const ids = [...xos.keys()].sort()
  for (const id of ids) {
    const xo = xos.get(id)!
    for (const key of keysOf(xo)) {
      const group = groups.get(key)
      if (group) group.push(id)
      else groups.set(key, [id])
    }
  }
  return groups
}

function forEachPair(sortedIds: readonly string[], fn: (a: string, b: string) => void): void {
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      fn(sortedIds[i]!, sortedIds[j]!)
    }
  }
}

function computeLayout(
  source: SourceGraph,
  relationships: readonly Relationship[],
  options: ProjectionOptions,
): Map<XOId, { x: number; y: number }> {
  const ids = source.xos.map((xo) => xo.id).sort()
  const edges: LayoutEdge[] = relationships.map((r) => ({ a: r.fromId, b: r.toId, weight: r.weight }))
  return relax(ids, edges, { area: options.area, iterations: options.iterations })
}
