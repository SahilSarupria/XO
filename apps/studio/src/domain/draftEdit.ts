import type { DraftEdge, DraftNode, DraftNodeKind } from '../platform/wire-studio';

/**
 * Pure edit operations on a workflow draft and its layout. Nothing here decides whether a graph is valid or runnable:
 * every result is sent to the platform for analysis, and what the platform says is what the editor shows. These only
 * keep an edit structurally tidy (no dangling edges, a spliced chain stays connected).
 */
export interface DraftGraph {
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
}
export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function nextNodeId(nodes: readonly DraftNode[]): string {
  const used = new Set(nodes.map((n) => n.id));
  for (let i = nodes.length; ; i++) if (!used.has(`n${i}`)) return `n${i}`;
}

const outOf = (g: DraftGraph, id: string) => g.edges.filter((e) => e.from === id);
const inTo = (g: DraftGraph, id: string) => g.edges.filter((e) => e.to === id);
const byId = (g: DraftGraph, id: string) => g.nodes.find((n) => n.id === id);
const without = (edges: readonly DraftEdge[], drop: readonly DraftEdge[]) => edges.filter((e) => !drop.includes(e));

/** The sink the chain currently ends at, from the first trigger; undefined for an empty graph. */
function tail(g: DraftGraph): DraftNode | undefined {
  let cur = g.nodes.find((n) => n.kind === 'trigger') ?? g.nodes[0];
  const seen = new Set<string>();
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = outOf(g, cur.id)[0];
    if (cur.kind === 'branch' || next === undefined) return cur;
    cur = byId(g, next.to);
  }
  return cur;
}

/** Where a new node would go if added now with `selectedId` selected, or why it cannot be added there. */
export function whereAdd(
  g: DraftGraph,
  selectedId: string | undefined,
): Verdict & { readonly after?: string; readonly side?: 'gte' | 'lt' } {
  const at = selectedId !== undefined ? byId(g, selectedId) : tail(g);
  if (at === undefined) return { ok: true };
  if (at.kind === 'branch') {
    const have = new Set(outOf(g, at.id).map((e) => e.when));
    const side = !have.has('gte') ? 'gte' : !have.has('lt') ? 'lt' : undefined;
    return side === undefined
      ? { ok: false, reason: 'Both sides of this branch already lead somewhere. Select a step on one side to add after it.' }
      : { ok: true, after: at.id, side };
  }
  if (outOf(g, at.id).length > 1) return { ok: false, reason: 'This step has several outgoing connections; only a branch may split.' };
  return { ok: true, after: at.id };
}

export function insertNode(g: DraftGraph, node: DraftNode, selectedId: string | undefined): DraftGraph {
  if (node.kind === 'trigger') {
    const heads = g.nodes.filter((n) => inTo(g, n.id).length === 0);
    return { nodes: [node, ...g.nodes], edges: [...heads.slice(0, 1).map((h) => ({ from: node.id, to: h.id })), ...g.edges] };
  }
  const where = whereAdd(g, selectedId);
  if (!where.ok || where.after === undefined) return { nodes: [...g.nodes, node], edges: g.edges };
  const after = where.after;
  if (where.side !== undefined) return { nodes: [...g.nodes, node], edges: [...g.edges, { from: after, to: node.id, when: where.side }] };
  const next = outOf(g, after)[0];
  if (next === undefined) return { nodes: [...g.nodes, node], edges: [...g.edges, { from: after, to: node.id }] };
  // Splice between `after` and its successor. A new branch keeps the old successor on its "at or above" side.
  const keep = node.kind === 'branch' ? { ...next, from: node.id, when: 'gte' as const } : { ...next, from: node.id };
  const { when: _w, ...incoming } = next;
  return { nodes: [...g.nodes, node], edges: [...without(g.edges, [next]), { ...incoming, to: node.id }, keep] };
}

