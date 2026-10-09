import type { CaseEvaluation } from './evaluation-types.js';
import { compareStrings } from './json.js';
import type { MetricId, MetricResult } from './metrics.js';
import type { StageName, StageStatus } from './observation.js';

/**
 * P0.9C Step 2 — the EVALUATION MODEL, as data.
 *
 * `EVALUATION_MODEL.md` is the normative prose. This file is its
 * machine-checkable shadow: a registry that says, for each of the 20
 * historical metrics, what its numerator and denominator are, which
 * population the denominator is drawn from, whether it needs a closed
 * world, when it is emitted at all, and which documented limitations
 * apply — plus the small pure classifiers the model defines.
 *
 * What this file is NOT:
 *
 *   - It is not an evaluator. It never reads a definition or an
 *     observation, computes no metric, and nothing in `evaluate.ts`,
 *     `metrics.ts`, `report.ts` or `compare.ts` imports it — so it cannot
 *     change a number, an item, a fingerprint or a verdict.
 *   - It does not redefine any metric. The definition text that is
 *     compared against baselines lives in the evaluator; the registry
 *     describes it and `evaluation-model.test.ts` pins the two together
 *     (stage, emission rule, closed-world requirement).
 *   - It adds no `MetricId`. Dimensions reserved for Steps 4–6 are listed
 *     in `RESERVED_DIMENSIONS` as semantics only.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The six evaluation dimensions of P0.9C. Four are measured by the
 * historical metrics; two are defined here and owned by later steps or by
 * Step 1 (see `DIMENSIONS`).
 */
export type EvaluationDimension = 'semantic_quality' | 'resolution' | 'execution' | 'evidence_provenance' | 'producer_attribution' | 'cross_path_consistency';

/** Which population the denominator counts. */
export type DenominatorPopulation =
  /** exactly one assertion per case that declares `expect.compile`. */
  | 'compile_expectation'
  /** every expected item of that kind, whether or not it was found (a miss stays in the denominator). */
  | 'expected_items'
  /** only expected items that were LOCATED; a miss is invisible here and shows up in the recall metric instead. */
  | 'located_expected_items'
  /** assertions attached to located items (parameter sets, step order, bindings, evidence specs). */
  | 'located_assertions'
  /** every OBSERVED item in the declared closed scope (closed-world precision), or every observed node (descriptive coverage). */
  | 'observed_items'
  /** one per forbidden spec — not per hit. */
  | 'forbidden_specs'
  /** every requested execution, run or not. */
  | 'execution_requests'
  /** every expected producer→consumer injection, whether or not the workflow ran. */
  | 'expected_injections'
  /** P0.9C Step 4: observed nodes created through a path that has a producer-stamping site (see `producer.ts`); classified without reading `producedBy`. */
  | 'stamping_path_nodes'
  /** P0.9C Step 5: every observed capability of a compiled case. */
  | 'observed_capabilities'
  /** P0.9C Step 5: capabilities the runtime actually executed (capability requests and workflow steps). */
  | 'executed_capabilities'
  /** P0.9C Step 6: (pair, dimension, subject) units on which two in-process paths were both observed and comparable. */
  | 'cross_path_units';

/** `any`: computable in open- and closed-world suites. `closed_world_only`: only emitted when the author declared the list complete. */
export type WorldScope = 'any' | 'closed_world_only';

/**
 * When a metric appears in a case's result:
 *   `when_declared`  the case declared that KIND of expectation; the metric is then present even if its denominator
 *                    is 0 (present + `measured:false` + `ratio:null` = UNMEASURED).
 *   `when_measured`  present only when the denominator is > 0; otherwise ABSENT (= NOT APPLICABLE).
 *   `descriptive`    present whenever the graph is observable; describes output, compares nothing to an expectation.
 */
export type EmissionRule = 'when_declared' | 'when_measured' | 'descriptive';

/** `graded` compares output to a declared expectation; `avoidance` counts declared traps that were NOT fallen into; `descriptive` involves no expectation. */
export type MetricRole = 'graded' | 'avoidance' | 'descriptive';

export type LimitationId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10' | 'L11' | 'L12' | 'L13' | 'L14' | 'L15' | 'L16';

