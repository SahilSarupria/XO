import type { EntityId, WorldCoordinates } from './types.js'
import { clamp01 } from './types.js'

/**
 * Intent focus.
 *
 * "Language steers depth. It does not file a query." Atlas has no
 * opinion about language — turning a sentence into candidates is the
 * consumer's job (search, embeddings, whatever they choose). What
 * atlas provides is the *infrastructure of attention*: holding a set
 * of scored candidates, letting that attention decay if it isn't
 * reinforced, and reporting a single target to steer the camera
 * toward — the same way a few heads turning in a room resolves,
 * without anyone taking a vote, into everyone looking at one thing.
 */
export interface IntentCandidate {
  readonly id: EntityId
  readonly position: WorldCoordinates
  /** Relevance in [0, 1]. Values outside this range are clamped. */
  readonly score: number
}

export interface IntentFocusOptions {
  /** Fraction of relevance lost per second when not reinforced. 0 = no decay. */
  decayPerSecond?: number
  /** "top" steers toward the single highest-scoring candidate.
   * "weighted-centroid" steers toward the score-weighted average
   * position of all candidates, so several near-equal candidates pull
   * focus toward the space between them rather than snapping to one. */
  blend?: 'top' | 'weighted-centroid'
}

interface TrackedCandidate {
  id: EntityId
  position: WorldCoordinates
  score: number
}

export class IntentFocus {
  private candidates = new Map<EntityId, TrackedCandidate>()
  private lastUpdate: number
  private readonly decayPerSecond: number
  private readonly blend: 'top' | 'weighted-centroid'

  constructor(options: IntentFocusOptions = {}, now = Date.now()) {
    this.decayPerSecond = options.decayPerSecond ?? 0
    this.blend = options.blend ?? 'top'
    this.lastUpdate = now
  }

  /** Replace the current candidate set, e.g. after a new intent string
   * has been resolved by the consumer. */
  update(candidates: readonly IntentCandidate[], now = Date.now()): void {
    this.decay(now)
    this.candidates = new Map(
      candidates.map((c) => [c.id, { id: c.id, position: c.position, score: clamp01(c.score) }]),
    )
    this.lastUpdate = now
  }

  /** Apply time-based decay without changing the candidate set. Safe to
   * call as often as convenient; it's a no-op if decayPerSecond is 0. */
  decay(now = Date.now()): void {
    if (this.decayPerSecond <= 0) return
    const seconds = Math.max(0, (now - this.lastUpdate) / 1000)
    if (seconds <= 0) return
    const factor = clamp01(1 - this.decayPerSecond * seconds)
    for (const candidate of this.candidates.values()) candidate.score *= factor
    this.lastUpdate = now
  }

  /** The single highest-scoring candidate, or null if attention has
   * fully decayed / nothing has been offered yet. */
  top(now = Date.now()): IntentCandidate | null {
    this.decay(now)
    let best: TrackedCandidate | null = null
    for (const candidate of this.candidates.values()) {
      if (candidate.score <= 0) continue
      if (!best || candidate.score > best.score) best = candidate
    }
    return best ? { id: best.id, position: best.position, score: best.score } : null
  }

  /** The point atlas recommends steering the camera toward, per the
   * configured blend mode. Null when there's nothing to focus on. */
  target(now = Date.now()): WorldCoordinates | null {
    this.decay(now)
    const live = [...this.candidates.values()].filter((c) => c.score > 0)
    if (live.length === 0) return null
    if (this.blend === 'top') {
      const best = live.reduce((a, b) => (b.score > a.score ? b : a))
      return best.position
    }
    let totalWeight = 0
    let x = 0
    let y = 0
    for (const candidate of live) {
      x += candidate.position.x * candidate.score
      y += candidate.position.y * candidate.score
      totalWeight += candidate.score
    }
    return totalWeight > 0 ? { x: x / totalWeight, y: y / totalWeight } : null
  }

  clear(): void {
    this.candidates.clear()
  }
}
