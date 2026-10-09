import { clamp } from './types.js'

/**
 * The depth model.
 *
 * Altitude is the single axis of "how close." Zero navigation happens
 * on this axis — only motion toward or away from more detail. Atlas
 * does not hardcode what the levels mean. A marketplace might use
 * Ecosystem → Community → Experience → Capability → Workflow →
 * Reasoning → Memory → Execution. A debugger might use five levels
 * that mean something else entirely. The engine only needs to know
 * that levels exist, that they're ordered, and where their edges are.
 */
export interface AltitudeLevel {
  /** Stable identifier, e.g. "experience" or "execution". */
  readonly id: string
  /** Position in the depth order. Lower is shallower (further away). */
  readonly order: number
  /** Human-readable name for this level. */
  readonly label: string
  /** Optional description of what becomes visible at this level. */
  readonly description?: string
}

export class AltitudeModel {
  private readonly levels: readonly AltitudeLevel[]

  constructor(levels: readonly AltitudeLevel[]) {
    if (levels.length === 0) {
      throw new Error('AltitudeModel requires at least one level.')
    }
    const seenOrders = new Set<number>()
    const seenIds = new Set<string>()
    for (const level of levels) {
      if (seenOrders.has(level.order)) {
        throw new Error(`AltitudeModel: duplicate order ${level.order}.`)
      }
      if (seenIds.has(level.id)) {
        throw new Error(`AltitudeModel: duplicate id "${level.id}".`)
      }
      seenOrders.add(level.order)
      seenIds.add(level.id)
    }
    this.levels = [...levels].sort((a, b) => a.order - b.order)
  }

  /** The shallowest defined altitude. */
  get min(): number {
    return this.levels[0]!.order
  }

  /** The deepest defined altitude. */
  get max(): number {
    return this.levels[this.levels.length - 1]!.order
  }

  /** All levels, shallow to deep. */
  all(): readonly AltitudeLevel[] {
    return this.levels
  }

  byId(id: string): AltitudeLevel | undefined {
    return this.levels.find((level) => level.id === id)
  }

  byOrder(order: number): AltitudeLevel | undefined {
    return this.levels.find((level) => level.order === order)
  }

  /** Constrain a continuous altitude value to the defined range. */
  clamp(order: number): number {
    return clamp(order, this.min, this.max)
  }

  /** The nearest defined level to a continuous altitude value. */
  nearest(order: number): AltitudeLevel {
    let best = this.levels[0]!
    let bestDistance = Math.abs(best.order - order)
    for (const level of this.levels) {
      const d = Math.abs(level.order - order)
      if (d < bestDistance) {
        best = level
        bestDistance = d
      }
    }
    return best
  }

  /** The next level deeper than the given altitude, if any. */
  deeper(order: number): AltitudeLevel | undefined {
    return this.levels.find((level) => level.order > order)
  }

  /** The next level shallower than the given altitude, if any. */
  shallower(order: number): AltitudeLevel | undefined {
    let result: AltitudeLevel | undefined
    for (const level of this.levels) {
      if (level.order < order) result = level
      else break
    }
    return result
  }
}
