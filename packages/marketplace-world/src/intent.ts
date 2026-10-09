import { IntentFocus, type IntentFocusOptions, type WorldCoordinates } from '@xo/atlas'
import type { MarketplaceWorld, XOId } from './types.js'

/**
 * A resolved candidate the consumer has already determined is
 * relevant to some intent \u2014 this package never resolves language
 * itself (requirement 7 explicitly forbids an LLM/search engine
 * here). The consumer does that resolution however it likes and
 * hands the result in as (xoId, score) pairs.
 */
export interface ResolvedCandidate {
  readonly xoId: XOId
  readonly score: number
}

/**
 * Feeds resolved candidates through Atlas's IntentFocus and exposes
 * the resulting camera target in marketplace terms.
 */
export class MarketplaceIntent {
  private readonly world: MarketplaceWorld
  private readonly focus: IntentFocus

  constructor(world: MarketplaceWorld, options: IntentFocusOptions = {}) {
    this.world = world
    this.focus = new IntentFocus(options)
  }

  /** Register a fresh set of resolved candidates, e.g. after the
   * consumer resolves a new natural-language intent string. Candidates
   * for XOs with no known position are silently dropped. */
  update(candidates: readonly ResolvedCandidate[], now?: number): void {
    const withPositions = candidates
      .map((c) => {
        const position = this.world.positions.get(c.xoId)
        return position ? { id: c.xoId, position, score: c.score } : null
      })
      .filter((c): c is { id: XOId; position: WorldCoordinates; score: number } => c !== null)
    this.focus.update(withPositions, now)
  }

  /** The single most relevant XO right now, or null. */
  topXOId(now?: number): XOId | null {
    return this.focus.top(now)?.id ?? null
  }

  /** Where the camera should be steered to reflect current intent. */
  target(now?: number): WorldCoordinates | null {
    return this.focus.target(now)
  }

  clear(): void {
    this.focus.clear()
  }
}
