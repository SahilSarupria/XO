import { ErrorCode, XoError } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import type { XoirGraph, XoirNodeId } from '@xo/xoir';
import {
  CandidateWorkflowId,
  CandidateWorkflowStepId,
  composeWorkflows,
  type CandidateWorkflow,
  type CandidateWorkflowStep,
  type WorkflowGap,
} from '@xo/workflow-composer';
import type { ApprovalStore } from '../approvals/approval.js';
import { isApproved } from '../approvals/approval.js';
import type { CompilationStore } from '../compilations/compilation.js';
import type { CapabilityFact, CompilationFacts, DraftFacts } from '../workflow-definitions/definition.js';
import { composeCompilationWorkflows, resolveWorkflow } from './workflow-catalog.js';

/** Id prefix of a run started from a saved draft. The rest is the draft's definition id. */
export const DRAFT_WORKFLOW_PREFIX = 'draft:';
export const isDraftWorkflowId = (workflowId: string): boolean => workflowId.startsWith(DRAFT_WORKFLOW_PREFIX);

/** Gaps that make a set of capabilities unsafe to run together regardless of who chose the order. Ordering gaps are the author's call in a draft. */
const HARD_GAPS: ReadonlySet<string> = new Set(['circular_dependency', 'conflicting_capabilities', 'declared_dependency_unresolved']);

/**
 * Reads, from stored compilations only, what the platform knows about each capability a draft names: name, declared
 * confidence, binding class and approval. Never client-supplied; the same calls the derived-workflow list makes.
 */
export async function loadDraftFacts(
  stores: { readonly compilationStore: CompilationStore; readonly approvalStore: ApprovalStore },
  compilationIds: Iterable<string>,
): Promise<DraftFacts> {
  const facts = new Map<string, CompilationFacts>();
  for (const compilationId of new Set(compilationIds)) {
    const compilation = await stores.compilationStore.get(compilationId);
    if (!compilation.ok) {
      facts.set(compilationId, { ok: false, reason: 'it does not exist in this workspace' });
      continue;
    }
    if (compilation.value.status !== 'succeeded') {
      facts.set(compilationId, { ok: false, reason: `its status is "${compilation.value.status}", only a succeeded compilation can run` });
      continue;
    }
    const graphJson = await stores.compilationStore.getCompiledGraph(compilationId);
    const composed = graphJson.ok
      ? composeCompilationWorkflows(graphJson.value, compilation.value.completedAt ?? compilation.value.createdAt)
      : undefined;
    if (!graphJson.ok || composed === undefined || !composed.ok) {
      const error = !graphJson.ok ? graphJson.error : (composed as { error: XoError }).error;
      facts.set(compilationId, { ok: false, reason: error.message });
      continue;
    }
    const capabilities = new Map<string, CapabilityFact>();
    for (const workflow of composed.value.workflows) {
      const resolved = resolveWorkflow(composed.value.graph, workflow);
      for (const step of workflow.steps) {
        const bridge = resolved.prepared.steps.find((s) => s.capabilityId === step.capabilityId);
        const approval = await stores.approvalStore.get(compilationId, step.capabilityId);
        const klass = bridge?.status === 'bound' ? bridge.implementationClass : undefined;
        capabilities.set(step.capabilityId, {
          name: step.capabilityName,
          confidence: step.confidence,
          ...(klass === 'deterministic_rule' || klass === 'human_in_the_loop' ? { executionClass: klass } : {}),
          ...(bridge?.status !== 'bound' ? { unbound: bridge?.reason ?? 'no binding was found for it' } : {}),
          approved: approval.ok && isApproved(approval.value),
        });
      }
    }
    facts.set(compilationId, { ok: true, capabilities });
  }
  return facts;
}

/**
 * A `CandidateWorkflow` for the steps a draft's path takes, in the author's order. Step metadata (name, contract id,
 * confidence, evidence) is copied from what the composer derived for the same capabilities; nothing is invented.
 * Hard gaps (cycles, conflicts, unresolved dependencies) are kept so the existing executability audit still refuses
 * them; ordering-only gaps are dropped because the order here is the author's explicit choice.
 */
export function buildDraftCandidate(
  graph: XoirGraph,
  workflowId: string,
  name: string,
  capabilityIds: readonly string[],
  now: string,
): Result<CandidateWorkflow, XoError> {
  const composed = composeWorkflows(graph, { capabilityNodeIds: capabilityIds as readonly XoirNodeId[], now: () => now });
  if (!composed.ok) return err(new XoError(composed.error.code as never, composed.error.message));
  const known = new Map<string, CandidateWorkflowStep>();
  const gaps: WorkflowGap[] = [];
  for (const w of composed.value) {
    for (const s of w.steps) known.set(s.capabilityId, s);
    for (const g of w.gaps) if (HARD_GAPS.has(g.kind)) gaps.push(g);
  }
  const steps: CandidateWorkflowStep[] = [];
  for (const [order, capabilityId] of capabilityIds.entries()) {
    const base = known.get(capabilityId);
    if (base === undefined)
      return err(
        new XoError(ErrorCode.WORKFLOW_NOT_EXECUTABLE, `capability "${capabilityId}" is not a capability of the stored compilation`),
      );
    steps.push({ ...base, id: CandidateWorkflowStepId(`${capabilityId}#${order}`), order });
  }
  return ok({
    id: CandidateWorkflowId(workflowId),
    name,
    description: 'Author-ordered steps of a saved workflow draft.',
    steps,
    sourceCapabilityIds: [...capabilityIds],
    gaps,
    requiresHumanDecision: gaps.length > 0,
    confidence: steps.reduce((m, s) => Math.min(m, s.confidence), 1),
    generatedAt: now,
  });
}
