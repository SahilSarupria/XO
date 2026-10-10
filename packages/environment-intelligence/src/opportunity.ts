import type { EvidenceId, ProcessId } from './ids.js';

/**
 * CONTRACT ONLY (Layer 7). Nothing in this milestone produces these.
 *
 * An automation opportunity is a *question put to the platform*, not a
 * decision: "this observed/candidate process might be automatable, if
 * these capabilities exist and these gaps are closed". It is deliberately
 * unable to carry an executable workflow, a permission grant, or a
 * promoted status. Composition from validated capabilities belongs to the
 * workflow-composer / P1.7 work through the authoritative capability
 * contracts; this type is where that work will attach.
 */
export interface AutomationOpportunityCandidate {
  readonly processId: ProcessId;
  readonly summary: string;
  readonly supportingEvidence: readonly EvidenceId[];
  readonly assumptions: readonly string[];
  readonly missingInputs: readonly string[];
  /** Capabilities that would have to exist and be validated by the platform. Names/ids only, resolved elsewhere. */
  readonly requiredCapabilities: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly validationRequirements: readonly string[];
  readonly status: 'candidate';
  readonly executable: false;
}