export interface MetricModel {
  readonly id: MetricId;
  readonly stage: StageName;
  readonly dimension: EvaluationDimension;
  readonly role: MetricRole;
  /** What increments the numerator. */
  readonly numerator: string;
  /** What increments the denominator. */
  readonly denominator: string;
  readonly population: DenominatorPopulation;
  /** True iff the denominator is smaller when an upstream expected item is not located (assertions on missing items are not counted). */
  readonly conditionalOnUpstream: boolean;
  readonly world: WorldScope;
  readonly emission: EmissionRule;
  /** When the metric is present but `measured: false` (or, for `when_measured` metrics, when it is absent). */
  readonly unmeasuredWhen: string;
  /** False only for descriptive metrics: they never make an otherwise expectation-free suite count as `measured`. Verdict/regression handling is identical for every metric. */
  readonly countsTowardSuiteMeasured: boolean;
  readonly limitations: readonly LimitationId[];
}

// ---------------------------------------------------------------------------
// Known limitations — documented, never silently "fixed"
// ---------------------------------------------------------------------------

export const KNOWN_LIMITATIONS: Readonly<Record<LimitationId, string>> = {
  L1: 'compileOutcomeAccuracy: a `succeeds` expectation is satisfied whenever the compile stage did not fail. On a serialized-XOIR entry the compile stage is `skipped` (not observable), so the expectation passes vacuously. Interpret with `interpretCase`.',
  L2: 'Precision is not defined uniformly: semanticPrecision requires the claiming fact to be CORRECT; capabilityPrecision and workflowPrecision count any identity match. A located-but-wrong capability is precise but incorrect (see resolutionAccuracy / executionClassAccuracy / structuredIoAccuracy).',
  L3: 'Matching is greedy over id-sorted expectations, not a perfect assignment: when every candidate is already claimed, the first candidate is reused, so two expectations can be satisfied by ONE observed item (recall can over-count). Not observed in any committed suite; deterministic when it happens.',
  L4: 'Conditional-denominator metrics do not count assertions attached to expected items that were never located. That loss is visible only as a recall miss and (in comparisons) as a `coverage_reduced` warning; the report does not record how many assertions went unevaluated.',
  L5: 'Avoidance metrics count one denominator unit per forbidden spec, but list one `unexpected` entry per observed hit; a single trap matched by several observed items yields more list entries than failed units.',
  L6: 'Item lists (`missing`/`unexpected`/`mismatched`) explain a gap; they are not a partition of it. `denominator − numerator` is the failed count. Lists can be empty for a failed unit (semanticCorrectness lists nothing — its failures are the `mismatched` items of semanticRecall) or exceed it (see L5; a structuredIoAccuracy assertion may be both missing and unexpected).',
  L7: 'provenanceCompleteness pools two populations (evidence specs on located facts and on located capabilities) into one metric, and audits only source-reference presence (minimum count / document / pages), not derivation or producer chains (Step 5).',
  L8: 'observedSourceRefCoverage is descriptive: its denominator is the observed node population, which changes when the compiler changes what it emits (e.g. P0.9A table quarantine). A denominator change there is a population change, not lost measurement.',
  L9: 'Presence is not uniform: some metrics are present-but-unmeasured (0/0) when their expectation kind is declared and nothing could be evaluated; others are absent in that situation. Both mean "no evidence"; only the first says the kind was declared.',
  L10: 'The comparator cannot tell an intentionally changed evaluation population from lost measurement: both surface as a `coverage_reduced` warning on the metric whose denominator shrank. A denominator INCREASE produces no finding at all.',
  L12: 'Producer attribution is judged only for nodes created through a path with a stamping site (knowledge extractor, capability extractor). Reasoning-derived nodes (heuristic, decision_node, reasoning constraints) and rule-minted capabilities have NO stamping site; the repository documents producedBy as absent "when no genuinely identifiable producer exists" but never says whether those paths are meant to be attributed, so their absence is neither asserted correct nor asserted defective. They are reported (breakdown `not_judged.*`), not scored.',
  L13: 'Producer attribution assumes at most one extractor per node, which holds only while AI is not exercised (a node merging rule-based and AI candidates legitimately carries no producer). Both producer metrics are therefore not emitted unless the configuration reports `ai: not_exercised`, and no producer expectation exists for AI or hybrid.',
  L14: 'provenanceChainCoverage measures INTERNAL CONNECTEDNESS of the compile-side chain (source -> node -> capability -> contract), not semantic correctness and not complete provenance. An ExperienceUnit id is carried on every node ref in XOIR but dropped by ContractSourceRef and by ObservedSourceRef, and the compile result exposes no unit list, so a unit id\'s EXISTENCE is not observable (never inferred). The binding -> manifest -> runtime links are not exercised: the benchmark builds neither a package nor an installed runtime.',
  L15: 'executionProvenanceAgreement compares what the runtime recorded against a second derivation of the same facts from the same live graph (P0.9B projectExecutionProvenance). It detects divergence (stale hash, wrong contract / binding, a different graph) but does not prove the contract itself is correct. Live-graph path only: an installed package records no graphHash, which would be `unknown`.',
  L16: 'crossPathConsistency compares only the paths the benchmark can build in-process from one compiled graph: live graph, a serialized round trip, and the package boundary (lowering + serialization + contract extraction + the installed router\'s structured-comparison-only binding). The archive / sign / install steps, the CLI, the API and workflow-vs-direct execution are NOT compared (the benchmark package cannot import the apps; the API is pinned only by apps/api tests). A graphHash is compared only between objects of the same identity (a lowered graph is a different object from the unlowered one). Disagreement is measured, never reconciled.',
  L11: '`StageStatus.status === "skipped"` is overloaded: the entry point bypasses the stage (serialized XOIR skips compile) OR an earlier stage failed. `stageObservability` maps both to `not_observable`; the stage `note` / error code says which.',
};

