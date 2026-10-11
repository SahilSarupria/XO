import type { EvidenceId, ProcessId } from './ids.js';
import { ProcessId as mkProcessId, stableId } from './ids.js';
import type { ResourceNode, ResourceRef } from './environment-model.js';
import type { ValidationState } from './epistemic.js';

const STAGE_WORDS: readonly (readonly [string, RegExp])[] = [
  ['request', /request|po\b|order/i],
  ['invoice', /invoice|bill/i],
  ['approval', /approv|sign-?off/i],
  ['payment', /payment|paid|remit/i],
  ['receipt', /receipt|confirm/i],
  ['reconciliation', /reconcil|ledger/i],
];

export interface CandidateProcessStep {
  readonly resource: ResourceRef;
  readonly label: string;
  /** Hint taken from the file NAME only. A name is not evidence of what the file does. */
  readonly stageHint?: string;
  readonly observedAt: string;
  readonly evidence: readonly EvidenceId[];
}

/**
 * A process hypothesis. It records WHAT was seen (artifacts sharing an
 * identifier, with timestamps) and refuses to say more: `stepRelationship`
 * is always `observed_sequence_only` — temporal succession is not
 * causation, and a repeated pattern is not a business rule.
 */
export interface CandidateProcess {
  readonly id: ProcessId;
  readonly anchorIdentifier: string;
  readonly steps: readonly CandidateProcessStep[];
  /** What justifies the step ORDER. `established` only when every step has a distinct timestamp. */
  readonly order: {
    readonly basis: 'file_modified_time';
    readonly established: boolean;
    readonly evidence: readonly EvidenceId[];
  };
  readonly stepRelationship: 'observed_sequence_only';
  readonly status: 'candidate_hypothesis';
  readonly validation: ValidationState;
  readonly humanReviewRequired: true;
  readonly alternativeExplanations: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly requiredCapabilities: { readonly status: 'unresolved'; readonly note: string };
}

export const MIN_STEPS_FOR_CANDIDATE_PROCESS = 3;

/**
 * Proposes candidate processes from resources that share one business
 * identifier. Intentionally minimal: it demonstrates the evidence contract
 * for process discovery, not process mining. It never marks anything
 * validated, never infers a rule, and always requires human review.
 */
export function proposeCandidateProcesses(resources: readonly ResourceNode[]): readonly CandidateProcess[] {
  const byIdentifier = new Map<string, ResourceNode[]>();
  for (const r of resources) {
    for (const tie of r.identifiers) {
      const list = byIdentifier.get(tie.value) ?? [];
      if (!list.includes(r)) list.push(r);
      byIdentifier.set(tie.value, list);
    }
  }
  const processes: CandidateProcess[] = [];
  for (const identifier of [...byIdentifier.keys()].sort()) {
    const group = byIdentifier.get(identifier) ?? [];
    if (group.length < MIN_STEPS_FOR_CANDIDATE_PROCESS) continue;
    const ordered = [...group].sort((a, b) =>
      a.modifiedAt < b.modifiedAt ? -1 : a.modifiedAt > b.modifiedAt ? 1 : a.ref.resourceKey < b.ref.resourceKey ? -1 : 1,
    );
    const steps: CandidateProcessStep[] = ordered.map((r) => {
      const hint = STAGE_WORDS.find(([, re]) => re.test(r.name))?.[0];
      return {
        resource: r.ref,
        label: r.name,
        ...(hint !== undefined ? { stageHint: hint } : {}),
        observedAt: r.modifiedAt,
        evidence: r.evidenceIds,
      };
    });
    const distinctTimes = new Set(ordered.map((r) => r.modifiedAt)).size;
    const established = distinctTimes === ordered.length;
    processes.push({
      id: mkProcessId(stableId('proc', [identifier, ...ordered.map((r) => `${r.ref.sourceId}/${r.ref.resourceKey}`)])),
      anchorIdentifier: identifier,
      steps,
      order: { basis: 'file_modified_time', established, evidence: ordered.flatMap((r) => r.evidenceIds) },
      stepRelationship: 'observed_sequence_only',
      status: 'candidate_hypothesis',
      validation: 'not_validated',
      humanReviewRequired: true,
      alternativeExplanations: [
        'Modified times reflect when files were last written or copied, not when the business step happened.',
        'Files sharing an identifier may be unrelated references (for example a template or a reused number).',
        'The real process may include steps that left no file in the approved scope.',
        ...(established ? [] : ['Some steps share identical timestamps, so their order cannot be determined from this evidence.']),
      ],
      missingEvidence: [
        'No event history or audit log establishes that one step caused or enabled the next.',
        'No documented procedure or policy was linked to confirm the steps or their conditions.',
        'No record shows who performed each step or whether approvals were required.',
      ],
      requiredCapabilities: {
        status: 'unresolved',
        note: 'Mapping steps to validated XO capabilities (capability-contract / workflow-composer) has not been attempted; this candidate is not executable.',
      },
    });
  }
  return processes;
}
