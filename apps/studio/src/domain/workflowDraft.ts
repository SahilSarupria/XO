import type { Capability, Workflow } from '../platform/wire';
import type { DraftEdge, DraftNode } from '../platform/wire-studio';

export interface DraftContent {
  readonly name: string;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
}

/**
 * The saved copy of a derived process: a manual start, then one capability node per step in order, joined in a line,
 * each naming the compilation it comes from. A step that asks a person also gets the review node the platform
 * requires to follow it. Only structure is written; whether it is valid or runnable is the platform's analysis, never decided here.
 */
export function draftFromWorkflow(w: Workflow, caps: readonly Capability[] | undefined): DraftContent {
  const byId = new Map((caps ?? []).map((c) => [c.capabilityId, c]));
  const steps = [...w.steps].sort((a, b) => a.order - b.order);
  const nodes: DraftNode[] = [{ id: 'n0', kind: 'trigger', label: 'Start', config: { type: 'manual' } }];
  const edges: DraftEdge[] = [];
  const add = (node: DraftNode) => {
    edges.push({ from: nodes[nodes.length - 1]!.id, to: node.id });
    nodes.push(node);
  };
  steps.forEach((s) => {
    add({
      id: `n${nodes.length}`,
      kind: 'capability',
      label: s.name,
      // `packageName` is only a label for the author; the platform binds by compilation and capability id.
      config: { packageName: w.name, capabilityId: s.capabilityId, memoryScope: 'none', compilationId: w.compilationId },
    });
    if (byId.get(s.capabilityId)?.executionClass === 'human_in_the_loop')
      add({ id: `n${nodes.length}`, kind: 'human_review', label: `A person reviews: ${s.name}`, config: {} });
  });
  return { name: `${w.name} (draft)`, nodes, edges };
}
