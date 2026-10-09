import type { ObservedSourceReport } from './attribution.js';
import type { ExpectedWorkflowRunStatus, Resolution, WorkflowExecutability } from './definition.js';

/**
 * What the REAL XO pipeline actually produced for one benchmark case —
 * captured per stage so a compile/semantic failure is always
 * distinguishable from a contract/binding failure, a workflow-composition
 * failure, or a runtime execution failure. Everything here is a plain,
 * JSON-serializable projection of the real pipeline's own outputs
 * (`@xo/compiler`, `@xo/xoir`, `@xo/capability-contract`,
 * `@xo/workflow-composer`, `@xo/runtime`); nothing is synthesized.
 */

export type StageName = 'compile' | 'capabilities' | 'workflows' | 'execution';
export const STAGE_ORDER: readonly StageName[] = ['compile', 'capabilities', 'workflows', 'execution'];

export interface StageStatus {
  readonly stage: StageName;
  /** `not_requested`: nothing asked this stage to run (e.g. no execution cases); `skipped`: an earlier stage failed or the entry point bypasses it. */
  readonly status: 'ok' | 'failed' | 'skipped' | 'not_requested';
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly note?: string;
}

export interface ObservedSourceRef {
  readonly documentPath: string;
  readonly locator?: string;
  readonly pages?: readonly number[];
}

/**
 * P0.9C Step 5 — capability provenance as the P0.9B projection (`projectAllCapabilityProvenance`) reports it, verbatim, with `documentPath`
 * mapped to the declared source path exactly as node refs are. `contractContentHashRecomputed` is a SECOND projection of the same graph,
 * so determinism of the content hash is observed, not assumed. Not part of any stage fingerprint.
 */
import type { PathView } from './cross-path.js';

export interface ObservedCapabilityProvenance {
  readonly capabilityId: string;
  readonly name: string;
  readonly contractId: string;
  readonly contractContentHash: string;
  readonly contractContentHashRecomputed: string;
  readonly graphHash: string;
  readonly binding: { readonly status: 'resolved' | 'unresolved' | 'ambiguous' | 'denied'; readonly bindingId?: string; readonly implementationClass?: string };
  readonly sourceXoirNodeIds: readonly string[];
  readonly sourceRefs: readonly ObservedSourceRef[];
}

export type ObservedAgreement = 'match' | 'mismatch' | 'unknown';

/**
 * What an execution RECORDED (the runtime's pass-through fields, verbatim) next to P0.9B's `projectExecutionProvenance` agreement against the
 * live-graph view. `unknown` = one side absent — never a failure. Present only for executions that actually ran.
 */
export interface ObservedExecutionProvenance {
  readonly recorded: { readonly contractId?: string; readonly bindingId?: string; readonly sourceXoirNodeIds?: readonly string[]; readonly graphHash?: string; readonly contractContentHash?: string };
  /** `false` when no live-graph projection existed for the executed capability (agreement is then all `unknown`). */
  readonly graphViewAvailable: boolean;
  readonly agreement: { readonly graphHash: ObservedAgreement; readonly contractContentHash: ObservedAgreement; readonly bindingId: ObservedAgreement; readonly contractId: ObservedAgreement };
}

export interface ObservedNode {
  readonly id: string;
  readonly kind: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence: number;
  readonly sourceRefs: readonly ObservedSourceRef[];
  /** P0.9A `XoirNodeMetadata.producedBy`, verbatim. ABSENT when the node carries none (P0.9A leaves some node classes unattributed by design) — never defaulted. Attribution context only in P0.9C Step 1; not part of any stage fingerprint or metric. */
  readonly producedBy?: string;
  /** P0.9C Step 4: `XoirNodeMetadata.subtype`, verbatim (the creating pipeline's own node type — knowledge type or reasoning type). ABSENT when the node carries none. Used only to classify the node's creation path; not part of any stage fingerprint. */
  readonly subtype?: string;
}

/** `not_executable`: no lowered executable declaration exists — see `ObservedCapability.resolution`/`reason` for why. */
export type ObservedExecutionClass = 'deterministic_rule' | 'human_in_the_loop' | 'model' | 'hybrid' | 'not_executable';

export interface ObservedParam {
  readonly name: string;
  readonly runtimeKey: string;
  readonly semanticType: string;
  readonly derivedFrom?: string;
}

export interface ObservedCapability {
  /** The XOIR capability node id (== the contract id). */
  readonly capabilityId: string;
  readonly name: string;
  readonly resolution: Resolution;
  readonly executionClass: ObservedExecutionClass;
  /** Why no executable declaration exists (present iff `executionClass === 'not_executable'`). */
  readonly notExecutableReason?: string;
  readonly inputs: readonly ObservedParam[];
  readonly outputs: readonly ObservedParam[];
  readonly confidence: number;
  readonly sourceRefs: readonly ObservedSourceRef[];
}