// ---------------------------------------------------------------------------
// The 20 historical metrics
// ---------------------------------------------------------------------------

export const METRIC_MODEL: Readonly<Record<MetricId, MetricModel>> = {
  compileOutcomeAccuracy: {
    id: 'compileOutcomeAccuracy', stage: 'compile', dimension: 'semantic_quality', role: 'graded',
    numerator: '1 if the compile outcome (succeeds / fails with the expected code) equals the expectation',
    denominator: '1 per case that declares expect.compile',
    population: 'compile_expectation', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (denominator is always 1 when present)', countsTowardSuiteMeasured: true, limitations: ['L1', 'L11'],
  },
  semanticRecall: {
    id: 'semanticRecall', stage: 'compile', dimension: 'semantic_quality', role: 'graded',
    numerator: 'expected facts located AND every assertion holds',
    denominator: 'expected facts',
    population: 'expected_items', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when facts are declared)', countsTowardSuiteMeasured: true, limitations: ['L3'],
  },
  semanticCorrectness: {
    id: 'semanticCorrectness', stage: 'compile', dimension: 'semantic_quality', role: 'graded',
    numerator: 'located expected facts whose assertions all hold',
    denominator: 'expected facts that were located (identity matched)',
    population: 'located_expected_items', conditionalOnUpstream: true, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'facts are declared but none was located (0/0)', countsTowardSuiteMeasured: true, limitations: ['L4', 'L6', 'L9'],
  },
  semanticPrecision: {
    id: 'semanticPrecision', stage: 'compile', dimension: 'semantic_quality', role: 'graded',
    numerator: 'observed nodes of closed-world kinds chosen by a CORRECT expected fact',
    denominator: 'all observed nodes of the closed-world kinds',
    population: 'observed_items', conditionalOnUpstream: false, world: 'closed_world_only', emission: 'when_declared',
    unmeasuredWhen: 'closedWorldKinds is declared but no node of those kinds was observed (0/0)', countsTowardSuiteMeasured: true, limitations: ['L2', 'L3', 'L9'],
  },
  spuriousFactAvoidance: {
    id: 'spuriousFactAvoidance', stage: 'compile', dimension: 'semantic_quality', role: 'avoidance',
    numerator: 'forbidden fact specs with no matching observed node',
    denominator: 'forbidden fact specs',
    population: 'forbidden_specs', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when forbidden facts are declared)', countsTowardSuiteMeasured: true, limitations: ['L5', 'L6'],
  },
  provenanceCompleteness: {
    id: 'provenanceCompleteness', stage: 'compile', dimension: 'evidence_provenance', role: 'graded',
    numerator: 'evidence specs satisfied by the located item (min refs / document / pages)',
    denominator: 'evidence specs attached to LOCATED facts and capabilities',
    population: 'located_assertions', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no located item carries an evidence spec', countsTowardSuiteMeasured: true, limitations: ['L4', 'L7'],
  },
  observedSourceRefCoverage: {
    id: 'observedSourceRefCoverage', stage: 'compile', dimension: 'evidence_provenance', role: 'descriptive',
    numerator: 'observed nodes carrying at least one source reference',
    denominator: 'all observed nodes (only when compile did not fail and at least one node exists)',
    population: 'observed_items', conditionalOnUpstream: false, world: 'any', emission: 'descriptive',
    unmeasuredWhen: 'absent when compile failed or no node was observed', countsTowardSuiteMeasured: false, limitations: ['L8'],
  },
  capabilityRecall: {
    id: 'capabilityRecall', stage: 'capabilities', dimension: 'semantic_quality', role: 'graded',
    numerator: 'expected capabilities whose name matcher located a discovered capability (identity only)',
    denominator: 'expected capabilities',
    population: 'expected_items', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when capabilities are declared)', countsTowardSuiteMeasured: true, limitations: ['L3'],
  },
  capabilityPrecision: {
    id: 'capabilityPrecision', stage: 'capabilities', dimension: 'semantic_quality', role: 'graded',
    numerator: 'discovered capabilities claimed by an expectation (identity only)',
    denominator: 'all discovered capabilities',
    population: 'observed_items', conditionalOnUpstream: false, world: 'closed_world_only', emission: 'when_declared',
    unmeasuredWhen: 'capabilities.closedWorld is true but nothing was discovered (0/0)', countsTowardSuiteMeasured: true, limitations: ['L2', 'L3', 'L9'],
  },
  spuriousCapabilityAvoidance: {
    id: 'spuriousCapabilityAvoidance', stage: 'capabilities', dimension: 'semantic_quality', role: 'avoidance',
    numerator: 'forbidden capability specs with no matching discovered capability',
    denominator: 'forbidden capability specs (one per trap, not per hit)',
    population: 'forbidden_specs', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when forbidden capabilities are declared)', countsTowardSuiteMeasured: true, limitations: ['L5'],
  },
  resolutionAccuracy: {
    id: 'resolutionAccuracy', stage: 'capabilities', dimension: 'resolution', role: 'graded',
    numerator: 'located capabilities whose binding resolution equals the expected one',
    denominator: 'located capabilities that declare an expected resolution',
    population: 'located_expected_items', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no located capability declares an expected resolution', countsTowardSuiteMeasured: true, limitations: ['L4', 'L9'],
  },
  executionClassAccuracy: {
    id: 'executionClassAccuracy', stage: 'capabilities', dimension: 'execution', role: 'graded',
    numerator: 'located capabilities whose execution class equals the expected one',
    denominator: 'located capabilities that declare an expected execution class',
    population: 'located_expected_items', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no located capability declares an expected class', countsTowardSuiteMeasured: true, limitations: ['L4', 'L9'],
  },
  structuredIoAccuracy: {
    id: 'structuredIoAccuracy', stage: 'capabilities', dimension: 'semantic_quality', role: 'graded',
    numerator: 'declared input/output parameter sets exactly equal to the expected set',
    denominator: 'input/output set assertions on located capabilities',
    population: 'located_assertions', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no located capability declares expected inputs/outputs', countsTowardSuiteMeasured: true, limitations: ['L4', 'L6', 'L9'],
  },
  workflowRecall: {
    id: 'workflowRecall', stage: 'workflows', dimension: 'semantic_quality', role: 'graded',
    numerator: 'expected workflows found (exact step set, any order)',
    denominator: 'expected workflows',
    population: 'expected_items', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when workflows are declared)', countsTowardSuiteMeasured: true, limitations: ['L3'],
  },
  workflowPrecision: {
    id: 'workflowPrecision', stage: 'workflows', dimension: 'semantic_quality', role: 'graded',
    numerator: 'observed workflows claimed by an expectation (identity only)',
    denominator: 'all observed workflows',
    population: 'observed_items', conditionalOnUpstream: false, world: 'closed_world_only', emission: 'when_declared',
    unmeasuredWhen: 'workflows.closedWorld is true but no workflow was observed (0/0)', countsTowardSuiteMeasured: true, limitations: ['L2', 'L3', 'L9'],
  },
  workflowExecutabilityAccuracy: {
    id: 'workflowExecutabilityAccuracy', stage: 'workflows', dimension: 'execution', role: 'graded',
    numerator: 'found workflows whose audit status equals the expected executability',
    denominator: 'found workflows that declare an expected executability',
    population: 'located_expected_items', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no found workflow declares an expected executability', countsTowardSuiteMeasured: true, limitations: ['L4', 'L9'],
  },
  workflowStructureAccuracy: {
    id: 'workflowStructureAccuracy', stage: 'workflows', dimension: 'execution', role: 'graded',
    numerator: 'step-order and per-step-class assertions that hold on found workflows',
    denominator: 'step-order and step-class assertions on found workflows',
    population: 'located_assertions', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no found workflow declares order or step classes', countsTowardSuiteMeasured: true, limitations: ['L4', 'L9'],
  },
  dataFlowCorrectness: {
    id: 'dataFlowCorrectness', stage: 'workflows', dimension: 'execution', role: 'graded',
    numerator: 'binding assertions satisfied (proven present, not_proven absent, no extra proven when the workflow is closed-world)',
    denominator: 'binding assertions on found workflows (+ one failing unit per unclaimed extra proven binding, closed-world workflows only)',
    population: 'located_assertions', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no found workflow declares data-flow expectations', countsTowardSuiteMeasured: true, limitations: ['L4', 'L9'],
  },
  executionCorrectness: {
    id: 'executionCorrectness', stage: 'execution', dimension: 'execution', role: 'graded',
    numerator: 'execution requests whose observed outcome (status / output / steps / error code) equals the expectation',
    denominator: 'execution requests (a request that was not run counts, as `not_run`)',
    population: 'execution_requests', conditionalOnUpstream: false, world: 'any', emission: 'when_declared',
    unmeasuredWhen: 'never (emitted only when execution cases are declared)', countsTowardSuiteMeasured: true, limitations: [],
  },
  runtimeDataFlowTransfer: {
    id: 'runtimeDataFlowTransfer', stage: 'execution', dimension: 'execution', role: 'graded',
    numerator: 'expected producer→consumer injections the runtime actually performed',
    denominator: 'expected injections across workflow requests (counted even when the workflow could not be run)',
    population: 'expected_injections', conditionalOnUpstream: false, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no workflow request declares injections', countsTowardSuiteMeasured: true, limitations: ['L9'],
  },
  producerAttributionCoverage: {
    id: 'producerAttributionCoverage', stage: 'compile', dimension: 'producer_attribution', role: 'descriptive',
    numerator: 'nodes in the stamping population that carry `producedBy`',
    denominator: 'nodes created through a producer-stamping path (knowledge extractor / capability extractor), classified by kind + subtype + the rule-minter marker — never by `producedBy`',
    population: 'stamping_path_nodes', conditionalOnUpstream: false, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when compile did not run (serialized-XOIR entry, failed compile), when AI is exercised, or when no node belongs to the population', countsTowardSuiteMeasured: false, limitations: ['L12', 'L13'],
  },
  producerAttributionCorrectness: {
    id: 'producerAttributionCorrectness', stage: 'capabilities', dimension: 'producer_attribution', role: 'graded',
    numerator: 'located capabilities with an expected producer whose `producedBy` equals it',
    denominator: 'located capabilities that declare an expected producer, were created by a capability extractor, and carry a producer',
    population: 'located_assertions', conditionalOnUpstream: true, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when no located capability declares an expected producer, or every such capability is outside the assertion (created another way / carries no producer)', countsTowardSuiteMeasured: true, limitations: ['L4', 'L12', 'L13'],
  },
  provenanceChainCoverage: {
    id: 'provenanceChainCoverage', stage: 'capabilities', dimension: 'evidence_provenance', role: 'descriptive',
    numerator: 'observed capabilities whose compile-side chain is internally connected: contract source refs resolve to declared sources and are carried by the linked nodes, every linked XOIR node id resolves (and includes the capability), and the contract content hash recomputes identically',
    denominator: 'all observed capabilities of a compiled case',
    population: 'observed_capabilities', conditionalOnUpstream: false, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when compile did not run (serialized-XOIR entry, failed compile) or no capability was observed', countsTowardSuiteMeasured: false, limitations: ['L14'],
  },
  executionProvenanceAgreement: {
    id: 'executionProvenanceAgreement', stage: 'execution', dimension: 'evidence_provenance', role: 'descriptive',
    numerator: 'executed capabilities whose recorded graphHash / contractContentHash / bindingId / contractId all match the live-graph projection',
    denominator: 'executed capabilities where agreement is determinable (match or mismatch); unknown, not_exercised and not_observable are reported in the breakdown, never counted',
    population: 'executed_capabilities', conditionalOnUpstream: false, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent when nothing ran or every executed capability is `unknown`', countsTowardSuiteMeasured: false, limitations: ['L15'],
  },
  crossPathConsistency: {
    id: 'crossPathConsistency', stage: 'capabilities', dimension: 'cross_path_consistency', role: 'descriptive',
    numerator: 'cross-path units (pair x dimension x subject) on which the two paths agree',
    denominator: 'units where both paths were observed and comparable (match or mismatch); unknown, not_comparable, not_exercised and not_observable are reported in the breakdown, never counted',
    population: 'cross_path_units', conditionalOnUpstream: false, world: 'any', emission: 'when_measured',
    unmeasuredWhen: 'absent for serialized-XOIR entries and when no unit was judged (an empty comparison is never 100%)', countsTowardSuiteMeasured: false, limitations: ['L16'],
  },
};

