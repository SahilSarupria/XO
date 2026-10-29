import type { Capability, WorkflowStepSummary } from '../platform/wire';

/**
 * A read-only picture of a process: the platform's steps, in the platform's own order, joined by the order they run in.
 * XO composes processes as a sequence, so the picture is a chain; it does not invent branches, triggers or timings.
 */
export interface GraphNode {
  readonly id: string;
  readonly index: number;
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  /** `human`: the step's own execution class says a person decides here. */
  readonly kind: 'capability' | 'human';
  readonly x: number;
  readonly y: number;
}
export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly path: string;
}
export interface GraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

export const NODE_W = 176;
export const NODE_H = 78;
const GAP_X = 52;
const GAP_Y = 64;
const PAD = 40;
export const COLUMNS = 6;

export function layoutGraph(steps: readonly WorkflowStepSummary[], caps: readonly Capability[] | undefined): GraphLayout {
  const byId = new Map((caps ?? []).map((c) => [c.capabilityId, c]));
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  const nodes = ordered.map<GraphNode>((s, i) => ({
    id: `${s.capabilityId}#${i}`,
    index: i,
    capabilityId: s.capabilityId,
    name: s.name,
    description: s.description,
    kind: byId.get(s.capabilityId)?.executionClass === 'human_in_the_loop' ? 'human' : 'capability',
    x: PAD + (i % COLUMNS) * (NODE_W + GAP_X),
    y: PAD + Math.floor(i / COLUMNS) * (NODE_H + GAP_Y),
  }));
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const sameRow = a.y === b.y;
    const path = sameRow
      ? `M ${a.x + NODE_W} ${a.y + NODE_H / 2} C ${a.x + NODE_W + GAP_X / 2} ${a.y + NODE_H / 2}, ${b.x - GAP_X / 2} ${b.y + NODE_H / 2}, ${b.x} ${b.y + NODE_H / 2}`
      : `M ${a.x + NODE_W / 2} ${a.y + NODE_H} C ${a.x + NODE_W / 2} ${a.y + NODE_H + GAP_Y / 2}, ${b.x + NODE_W / 2} ${b.y - GAP_Y / 2}, ${b.x + NODE_W / 2} ${b.y}`;
    edges.push({ id: `${a.id}->${b.id}`, from: a.id, to: b.id, path });
  }
  const cols = Math.min(Math.max(nodes.length, 1), COLUMNS);
  const rows = Math.max(Math.ceil(nodes.length / COLUMNS), 1);
  return {
    nodes,
    edges,
    width: PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

/** The status shown beside the workflow's name, from the same facts the Workflows list uses. */
export function workflowStatus(args: { executable: boolean; needApproval: number; canStart: boolean; activeLabel: string | undefined }): {
  label: string;
  tone: 'success' | 'warning' | 'neutral';
} {
  if (args.activeLabel !== undefined) return { label: args.activeLabel, tone: 'neutral' };
  if (!args.executable) return { label: 'Cannot run yet', tone: 'warning' };
  if (args.needApproval > 0) return { label: 'Needs approval', tone: 'warning' };
  return args.canStart ? { label: 'Ready', tone: 'success' } : { label: 'Checking…', tone: 'neutral' };
}

export function formatOutput(output: unknown, max = 1200): string {
  let text: string;
  try {
    text = typeof output === 'string' ? output : (JSON.stringify(output, null, 2) ?? String(output));
  } catch {
    text = String(output);
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