export interface ObservedWorkflowStep {
  readonly order: number;
  readonly capabilityId: string;
  readonly name: string;
  readonly bound: boolean;
  readonly executionClass: 'deterministic_rule' | 'human_in_the_loop' | 'not_executable';
}

export interface ObservedBinding {
  readonly producerCapabilityId: string;
  readonly producerName: string;
  readonly output: string;
  readonly consumerCapabilityId: string;
  readonly consumerName: string;
  readonly input: string;
  /** The existing data-flow audit's own status (`proven` / `suggestive` / ...), verbatim. */
  readonly status: string;
  /** True iff the runtime bridge will actually inject this binding at execution time. */
  readonly wired: boolean;
}

export interface ObservedWorkflow {
  readonly workflowId: string;
  readonly steps: readonly ObservedWorkflowStep[];
  readonly executability: WorkflowExecutability;
  readonly blockerKinds: readonly string[];
  readonly bindings: readonly ObservedBinding[];
}

export type ObservedCapabilityExecutionOutcome = 'succeeded' | 'waiting_for_human' | 'not_executable' | 'invalid_input' | 'error' | 'target_not_found' | 'target_ambiguous';

export interface ObservedCapabilityExecution {
  readonly requestId: string;
  readonly kind: 'capability';
  readonly capabilityId?: string;
  readonly capabilityName?: string;
  /** The capability's compile-side resolution at the time of the run (for upstream attribution). */
  readonly resolution?: Resolution;
  readonly outcome: ObservedCapabilityExecutionOutcome;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly message?: string;
  readonly candidateCount?: number;
  /** P0.9C Step 5: present only when the capability actually ran. */
  readonly provenance?: ObservedExecutionProvenance;
}

export interface ObservedWorkflowStepRun {
  readonly capabilityId: string;
  readonly name: string;
  readonly engineStepStatus: string;
  /** `result.status` of the step's output, when the step produced one (e.g. `escalation_required`, `recorded`). */
  readonly outputStatus?: string;
  readonly output?: unknown;
  /** The input the capability was ACTUALLY executed with (payload + any runtime-injected producer values) — recorded by the observer, not inferred from configuration. */
  readonly actualInput?: Readonly<Record<string, unknown>>;
  /** P0.9C Step 5: present only when the step's capability was actually executed by the runtime. */
  readonly provenance?: ObservedExecutionProvenance;
}

export interface ObservedWorkflowExecution {
  readonly requestId: string;
  readonly kind: 'workflow';
  readonly workflowId?: string;
  readonly workflowExecutability?: WorkflowExecutability;
  /** `refused`: the workflow's audit status is not `executable_candidate` (or a step is unbound), so — exactly as the P0.8 API refuses with `WORKFLOW_NOT_EXECUTABLE` — it was NOT run; `runStatus` is `not_executable_yet`. */
  readonly outcome: 'ran' | 'refused' | 'target_not_found' | 'target_ambiguous';
  readonly runStatus?: ExpectedWorkflowRunStatus;
  readonly engineStatus?: string;
  readonly steps: readonly ObservedWorkflowStepRun[];
  readonly candidateCount?: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export type ObservedExecution = ObservedCapabilityExecution | ObservedWorkflowExecution;

/** One fingerprint per stage: a stable hash of that stage's observable output (never of timestamps). Equal fingerprints across two runs mean that stage's output is identical — the basis for attributing a regression to the stage that actually changed. */
export type StageFingerprints = Readonly<Record<StageName, string>>;

export interface PipelineObservation {
  readonly entry: 'sources' | 'xoir';
  readonly stages: Readonly<Record<StageName, StageStatus>>;
  /** Set when the HARNESS (not XO) could not run the case — e.g. an unreadable fixture file. Such a case is reported as `harness_error` and excluded from every metric. */
  readonly harnessError?: string;
  /** What the compiler reported per input source (source type, quality state), in input order. Absent when the compiler did not run (serialized-XOIR entry, or a failed compile). Attribution context only. */
  readonly sourceReports?: readonly ObservedSourceReport[];
  readonly nodes: readonly ObservedNode[];
  readonly edgeCount: number;
  readonly capabilities: readonly ObservedCapability[];
  readonly workflows: readonly ObservedWorkflow[];
  readonly executions: readonly ObservedExecution[];
  /** P0.9C Step 5: per-capability provenance projection of the live graph. Absent when no graph was built. */
  readonly provenance?: { readonly capabilities: readonly ObservedCapabilityProvenance[] };
  /** P0.9C Step 6: the in-process path views (live graph, serialized graph, package boundary). Absent for serialized-XOIR entries. Not part of any stage fingerprint. */
  readonly paths?: readonly PathView[];
  readonly fingerprints: StageFingerprints;
}