export const METRIC_IDS: readonly MetricId[] = (Object.keys(METRIC_MODEL) as MetricId[]).sort(compareStrings);

/** The 20 metrics defined before P0.9C Step 4; their definitions are frozen (pinned by `attribution.test.ts` against the committed baselines). */
export const HISTORICAL_METRIC_IDS: readonly MetricId[] = [
  'capabilityPrecision', 'capabilityRecall', 'compileOutcomeAccuracy', 'dataFlowCorrectness', 'executionClassAccuracy', 'executionCorrectness',
  'observedSourceRefCoverage', 'provenanceCompleteness', 'resolutionAccuracy', 'runtimeDataFlowTransfer', 'semanticCorrectness', 'semanticPrecision',
  'semanticRecall', 'spuriousCapabilityAvoidance', 'spuriousFactAvoidance', 'structuredIoAccuracy', 'workflowExecutabilityAccuracy', 'workflowPrecision',
  'workflowRecall', 'workflowStructureAccuracy',
];
/** Metrics added by P0.9C Step 4. */
export const PRODUCER_METRIC_IDS: readonly MetricId[] = METRIC_IDS.filter((id) => METRIC_MODEL[id].dimension === 'producer_attribution');
/** Metric added by P0.9C Step 6 (cross-path). */
export const CROSS_PATH_METRIC_IDS: readonly MetricId[] = ['crossPathConsistency'];
/** Metrics added by P0.9C Step 5 (evidence / provenance). */
export const PROVENANCE_METRIC_IDS: readonly MetricId[] = ['executionProvenanceAgreement', 'provenanceChainCoverage'];

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export type DimensionStatus = 'measured_by_historical_metrics' | 'implemented_step_1' | 'implemented_step_4' | 'implemented_step_5' | 'implemented_step_6' | 'defined_not_implemented';

