/** ProcedureDefinition v1 — M1 subset. Every field here is client-authored STRUCTURE only. */
export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'truthy' | 'falsy';

export interface ProcedureCondition {
  readonly path: string;
  readonly op: ConditionOp;
  readonly value?: unknown;
}

export type BindingSource = { readonly input: string } | { readonly step: string; readonly output: string };

export interface InputBinding {
  readonly param: string;
  readonly from: BindingSource;
  readonly bindingStatus?: 'proven' | 'author_asserted';
  readonly reason?: string;
}

export interface EvidenceRef {
  readonly documentPath: string;
  readonly sectionPath?: readonly string[];
}

export interface CapabilityStep {
  readonly id: string;
  readonly kind: 'capability';
  readonly capabilityId: string;
  readonly contractId?: string;
  readonly do?: string;
  readonly inputBindings?: readonly InputBinding[];
  readonly basis?: 'source_proven' | 'source_suggested' | 'author_asserted';
  readonly evidence?: readonly EvidenceRef[];
  readonly onFailure?: 'fail' | 'hold_for_human';
  /** ADVISORY ONLY (owner O-2): read|write, escalation-only. Never establishes authoritative effect classification (unresolved; M1/M4 later). */
  readonly effectIntent?: 'read' | 'write';
  /** Sequence edge. Absent = terminal step. */
  readonly next?: string;
}

export interface DecisionStep {
  readonly id: string;
  readonly kind: 'decision';
  readonly condition: ProcedureCondition;
  readonly then: string;
  readonly else: string;
}

export type ProcedureStep = CapabilityStep | DecisionStep;

export interface ProcedureDefinition {
  readonly schema: 'xo.procedure/1';
  readonly procedureId: string;
  readonly version: number;
  readonly title?: string;
  /** Evidence basis as authored. Shape-checked only; hash-drift verification needs the server registry (M2). */
  readonly compilationRef?: { readonly compilationId: string; readonly graphHash: string };
  readonly derivedFrom?: { readonly candidateWorkflowId: string };
  readonly when?: readonly ProcedureCondition[];
  readonly steps: readonly ProcedureStep[];
  readonly then?: readonly ProcedureCondition[];
  readonly unknowns?: readonly string[];
}
