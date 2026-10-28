import type { Capability, Workflow } from '../platform/wire';
import type { DraftEdge, DraftNode } from '../platform/wire-studio';

export interface DraftContent {
  readonly name: string;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
}

/**
 * The saved copy of a derived process: a start node, then one node per step in order, joined in a line.
 * Only structure is written; whether it is valid or runnable is the platform's analysis, never decided here.
 */
export function draftFromWorkflow(w: Workflow, caps: readonly Capability[] | undefined): DraftContent {
  const byId = new Map((caps ?? []).map((c) => [c.capabilityId, c]));
  const steps = [...w.steps].sort((a, b) => a.order - b.order);
  const nodes: DraftNode[] = [{ id: 'n0', kind: 'trigger', label: 'Start', config: {} }];
  const edges: DraftEdge[] = [];
  steps.forEach((s, i) => {
    const id = `n${i + 1}`;
    const human = byId.get(s.capabilityId)?.executionClass === 'human_in_the_loop';
    nodes.push({ id, kind: human ? 'human_review' : 'capability', label: s.name, config: { capabilityId: s.capabilityId } });
    edges.push({ from: nodes[i]!.id, to: id });
  });
  return { name: `${w.name} (draft)`, nodes, edges };
}
