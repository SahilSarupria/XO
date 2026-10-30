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
/** The platform's limits for what a draft stores (name and labels 120, ids and package label 200). Longer text is cut with an ellipsis, never rejected on Save. */
export const MAX_DRAFT_NAME = 120;
export const MAX_NODE_LABEL = 120;
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

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
      label: clip(s.name, MAX_NODE_LABEL),
      // `packageName` is only a label for the author; the platform binds by compilation and capability id.
      config: { packageName: clip(w.name, 200), capabilityId: s.capabilityId, memoryScope: 'none', compilationId: w.compilationId },
    });
    if (byId.get(s.capabilityId)?.executionClass === 'human_in_the_loop')
      add({ id: `n${nodes.length}`, kind: 'human_review', label: clip(`A person reviews: ${s.name}`, MAX_NODE_LABEL), config: {} });
  });
  return { name: `${clip(w.name, MAX_DRAFT_NAME - ' (draft)'.length)} (draft)`, nodes, edges };
}
