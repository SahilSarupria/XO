import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult, NodeId, Point } from '../../model/types.js';
import type { LayoutEngine } from '../types.js';

/** Deterministic string hash -> [0,1), used to seed initial positions so
 * layout output is reproducible for the same input (no Math.random). */
function seededUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Simplified Fruchterman-Reingold force-directed layout: fixed iteration
 * count, deterministic seeded initial placement, cooling schedule.
 */
export const forceDirectedLayout: LayoutEngine = {
  kind: 'force-directed',
  compute(model: GraphModel, options?: GraphLayoutOptions): GraphLayoutResult {
    const iterations = options?.iterations ?? 200;
    const area = Math.max(400, model.nodeCount * 6000);
    const k = Math.sqrt(area / Math.max(1, model.nodeCount));

    const ids = model.nodes.map((n) => n.id);
    const pos = new Map<NodeId, Point>(
      ids.map((id) => [
        id,
        { x: (seededUnit(id, 1) - 0.5) * Math.sqrt(area), y: (seededUnit(id, 2) - 0.5) * Math.sqrt(area) },
      ]),
    );
    const disp = new Map<NodeId, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));

    const edges = model.edges.filter((e) => pos.has(e.source) && pos.has(e.target));
    let temperature = Math.sqrt(area) / 10;

    for (let iter = 0; iter < iterations; iter++) {
      for (const id of ids) disp.set(id, { x: 0, y: 0 });

      // Repulsive force between every pair (fine for the moderate node
      // counts this layout targets; force layouts are opt-in for large
      // graphs, which should prefer hierarchical/grid).
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i] as NodeId;
          const b = ids[j] as NodeId;
          const pa = pos.get(a)!;
          const pb = pos.get(b)!;
          let dx = pa.x - pb.x;
          let dy = pa.y - pb.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const force = (k * k) / dist;
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          const da = disp.get(a)!;
          const db = disp.get(b)!;
          disp.set(a, { x: da.x + dx, y: da.y + dy });
          disp.set(b, { x: db.x - dx, y: db.y - dy });
        }
      }

      // Attractive force along edges.
      for (const edge of edges) {
        const pa = pos.get(edge.source)!;
        const pb = pos.get(edge.target)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (dist * dist) / k;
        const ux = (dx / dist) * force;
        const uy = (dy / dist) * force;
        const da = disp.get(edge.source)!;
        const db = disp.get(edge.target)!;
        disp.set(edge.source, { x: da.x - ux, y: da.y - uy });
        disp.set(edge.target, { x: db.x + ux, y: db.y + uy });
      }

      for (const id of ids) {
        const d = disp.get(id)!;
        const dist = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
        const limited = Math.min(dist, temperature);
        const p = pos.get(id)!;
        pos.set(id, { x: p.x + (d.x / dist) * limited, y: p.y + (d.y / dist) * limited });
      }

      temperature *= 0.97;
    }

    return { kind: 'force-directed', positions: ids.map((id) => ({ id, position: pos.get(id)! })) };
  },
};
