import type { ModelProvider } from '@xo/ai-core';
import { PermanentError, TreeSandbox, xoWorkflow, type NetworkIsolation, type Trigger, type WorkflowDefinition } from '@xo/automation';
import { createCapabilityLayer, XoExecutor } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import { OUTPUT_CONTRACT } from './gold-xo.js';

export interface FreightAutomationOptions {
  readonly bundle: PackageBundle;
  readonly triggers: readonly Trigger[];
  /** Fallback for claims that arrive as free text only. Omit for a fully offline, deterministic-only desk (such claims go to a human). */
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly networkIsolation?: NetworkIsolation;
  readonly maxModelCallsPerRun?: number;
  readonly maxRunsPerMinute?: number;
  readonly sandbox?: TreeSandbox;
  /** The system the operator trusts to supply structured facts (default 'claim_intake_system'). Recorded in the load receipt. */
  readonly trustedFactSource?: string;
  /** Explicit, recorded opt-out of the package's grounding requirement (e.g. a simulated model that supplies no evidence in tests). */
  readonly groundingWaiver?: { readonly reason: string; readonly approvedBy?: string };
}

/**
 * Payload contract for an automated claim: `{ claim_id, narrative?, facts? }`.
 * `facts` (a structured intake) is solved locally with no model call; a bare
 * `narrative` needs the model, which may only *propose* — the decision tree and
 * safety gate still decide.
 */
export function freightClaimWorkflow(o: FreightAutomationOptions): {
  workflow: WorkflowDefinition;
  sandbox: TreeSandbox;
  executor: XoExecutor;
} {
  const sandbox = o.sandbox ?? new TreeSandbox({ networkIsolation: o.networkIsolation ?? 'required' });
  // The operator names the system that is allowed to supply structured facts; every structured fact this desk accepts is attributed to it
  // (and the name is recorded in the signed load receipt). Narrative-only claims go through the grounded model path.
  const factSource = o.trustedFactSource ?? 'claim_intake_system';
  const layer = createCapabilityLayer(o.bundle, {
    host: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    trustedFactSources: [factSource],
    ...(o.groundingWaiver !== undefined ? { requireEvidence: false, groundingWaiver: o.groundingWaiver } : {}),
  });
  const trees = JSON.parse(new TextDecoder().decode(o.bundle.components.find((c) => c.kind === 'decision_trees')!.data));
  const executor = new XoExecutor(
    layer,
    {
      preamble: OUTPUT_CONTRACT,
      cache: true,
      temperature: 0,
      knowledgeK: 9,
      evaluate: (tree, facts) => sandbox.evaluate(tree, facts),
      ...(o.provider !== undefined && o.model !== undefined ? { provider: o.provider, model: o.model } : {}),
      ...(o.maxModelCallsPerRun !== undefined ? { maxModelCalls: o.maxModelCallsPerRun } : {}),
    },
    trees,
  );
  const workflow = xoWorkflow({
    id: 'freight-claims',
    triggers: o.triggers,
    executor,
    ...(o.maxRunsPerMinute !== undefined ? { maxRunsPerMinute: o.maxRunsPerMinute } : {}),
    parse: (payload) => {
      if (typeof payload !== 'object' || payload === null) throw new PermanentError('claim payload must be a JSON object');
      const p = payload as { claim_id?: unknown; narrative?: unknown; facts?: unknown };
      const facts = typeof p.facts === 'object' && p.facts !== null ? (p.facts as Record<string, unknown>) : undefined;
      const narrative = typeof p.narrative === 'string' ? p.narrative : undefined;
      if (facts === undefined && narrative === undefined) throw new PermanentError('claim needs `facts` and/or `narrative`');
      return {
        text: narrative ?? JSON.stringify(facts),
        ...(facts !== undefined ? { facts } : {}),
        ...(facts !== undefined ? { provenance: Object.fromEntries(Object.keys(facts).map((k) => [k, { kind: 'system_of_record' as const, source: factSource }])) } : {}),
        ...(typeof p.claim_id === 'string' ? { caseId: p.claim_id } : {}),
      };
    },
    route: (out) => {
      const d = out['decision'];
      if (d === 'escalate')
        return {
          lane: `escalations/${String(out['escalation_target'] ?? 'Claims Manager').replace(/[^A-Za-z0-9 _-]/g, '')}`,
          disposition: 'needs_human',
        };
      if (d === 'approve' || d === 'partial') return { lane: 'decisions/approved', disposition: 'completed' };
      if (d === 'deny') return { lane: 'decisions/denied', disposition: 'completed' };
      return { lane: 'needs-review', disposition: 'needs_human' };
    },
  });
  return { workflow, sandbox, executor };
}
