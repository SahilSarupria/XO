import type { EntityId } from '@xo/atlas'

/**
 * The Marketplace World Model.
 *
 * This is the domain layer that sits between whatever produces real
 * XO/graph data (a future graph-engine, XOIR, or runtime — none of
 * which exist in this repository yet; see README.md) and Atlas's
 * domain-neutral spatial primitives. It knows what an XO is; Atlas
 * never does.
 *
 * Kept intentionally minimal where the repository gives no real
 * precedent to model against (Workflow, ReasoningProfile,
 * MemoryProfile, ExecutionState) — expanding those without a real
 * consumer would be guessing at a shape nobody has asked for yet.
 */

export type XOId = EntityId
export type CapabilityId = EntityId
export type WorkflowId = EntityId
export type PublisherId = EntityId
export type CommunityId = EntityId

/** Marketplace-specific presentation data, deliberately kept separate
 * from the core model so the core stays reusable outside a listing
 * context (e.g. by Studio or Runtime, per the Atlas README). */
export type MarketplaceMetadata = Readonly<Record<string, unknown>>

export type InstallState = 'available' | 'installing' | 'installed' | 'unavailable'

export interface Publisher {
  readonly id: PublisherId
  readonly name: string
  readonly verified?: boolean
}

export interface Capability {
  readonly id: CapabilityId
  readonly label: string
  readonly description?: string
}

/**
 * Deliberately minimal. Nothing in this repository (no runtime, no
 * compiler) currently defines what a workflow's internal structure
 * looks like. This is the seam a real Workflow model would replace.
 */
export interface Workflow {
  readonly id: WorkflowId
  readonly label: string
  readonly description?: string
}

export interface Community {
  readonly id: CommunityId
  readonly label: string
  readonly memberIds: readonly XOId[]
}

export type RelationshipKind =
  | 'dependsOn'
  | 'sharesCapability'
  | 'workflowLink'
  | 'communityLink'
  | 'custom'

export interface Relationship {
  readonly fromId: XOId
  readonly toId: XOId
  readonly kind: RelationshipKind
  /** Relative strength, used to pull related XOs closer during
   * projection. Higher = stronger pull. Defaults applied per kind if
   * not provided by the source graph — see projection.ts. */
  readonly weight: number
}

/** A fully resolved XO (Experience), the atlas of the marketplace
 * domain — analogous in spirit to the "experience" objects informally
 * present in app/page.tsx, formalized and made composable. */
export interface XOEntity {
  readonly id: XOId
  readonly name: string
  readonly kind: string
  readonly status?: string
  readonly description?: string
  readonly publisherId?: PublisherId
  readonly capabilityIds: readonly CapabilityId[]
  readonly workflowIds: readonly WorkflowId[]
  readonly communityId?: CommunityId
  readonly installState: InstallState
  readonly metadata: MarketplaceMetadata
}

/** The fully projected, queryable marketplace world. Positions are
 * computed by projection.ts — this type only describes the shape of
 * the result. */
export interface MarketplaceWorld {
  readonly xos: ReadonlyMap<XOId, XOEntity>
  readonly capabilities: ReadonlyMap<CapabilityId, Capability>
  readonly workflows: ReadonlyMap<WorkflowId, Workflow>
  readonly publishers: ReadonlyMap<PublisherId, Publisher>
  readonly communities: ReadonlyMap<CommunityId, Community>
  readonly relationships: readonly Relationship[]
  readonly positions: ReadonlyMap<XOId, { readonly x: number; readonly y: number }>
}