export interface DimensionModel {
  readonly id: EvaluationDimension | 'configuration_attribution' | 'cross_path_consistency' | 'evidence_provenance_chain';
  readonly status: DimensionStatus;
  /** The step that owns (or owned) the implementation. */
  readonly owner: string;
}

export const DIMENSIONS: readonly DimensionModel[] = [
  { id: 'semantic_quality', status: 'measured_by_historical_metrics', owner: 'P0.9 (historical)' },
  { id: 'resolution', status: 'measured_by_historical_metrics', owner: 'P0.9 (historical)' },
  { id: 'execution', status: 'measured_by_historical_metrics', owner: 'P0.9 (historical)' },
  { id: 'evidence_provenance', status: 'measured_by_historical_metrics', owner: 'P0.9 (historical); expanded by P0.9C Step 5' },
  { id: 'configuration_attribution', status: 'implemented_step_1', owner: 'P0.9C Step 1' },
  { id: 'producer_attribution', status: 'implemented_step_4', owner: 'P0.9C Step 4' },
  { id: 'evidence_provenance_chain', status: 'implemented_step_5', owner: 'P0.9C Step 5' },
  { id: 'cross_path_consistency', status: 'implemented_step_6', owner: 'P0.9C Step 6' },
];

// ---------------------------------------------------------------------------
// Measurement states
// ---------------------------------------------------------------------------

