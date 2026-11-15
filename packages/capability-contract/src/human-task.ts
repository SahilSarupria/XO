import type { HumanTaskContract, SemanticCapabilityContract } from './types.js';

/** XOIR capability-node metadata keys the compiler's procedure-step extractor writes (`@xo/compiler` `procedure-extractor.ts`). */
export const STEP_METADATA = {
  understanding: 'understanding',
  manualStep: 'manual-step',
  actions: 'step.actions',
  doneWhen: 'step.doneWhen',
  owner: 'step.owner',
  qualityReview: 'quality.review',
} as const;

function outcomeSchema(outputs: readonly { readonly name: string }[]): HumanTaskContract['outcomeSchema'] {
  const properties: Record<string, { readonly type: 'boolean' | 'string' }> = { completed: { type: 'boolean' } };
  for (const o of outputs) if (o.name.trim() !== '' && o.name !== 'completed') properties[o.name] = { type: 'string' };
  return { type: 'object', properties, required: ['completed'] };
}

/**
 * The human task contract a procedure step's own metadata states, or `undefined` when the capability is not a manual step
 * (or its text is suspected to be an extraction error — such a step must be reviewed, never routed to a person as is).
 */
export function procedureStepHumanTask(
  metadata: Readonly<Record<string, unknown>> | undefined,
  description: string,
  inputs: readonly { readonly name: string }[],
  outputs: readonly { readonly name: string }[],
): HumanTaskContract | undefined {
  if (metadata === undefined || metadata[STEP_METADATA.understanding] !== STEP_METADATA.manualStep) return undefined;
  if (metadata[STEP_METADATA.qualityReview] === 'possible-extraction-error') return undefined;
  const actions = typeof metadata[STEP_METADATA.actions] === 'string' ? (metadata[STEP_METADATA.actions] as string).trim() : '';
  const instruction = actions !== '' ? actions : description.trim();
  if (instruction === '') return undefined;
  const doneWhen = typeof metadata[STEP_METADATA.doneWhen] === 'string' ? (metadata[STEP_METADATA.doneWhen] as string).trim() : '';
  const owner = typeof metadata[STEP_METADATA.owner] === 'string' ? (metadata[STEP_METADATA.owner] as string).trim() : '';
  return {
    origin: 'procedure-step',
    instruction,
    ...(doneWhen !== '' ? { doneWhen } : {}),
    actorRole: owner !== '' ? { value: owner, derivation: 'stated' } : { value: 'unassigned', derivation: 'unassigned' },
    requiredInputs: inputs.map((i) => i.name),
    outcomeSchema: outcomeSchema(outputs),
  };
}

/**
 * THE human-task rule (ADR 0029 decision 11). A contract has a human task contract when, and only when:
 *
 *   - it carries one the source states (a procedure step: `contract.humanTask`), or
 *   - it is a prose capability with no rules and at least one linked action/process knowledge node, whose own source
 *     sentence is the instruction.
 *
 * Under the same evidence both paths give the same answer; without either, the answer is `undefined` and the step stays
 * unresolved. A contract with rules is never a human task here: its rules are the deterministic resolver's to compile.
 */
export function humanTaskContractOf(contract: SemanticCapabilityContract): HumanTaskContract | undefined {
  if ((contract.rules ?? []).length > 0) return undefined;
  if (contract.humanTask !== undefined) return contract.humanTask;
  if ((contract.actionKnowledgeRefs ?? []).length === 0) return undefined;
  // `??`: an embedded contract from an older compiler may lack any of these; the rule must not depend on them being there.
  const instruction = (contract.description ?? '').trim() || (contract.name ?? '').trim();
  if (instruction === '') return undefined;
  return {
    origin: 'action-knowledge',
    instruction,
    actorRole: { value: 'unassigned', derivation: 'unassigned' },
    requiredInputs: (contract.inputs ?? []).map((i) => i.name),
    outcomeSchema: outcomeSchema(contract.outputs ?? []),
  };
}
