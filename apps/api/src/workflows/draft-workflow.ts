import type { XoError } from '@xo/errors';
import type { ApprovalStore } from '../approvals/approval.js';
import { deriveCapabilityApprovalState } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import type { CompilationStore } from '../compilations/compilation.js';
import type { CapabilityFact, CompilationFacts, DraftFacts } from '../workflow-definitions/definition.js';
import { composeCompilationWorkflows, resolveWorkflow } from './workflow-catalog.js';

/** Id prefix of a run started from a saved draft. The rest is the draft's definition id. */
export const DRAFT_WORKFLOW_PREFIX = 'draft:';
export const isDraftWorkflowId = (workflowId: string): boolean => workflowId.startsWith(DRAFT_WORKFLOW_PREFIX);

/**
 * Reads, from stored compilations only, what the platform knows about each capability a draft names: name, declared
 * confidence, binding class and approval. Never client-supplied; the same calls the derived-workflow list makes.
 */
export async function loadDraftFacts(
  stores: { readonly workspaceId: string; readonly compilationStore: CompilationStore; readonly approvalStore: ApprovalStore },
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
        // Approved means approved for the capability's CURRENT material state (P1.0 M3), exactly as the derived-workflow list decides it.
        const verdict = await verifyApproval(
          stores.approvalStore,
          { workspaceId: stores.workspaceId, compilationId, capabilityId: step.capabilityId },
          deriveCapabilityApprovalState(composed.value.graph, step.capabilityId, compilation.value.sourceDigestSha256),
        );
        const klass = bridge?.status === 'bound' ? bridge.implementationClass : undefined;
        capabilities.set(step.capabilityId, {
          name: step.capabilityName,
          confidence: step.confidence,
          ...(klass === 'deterministic_rule' || klass === 'human_in_the_loop' ? { executionClass: klass } : {}),
          ...(bridge?.status !== 'bound' ? { unbound: bridge?.reason ?? 'no binding was found for it' } : {}),
          approved: verdict.ok && verdict.value.approved,
        });
      }
    }
    facts.set(compilationId, { ok: true, capabilities });
  }
  return facts;
}
