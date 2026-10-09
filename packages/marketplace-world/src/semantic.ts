import { SemanticZoomRegistry, type EmergenceState } from '@xo/atlas'
import type { MarketplaceWorld, XOId } from './types.js'

/**
 * The fields of an XO that emerge at different depths. Deliberately a
 * closed set matching the altitude model in altitude.ts — identity
 * appears shallow, capability and workflow appear mid-depth, and
 * reasoning/memory/execution (all still provisional; see altitude.ts)
 * appear deepest.
 */
export type MarketplaceField = 'identity' | 'capabilities' | 'workflows' | 'reasoning' | 'memory' | 'execution'

const FIELD_RANGE: Record<MarketplaceField, { appearsAt: number; fullyVisibleAt: number }> = {
  identity: { appearsAt: 0, fullyVisibleAt: 2 },
  capabilities: { appearsAt: 2, fullyVisibleAt: 3 },
  workflows: { appearsAt: 3, fullyVisibleAt: 4 },
  reasoning: { appearsAt: 4, fullyVisibleAt: 5 },
  memory: { appearsAt: 5, fullyVisibleAt: 6 },
  execution: { appearsAt: 6, fullyVisibleAt: 7 },
}

export interface MarketplaceEmergence {
  readonly xoId: XOId
  readonly field: MarketplaceField
  readonly visibility: number
}

/**
 * Builds a SemanticZoomRegistry with one rule per (XO, field) pair,
 * reusing Atlas's registry directly rather than inventing a second
 * visibility system, per requirement 6.
 */
export function buildMarketplaceSemanticZoom(world: MarketplaceWorld): SemanticZoomRegistry<MarketplaceEmergence> {
  const registry = new SemanticZoomRegistry<MarketplaceEmergence>()
  const xoIds = [...world.xos.keys()].sort()
  for (const xoId of xoIds) {
    for (const field of Object.keys(FIELD_RANGE) as MarketplaceField[]) {
      const range = FIELD_RANGE[field]
      registry.register({
        id: ruleId(xoId, field),
        appearsAt: range.appearsAt,
        fullyVisibleAt: range.fullyVisibleAt,
        data: { xoId, field, visibility: 0 },
      })
    }
  }
  return registry
}

/** Every field's emergence state for one XO at a given altitude. */
export function emergenceForXO(
  registry: SemanticZoomRegistry<MarketplaceEmergence>,
  xoId: XOId,
  altitude: number,
): EmergenceState<MarketplaceEmergence>[] {
  return registry.at(altitude).filter((state) => state.data?.xoId === xoId)
}

/** Every (XO, field) pair currently emerged at all, most visible
 * first \u2014 useful for a consumer deciding what to render this frame
 * without iterating every XO in the world. */
export function visibleFields(
  registry: SemanticZoomRegistry<MarketplaceEmergence>,
  altitude: number,
): EmergenceState<MarketplaceEmergence>[] {
  return registry.visible(altitude)
}

function ruleId(xoId: XOId, field: MarketplaceField): string {
  return `${xoId}::${field}`
}
