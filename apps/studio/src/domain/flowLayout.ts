import type { DraftGraph } from './draftEdit';
import type { DraftNode } from '../platform/wire-studio';

/**
 * Geometry for the workflow canvas: where each node sits, where its ports are, and the path of every connection.
 * Pure and deterministic. Positions are always derived from the graph (the platform stores no coordinates), so two
 * people looking at the same revision see the same picture.
 */
export const FLOW_NODE_W = 208;
export const FLOW_NODE_H = 68;
/** A branch is taller so its two outputs have room to be labelled apart. */
export const FLOW_BRANCH_H = 92;
const GAP_X = 76;
const GAP_Y = 40;
const PAD = 48;

export interface FlowPort {
  readonly x: number;
  readonly y: number;
  readonly side?: 'gte' | 'lt';
}
export interface FlowNode {
  readonly node: DraftNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly input: FlowPort;
  /** One output for most steps; two (at or above / below) for a branch. */
  readonly outputs: readonly FlowPort[];
}
export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly when?: 'gte' | 'lt';
  readonly path: string;
  /** Midpoint, where the "insert a step here" control sits. */
  readonly mid: { readonly x: number; readonly y: number };
  readonly label?: { readonly x: number; readonly y: number; readonly text: string };
}
export interface FlowLayout {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly width: number;
  readonly height: number;
}

const outEdges = (g: DraftGraph, id: string) => g.edges.filter((e) => e.from === id);
const inEdges = (g: DraftGraph, id: string) => g.edges.filter((e) => e.to === id);
const heightOf = (n: DraftNode) => (n.kind === 'branch' ? FLOW_BRANCH_H : FLOW_NODE_H);

/** Column = longest distance from a start; row = branch side. A node nothing connects to still gets its own row, so nothing is hidden. */
function grid(g: DraftGraph): { depth: Map<string, number>; row: Map<string, number> } {
  const depth = new Map<string, number>();
  const row = new Map<string, number>();
  let nextRow = 0;
  const place = (id: string, d: number, r: number, trail: Set<string>) => {
    if (trail.has(id)) return;
    if ((depth.get(id) ?? -1) < d) depth.set(id, d);
    if (!row.has(id)) row.set(id, r);
    const outs = [...outEdges(g, id)].sort((a, b) => (a.when === 'gte' ? -1 : 0) - (b.when === 'gte' ? -1 : 0));
    outs.forEach((e, i) => {
      let rr = row.get(id)!;
      if (i > 0) rr = ++nextRow;
      place(e.to, d + 1, rr, new Set([...trail, id]));
    });
  };
  for (const h of g.nodes.filter((n) => inEdges(g, n.id).length === 0)) {
    row.set(h.id, nextRow);
    place(h.id, 0, nextRow, new Set());
    nextRow++;
  }
  for (const n of g.nodes) if (!depth.has(n.id)) (depth.set(n.id, 0), row.set(n.id, nextRow++));
  return { depth, row };
}

/** A smooth curve leaving `a` to the right and arriving at `b` from the left. A connection that runs backwards loops out and around. */
export function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  if (b.x > a.x + 8) {
    const k = Math.max(48, (b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
  }
  const k = 72;
  const bend = (a.y + b.y) / 2 + (b.y >= a.y ? 56 : -56);
  return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${a.x + k} ${bend}, ${(a.x + b.x) / 2} ${bend} S ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
}

export function layoutFlow(g: DraftGraph): FlowLayout {
  if (g.nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const { depth, row } = grid(g);
  const taken = new Set<string>();
  const slots = g.nodes.map((n) => {
    let r = row.get(n.id) ?? 0;
    const d = depth.get(n.id) ?? 0;
    while (taken.has(`${d}:${r}`)) r++;
    taken.add(`${d}:${r}`);
    return { n, d, r };
  });
  // Rows are as tall as the tallest node in them, so a branch never overlaps the row below it.
  const rowH = new Map<number, number>();
  for (const s of slots) rowH.set(s.r, Math.max(rowH.get(s.r) ?? 0, heightOf(s.n)));
  const rowsSorted = [...rowH.keys()].sort((a, b) => a - b);
  const rowTop = new Map<number, number>();
  let y = PAD;
  for (const r of rowsSorted) {
    rowTop.set(r, y);
    y += rowH.get(r)! + GAP_Y;
  }
  const nodes: FlowNode[] = slots.map(({ n, d, r }) => {
    const h = heightOf(n);
    const x = PAD + d * (FLOW_NODE_W + GAP_X);
    const top = rowTop.get(r)! + (rowH.get(r)! - h) / 2;
    const outputs: FlowPort[] =
      n.kind === 'branch'
        ? [
            { x: x + FLOW_NODE_W, y: top + h * 0.32, side: 'gte' },
            { x: x + FLOW_NODE_W, y: top + h * 0.72, side: 'lt' },
          ]
        : [{ x: x + FLOW_NODE_W, y: top + h / 2 }];
    return { node: n, x, y: top, w: FLOW_NODE_W, h, input: { x, y: top + h / 2 }, outputs };
  });
  const at = new Map(nodes.map((p) => [p.node.id, p]));
  const edges: FlowEdge[] = g.edges.flatMap((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (a === undefined || b === undefined) return [];
    const port = a.outputs.find((p) => p.side === e.when) ?? a.outputs[0]!;
    const path = curve(port, b.input);
    const mid = { x: (port.x + b.input.x) / 2, y: (port.y + b.input.y) / 2 };
    const label = e.when !== undefined ? { x: port.x + 12, y: port.y - 8, text: e.when === 'gte' ? 'at or above' : 'below' } : undefined;
    return [
      {
        id: `${e.from}->${e.to}${e.when ?? ''}`,
        from: e.from,
        to: e.to,
        ...(e.when !== undefined ? { when: e.when } : {}),
        path,
        mid,
        ...(label !== undefined ? { label } : {}),
      },
    ];
  });
  const right = Math.max(...nodes.map((p) => p.x + p.w));
  const bottom = Math.max(...nodes.map((p) => p.y + p.h));
  // Leave room on the right for the "add a step" stub that ends the chain.
  return { nodes, edges, width: right + PAD + 64, height: bottom + PAD };
}