/**
 * The state of ONE metric in ONE result (case or aggregate):
 *
 *   `not_applicable`  the metric is absent — no expectation of that kind produced anything to evaluate.
 *   `unmeasured`      present, but denominator 0 (`ratio: null`). Nothing could be evaluated; this is neither 0% nor 100%.
 *   `measured`        present with a positive denominator; the ratio is a fact about `denominator` evaluated units
 *                     (which may be 0/N — measured and entirely failing).
 */
export type MeasurementState = 'not_applicable' | 'unmeasured' | 'measured';

export function measurementState(metric: Pick<MetricResult, 'measured'> | undefined): MeasurementState {
  if (metric === undefined) return 'not_applicable';
  return metric.measured ? 'measured' : 'unmeasured';
}

/**
 * Whether a pipeline stage's output could be observed in a run:
 *
 *   `observed`        the stage ran (`ok`) or ran and failed (`failed`); either way its outcome is a real observation.
 *   `not_observable`  `skipped`: the entry point bypasses the stage or an earlier stage failed (L11). Nothing was observed.
 *   `not_exercised`   `not_requested`: nothing asked the stage to run. Not a failure, not a success.
 */
export type StageObservability = 'observed' | 'not_observable' | 'not_exercised';

export function stageObservability(status: StageStatus['status']): StageObservability {
  switch (status) {
    case 'ok':
    case 'failed':
      return 'observed';
    case 'skipped':
      return 'not_observable';
    case 'not_requested':
      return 'not_exercised';
  }
}