/** Removes a node. A one-in, one-out node is cut out of the chain so what was around it stays connected; anything else just loses its edges. */
export function removeNode(g: DraftGraph, id: string): DraftGraph {
  const node = byId(g, id);
  if (node === undefined) return g;
  const ins = inTo(g, id);
  const outs = outOf(g, id);
  const nodes = g.nodes.filter((n) => n.id !== id);
  const rest = without(g.edges, [...ins, ...outs]);
  if (node.kind !== 'branch' && ins.length === 1 && outs.length === 1) {
    const inc = ins[0]!;
    return { nodes, edges: [...rest, { ...inc, to: outs[0]!.to }] };
  }
  return { nodes, edges: rest };
}

/** Moving swaps a step with its neighbour in a straight run of steps. Triggers and branches (and what sits on a branch's sides) stay put. */
export function canMove(g: DraftGraph, id: string, dir: 'earlier' | 'later'): Verdict {
  const n = byId(g, id);
  if (n === undefined) return { ok: false, reason: 'No such step.' };
  if (n.kind === 'trigger' || n.kind === 'branch')
    return { ok: false, reason: `A ${n.kind === 'trigger' ? 'start' : 'branch'} stays where it is; move the steps around it.` };
  const [a, b] = dir === 'earlier' ? [neighbour(g, id, 'before'), n] : [n, neighbour(g, id, 'after')];
  if (a === undefined || b === undefined)
    return { ok: false, reason: dir === 'earlier' ? 'This step is already first.' : 'This step is already last.' };
  if (a.kind === 'trigger' || a.kind === 'branch' || b.kind === 'trigger' || b.kind === 'branch')
    return { ok: false, reason: 'Steps cannot move past the start or a branch.' };
  if (inTo(g, a.id).length !== 1 || outOf(g, b.id).length > 1 || outOf(g, a.id).length !== 1 || inTo(g, b.id).length !== 1)
    return { ok: false, reason: 'These steps are not in a straight run.' };
  return { ok: true };
}
function neighbour(g: DraftGraph, id: string, which: 'before' | 'after'): DraftNode | undefined {
  const e = which === 'before' ? inTo(g, id) : outOf(g, id);
  if (e.length !== 1) return undefined;
  return byId(g, which === 'before' ? e[0]!.from : e[0]!.to);
}
export function moveNode(g: DraftGraph, id: string, dir: 'earlier' | 'later'): DraftGraph {
  if (!canMove(g, id, dir).ok) return g;
  const n = byId(g, id)!;
  const [a, b] = dir === 'earlier' ? [neighbour(g, id, 'before')!, n] : [n, neighbour(g, id, 'after')!];
  const into = inTo(g, a.id)[0]!;
  const between = outOf(g, a.id)[0]!;
  const outFrom = outOf(g, b.id)[0];
  const edges = without(g.edges, [into, between, ...(outFrom !== undefined ? [outFrom] : [])]);
  const { when, ...plain } = into;
  return {
    nodes: g.nodes,
    edges: [
      ...edges,
      { ...plain, ...(when !== undefined ? { when } : {}), to: b.id },
      { from: b.id, to: a.id },
      ...(outFrom !== undefined ? [{ ...outFrom, from: a.id }] : []),
    ],
  };
}

export function updateNode(g: DraftGraph, id: string, patch: { label?: string; config?: Readonly<Record<string, unknown>> }): DraftGraph {
  return {
    nodes: g.nodes.map((n) => {
      if (n.id !== id) return n;
      const label = patch.label !== undefined ? (patch.label.trim() === '' ? undefined : patch.label) : n.label;
      return { id: n.id, kind: n.kind, ...(label !== undefined ? { label } : {}), config: { ...n.config, ...(patch.config ?? {}) } };
    }),
    edges: g.edges,
  };
}

