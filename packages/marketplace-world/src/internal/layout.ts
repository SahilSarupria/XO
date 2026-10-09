import { hashRingPosition } from './hash.js'

/**
 * A deterministic, dependency-free force layout.
 *
 * Not a general-purpose graph-drawing library — just enough to make
 * requirement 4 true: position emerges from relationships, with a
 * stable, explainable fallback for anything unconnected. No
 * randomness anywhere. Node order never affects the result: every
 * step computes all forces from the current positions into a delta
 * map, then applies every delta at once, so JS object/array iteration
 * order can never change the outcome — only id order (used solely for
 * making iteration explicit) and the physics do.
 */
export interface LayoutEdge {
  readonly a: string
  readonly b: string
  readonly weight: number
}

export interface LayoutOptions {
  readonly iterations?: number
  readonly repulsion?: number
  readonly attraction?: number
  readonly restLength?: number
  readonly area?: { readonly width: number; readonly height: number }
}

const DEFAULTS: Required<LayoutOptions> = {
  iterations: 300,
  repulsion: 600,
  attraction: 0.02,
  restLength: 18,
  area: { width: 100, height: 100 },
}

export function relax(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const opts: Required<LayoutOptions> = {
    iterations: options.iterations ?? DEFAULTS.iterations,
    repulsion: options.repulsion ?? DEFAULTS.repulsion,
    attraction: options.attraction ?? DEFAULTS.attraction,
    restLength: options.restLength ?? DEFAULTS.restLength,
    area: options.area ?? DEFAULTS.area,
  }
  const sortedIds = [...ids].sort()
  const center = { x: opts.area.width / 2, y: opts.area.height / 2 }
  const outerRadius = Math.min(opts.area.width, opts.area.height) * 0.42

  const positions = new Map<string, { x: number; y: number }>()
  for (const id of sortedIds) {
    positions.set(id, hashRingPosition(id, center, outerRadius))
  }

  // Precompute adjacency for attraction, keyed by a stable pair order.
  const relevantEdges = edges.filter((e) => positions.has(e.a) && positions.has(e.b) && e.a !== e.b)

  for (let step = 0; step < opts.iterations; step++) {
    const cooling = 1 - step / opts.iterations // linear cooling schedule
    const deltas = new Map<string, { x: number; y: number }>()
    for (const id of sortedIds) deltas.set(id, { x: 0, y: 0 })

    // Repulsion: every pair pushes apart, in fixed sorted-pair order.
    for (let i = 0; i < sortedIds.length; i++) {
      for (let j = i + 1; j < sortedIds.length; j++) {
        const idA = sortedIds[i]!
        const idB = sortedIds[j]!
        const pa = positions.get(idA)!
        const pb = positions.get(idB)!
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let distSq = dx * dx + dy * dy
        if (distSq < 0.0001) {
          // Perfectly coincident (possible from hash collisions on tiny
          // graphs): nudge deterministically along a fixed axis derived
          // from the pair rather than dividing by zero.
          dx = 0.01
          dy = 0.01
          distSq = dx * dx + dy * dy
        }
        const dist = Math.sqrt(distSq)
        const force = (opts.repulsion / distSq) * cooling
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        deltas.get(idA)!.x += fx
        deltas.get(idA)!.y += fy
        deltas.get(idB)!.x -= fx
        deltas.get(idB)!.y -= fy
      }
    }

    // Attraction: edges pull their endpoints toward restLength apart,
    // scaled by relationship weight — stronger relationships pull harder.
    for (const edge of relevantEdges) {
      const pa = positions.get(edge.a)!
      const pb = positions.get(edge.b)!
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const dist = Math.max(0.01, Math.hypot(dx, dy))
      const displacement = dist - opts.restLength
      const force = opts.attraction * edge.weight * displacement * cooling
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      deltas.get(edge.a)!.x += fx
      deltas.get(edge.a)!.y += fy
      deltas.get(edge.b)!.x -= fx
      deltas.get(edge.b)!.y -= fy
    }

    for (const id of sortedIds) {
      const p = positions.get(id)!
      const d = deltas.get(id)!
      positions.set(id, { x: p.x + d.x, y: p.y + d.y })
    }
  }

  return normalize(positions, opts.area)
}

/** Min-max scale the final layout into the configured area, leaving a
 * small margin so nothing sits exactly on the edge. Deterministic —
 * depends only on the (already-deterministic) input positions. */
function normalize(
  positions: Map<string, { x: number; y: number }>,
  area: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  if (positions.size === 0) return positions
  if (positions.size === 1) {
    const [id] = positions.keys()
    return new Map([[id!, { x: area.width / 2, y: area.height / 2 }]])
  }
  const xs = [...positions.values()].map((p) => p.x)
  const ys = [...positions.values()].map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const margin = 0.08
  const spanX = Math.max(0.0001, maxX - minX)
  const spanY = Math.max(0.0001, maxY - minY)
  const result = new Map<string, { x: number; y: number }>()
  for (const [id, p] of positions) {
    const nx = margin + ((p.x - minX) / spanX) * (1 - 2 * margin)
    const ny = margin + ((p.y - minY) / spanY) * (1 - 2 * margin)
    result.set(id, { x: nx * area.width, y: ny * area.height })
  }
  return result
}