// ---------------------------------------------------------------------------
// Interpretation notes (data-dependent caveats; pure, never repair anything)
// ---------------------------------------------------------------------------

export type InterpretationCode = 'compile_outcome_not_observable' | 'metric_unmeasured';

export interface InterpretationNote {
  readonly code: InterpretationCode;
  readonly metricId: MetricId;
  readonly message: string;
}

/**
 * Caveats a reader needs to interpret ONE evaluated case correctly. Notes
 * are advisory and additive: they never alter, drop or reclassify a
 * metric, and a case without caveats yields `[]`.
 */
export function interpretCase(evaluation: CaseEvaluation): readonly InterpretationNote[] {
  if (evaluation.status !== 'evaluated') return [];
  const notes: InterpretationNote[] = [];
  for (const metric of evaluation.metrics) {
    if (metric.id === 'compileOutcomeAccuracy' && stageObservability(evaluation.stages.compile.status) !== 'observed') {
      notes.push({ code: 'compile_outcome_not_observable', metricId: metric.id, message: `the compile stage was ${evaluation.stages.compile.status} (not observable), so this outcome is vacuous: ${metric.numerator}/${metric.denominator} does not evidence compilation (L1)` });
    }
    if (measurementState(metric) === 'unmeasured') {
      notes.push({ code: 'metric_unmeasured', metricId: metric.id, message: `${metric.id} is unmeasured (denominator 0): nothing could be evaluated; this is not 0% and not 100%` });
    }
  }
  return notes.sort((a, b) => compareStrings(`${a.metricId}|${a.code}`, `${b.metricId}|${b.code}`));
}

// ---------------------------------------------------------------------------
// Reserved dimensions (Steps 4–6): SEMANTICS ONLY — no MetricId, no evaluator
// ---------------------------------------------------------------------------

export interface ReservedDimension {
  readonly id: string;
  readonly ownerStep: 'P0.9C Step 5';
  /** What one denominator unit is. */
  readonly denominator: string;
  /** What counts as correct. */
  readonly correct: string;
  /** What is `not_applicable`, `not_observable` or `not_exercised` (never a failure and never a success). */
  readonly notMeasured: string;
  readonly implemented: false;
}

export const RESERVED_DIMENSIONS: readonly ReservedDimension[] = [
  {
    id: 'contractBindingLinkage',
    ownerStep: 'P0.9C Step 5',
    denominator: 'located capabilities with an expected contract / binding link',
    correct: 'the capability is linked to the expected contract and binding',
    notMeasured: 'graph forms that do not expose the link are not_observable',
    implemented: false,
  },
];