/** Points one side of a branch at a node (or at nothing). The node must not already be some other step's target; the platform checks the rest. */
export function setBranchTarget(g: DraftGraph, branchId: string, side: 'gte' | 'lt', targetId: string | undefined): DraftGraph {
  const kept = g.edges.filter((e) => !(e.from === branchId && e.when === side));
  return { nodes: g.nodes, edges: targetId === undefined ? kept : [...kept, { from: branchId, to: targetId, when: side }] };
}
/** Nodes a branch side could lead to: not the branch itself, not a trigger, and not reachable upstream (that would loop). */
export function branchTargets(g: DraftGraph, branchId: string, side: 'gte' | 'lt'): DraftNode[] {
  const upstream = new Set<string>([branchId]);
  const stack = [branchId];
  while (stack.length > 0)
    for (const e of inTo(g, stack.pop() as string)) if (!upstream.has(e.from)) (upstream.add(e.from), stack.push(e.from));
  const current = outOf(g, branchId).find((e) => e.when === side)?.to;
  return g.nodes.filter((n) => n.kind !== 'trigger' && !upstream.has(n.id) && (n.id === current || inTo(g, n.id).length === 0));
}
export const branchSide = (g: DraftGraph, branchId: string, side: 'gte' | 'lt'): string | undefined =>
  outOf(g, branchId).find((e) => e.when === side)?.to;

// ------------------------------------------------------------------ layout
export const NODE_W = 176;
export const NODE_H = 78;
const GAP_X = 56;
const GAP_Y = 40;
const PAD = 40;

export interface PlacedNode {
  readonly node: DraftNode;
  readonly x: number;
  readonly y: number;
}
export interface PlacedEdge {
  readonly id: string;
  readonly path: string;
  readonly when?: 'gte' | 'lt';
  readonly labelX: number;
  readonly labelY: number;
}
export interface DraftLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
  readonly width: number;
  readonly height: number;
}

/** Columns by distance from the start, rows by branch side (at-or-above first). Disconnected nodes get their own rows so nothing is hidden. */
export function layoutDraft(g: DraftGraph): DraftLayout {
  const depth = new Map<string, number>();
  const row = new Map<string, number>();
  let nextRow = 0;
  const place = (id: string, d: number, r: number, trail: Set<string>) => {
    if (trail.has(id)) return;
    if ((depth.get(id) ?? -1) < d) depth.set(id, d);
    if (!row.has(id)) row.set(id, r);
    const outs = [...outOf(g, id)].sort((a, b) => (a.when === 'gte' ? -1 : 0) - (b.when === 'gte' ? -1 : 0));
    outs.forEach((e, i) => {
      let rr = row.get(id)!;
      if (i > 0) rr = ++nextRow;
      place(e.to, d + 1, rr, new Set([...trail, id]));
    });
  };
  const heads = g.nodes.filter((n) => inTo(g, n.id).length === 0);
  for (const h of heads) {
    row.set(h.id, nextRow);
    place(h.id, 0, nextRow, new Set());
    nextRow++;
  }
  for (const n of g.nodes) if (!depth.has(n.id)) (depth.set(n.id, 0), row.set(n.id, nextRow++));
  // Branch rows may have been taken by an earlier chain; keep rows unique per column.
  const taken = new Set<string>();
  const placed: PlacedNode[] = g.nodes.map((n) => {
    let r = row.get(n.id) ?? 0;
    const d = depth.get(n.id) ?? 0;
    while (taken.has(`${d}:${r}`)) r++;
    taken.add(`${d}:${r}`);
    return { node: n, x: PAD + d * (NODE_W + GAP_X), y: PAD + r * (NODE_H + GAP_Y) };
  });
  const at = new Map(placed.map((p) => [p.node.id, p]));
  const edges: PlacedEdge[] = g.edges.flatMap((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (a === undefined || b === undefined) return [];
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    const path =
      x2 > x1
        ? `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`;
    return [
      {
        id: `${e.from}->${e.to}${e.when ?? ''}`,
        path,
        ...(e.when !== undefined ? { when: e.when } : {}),
        labelX: x1 + 14,
        labelY: (y1 + y2) / 2 - 6,
      },
    ];
  });
  const cols = Math.max(1, ...placed.map((p) => (p.x - PAD) / (NODE_W + GAP_X) + 1));
  const rows = Math.max(1, ...placed.map((p) => (p.y - PAD) / (NODE_H + GAP_Y) + 1));
  return {
    nodes: placed,
    edges,
    width: PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

export const KIND_LABEL: Readonly<Record<DraftNodeKind, string>> = {
  trigger: 'Start',
  compile: 'Compile',
  validate: 'Validate',
  capability: 'Capability',
  branch: 'Branch',
  human_review: 'Person reviews',
  action: 'Action',
};
