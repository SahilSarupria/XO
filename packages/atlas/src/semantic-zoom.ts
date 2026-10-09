import { clamp01 } from './types.js'

/**
 * Semantic zoom.
 *
 * Map zoom makes things bigger. Semantic zoom makes things *more
 * true* — new meaning is revealed at depth, not a magnified version
 * of what was already visible. A rule declares the altitude range
 * across which something goes from absent to fully present. Between
 * those two points, atlas reports a continuous visibility value so a
 * consumer can fade it in rather than pop it in.
 *
 * The registry holds no opinion about what "something" is — `data`
 * is opaque to atlas. This is infrastructure for emergence, not a
 * content model.
 */
export interface SemanticZoomRule<T = unknown> {
  readonly id: string
  /** Altitude at which this begins to appear (visibility 0). */
  readonly appearsAt: number
  /** Altitude at which this is fully present (visibility 1). */
  readonly fullyVisibleAt: number
  readonly data?: T
}

export interface EmergenceState<T = unknown> {
  readonly id: string
  /** 0 = not yet emerged, 1 = fully present. Never negative or above 1. */
  readonly visibility: number
  readonly data?: T
}

export class SemanticZoomRegistry<T = unknown> {
  private readonly rules = new Map<string, SemanticZoomRule<T>>()

  register(rule: SemanticZoomRule<T>): void {
    this.rules.set(rule.id, rule)
  }

  unregister(id: string): void {
    this.rules.delete(id)
  }

  clear(): void {
    this.rules.clear()
  }

  /** Every registered rule's emergence state at a given altitude. */
  at(altitude: number): EmergenceState<T>[] {
    const states: EmergenceState<T>[] = []
    for (const rule of this.rules.values()) {
      states.push({ id: rule.id, visibility: emergence(rule, altitude), data: rule.data })
    }
    return states
  }

  /** Only what has begun to emerge (visibility > 0), most visible first. */
  visible(altitude: number): EmergenceState<T>[] {
    return this.at(altitude)
      .filter((state) => state.visibility > 0)
      .sort((a, b) => b.visibility - a.visibility)
  }
}

function emergence<T>(rule: SemanticZoomRule<T>, altitude: number): number {
  const span = rule.fullyVisibleAt - rule.appearsAt
  if (span <= 0) {
    return altitude >= rule.appearsAt ? 1 : 0
  }
  return clamp01((altitude - rule.appearsAt) / span)
}
