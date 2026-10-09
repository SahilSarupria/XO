import type { CaseAttribution } from './attribution.js';
import type { MetricResult } from './metrics.js';
import type { StageFingerprints, StageName, StageStatus } from './observation.js';

/**
 * The per-item outcome vocabulary. It is intentionally richer than
 * pass/fail so the report can say WHICH way something went wrong:
 *
 *   found       expected, located, and every assertion about it holds
 *   incorrect   expected and located, but at least one assertion fails
 *               (semantically incorrect / wrong class / wrong outcome)
 *   missing     expected, not located at all
 *   unexpected  observed, in a closed-world scope, and matched by no expectation
 *   spurious    observed, and explicitly forbidden by the definition
 *   passed / failed / not_run   execution requests
 */
export type ItemOutcomeKind = 'found' | 'incorrect' | 'missing' | 'unexpected' | 'spurious' | 'passed' | 'failed' | 'not_run';

export interface ItemOutcome {
  readonly id: string;
  readonly dimension: 'compile' | 'fact' | 'capability' | 'workflow' | 'execution';
  readonly outcome: ItemOutcomeKind;
  readonly detail?: string;
  /** The observed thing this item resolved to (node id / capability id / workflow id), when there is one. */
  readonly ref?: string;
  readonly attributedStage?: StageName;
}

/** Descriptive distributions of what the pipeline produced, independent of any expectation — so unresolved / unsupported / human-in-the-loop / not-executable results stay visible even where no expectation was written. */
export interface ObservedSummary {
  readonly nodeCountsByKind: Readonly<Record<string, number>>;
  readonly capabilities: {
    readonly total: number;
    readonly byResolution: Readonly<Record<string, number>>;
    readonly byExecutionClass: Readonly<Record<string, number>>;
  };
  readonly workflows: {
    readonly total: number;
    readonly totalSteps: number;
    readonly byExecutability: Readonly<Record<string, number>>;
  };
  readonly executions: {
    readonly total: number;
    readonly byOutcome: Readonly<Record<string, number>>;
  };
}

export interface CaseEvaluation {
  readonly caseId: string;
  /** `harness_error`: the harness (not XO) could not run the case; it is excluded from every metric and reported loudly. */
  readonly status: 'evaluated' | 'harness_error';
  readonly harnessError?: string;
  readonly entry: 'sources' | 'xoir';
  /** P0.9C Step 1: which configuration produced this result. Purely descriptive; optional because reports written before it existed do not carry it. */
  readonly attribution?: CaseAttribution;
  readonly stages: Readonly<Record<StageName, StageStatus>>;
  readonly fingerprints: StageFingerprints;
  readonly observed: ObservedSummary;
  readonly metrics: readonly MetricResult[];
  readonly items: readonly ItemOutcome[];
}
