import { compareStrings } from './json.js';
import type { StageName } from './observation.js';

/**
 * Metrics are deliberately many, small, and independent — there is NO
 * blended "XO score". Every metric states its own numerator and
 * denominator, and lists the exact items behind the gap, so two runs can
 * differ in WHICH failure mode moved (recall vs. precision, compile-side
 * vs. runtime-side) instead of being averaged into one number that hides it.
 *
 * `ratio` is `null` — never 1 and never 0 — when the denominator is 0:
 * "nothing was expected / observable here" is a different fact from
 * "everything passed" and must not read as one.
 */
export type MetricId =
  | 'compileOutcomeAccuracy'
  | 'semanticRecall'
  | 'semanticCorrectness'
  | 'semanticPrecision'
  | 'spuriousFactAvoidance'
  | 'provenanceCompleteness'
  | 'observedSourceRefCoverage'
  | 'capabilityRecall'
  | 'capabilityPrecision'
  | 'spuriousCapabilityAvoidance'
  | 'resolutionAccuracy'
  | 'executionClassAccuracy'
  | 'structuredIoAccuracy'
  | 'workflowRecall'
  | 'workflowPrecision'
  | 'workflowExecutabilityAccuracy'
  | 'workflowStructureAccuracy'
  | 'dataFlowCorrectness'
  | 'executionCorrectness'
  | 'runtimeDataFlowTransfer'
  | 'producerAttributionCoverage'
  | 'producerAttributionCorrectness'
  | 'provenanceChainCoverage'
  | 'executionProvenanceAgreement'
  | 'crossPathConsistency';

export interface MetricItem {
  readonly id: string;
  readonly reason: string;
  /** The stage where the divergence originates (an execution failure whose root cause is an unresolved capability is attributed to `capabilities`, not `execution`). */
  readonly attributedStage?: StageName;
  /** Set on suite-level (aggregated) results only. */
  readonly caseId?: string;
}

export interface MetricResult {
  readonly id: MetricId;
  /** The pipeline stage this metric measures — the basis of compile-side vs runtime-side regression attribution. */
  readonly stage: StageName;
  readonly definition: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio: number | null;
  /** `denominator > 0`. When false the metric says nothing about this case/suite. */
  readonly measured: boolean;
  /** Expected but not found / not satisfied because the thing is absent. */
  readonly missing: readonly MetricItem[];
  /** Observed but not expected (closed-world dimensions only) or forbidden-but-present. */
  readonly unexpected: readonly MetricItem[];
  /** Found, but wrong (semantically incorrect / wrong class / wrong outcome). */
  readonly mismatched: readonly MetricItem[];
  /** Optional counts that explain the number without changing it (e.g. an expected->actual confusion matrix). */
  readonly breakdown?: Readonly<Record<string, number>>;
}

export function roundRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1e6) / 1e6;
}

export class MetricBuilder {
  private numerator = 0;
  private denominator = 0;
  private readonly missingItems: MetricItem[] = [];
  private readonly unexpectedItems: MetricItem[] = [];
  private readonly mismatchedItems: MetricItem[] = [];
  private readonly counts: Record<string, number> = {};

  constructor(
    private readonly id: MetricId,
    private readonly stage: StageName,
    private readonly definition: string,
  ) {}

  /** One assertion evaluated: `pass` adds to the numerator; every call adds to the denominator. */
  record(pass: boolean): this {
    this.denominator += 1;
    if (pass) this.numerator += 1;
    return this;
  }

  /** For metrics whose numerator/denominator are counted elsewhere (e.g. observed-node precision). */
  add(numerator: number, denominator: number): this {
    this.numerator += numerator;
    this.denominator += denominator;
    return this;
  }

  missing(item: MetricItem): this {
    this.missingItems.push(item);
    return this;
  }

  unexpected(item: MetricItem): this {
    this.unexpectedItems.push(item);
    return this;
  }

  mismatched(item: MetricItem): this {
    this.mismatchedItems.push(item);
    return this;
  }

  count(key: string, by = 1): this {
    this.counts[key] = (this.counts[key] ?? 0) + by;
    return this;
  }

  build(): MetricResult {
    const byId = (a: MetricItem, b: MetricItem): number => compareStrings(`${a.caseId ?? ''}|${a.id}|${a.reason}`, `${b.caseId ?? ''}|${b.id}|${b.reason}`);
    const breakdownKeys = Object.keys(this.counts).sort(compareStrings);
    return {
      id: this.id,
      stage: this.stage,
      definition: this.definition,
      numerator: this.numerator,
      denominator: this.denominator,
      ratio: roundRatio(this.numerator, this.denominator),
      measured: this.denominator > 0,
      missing: [...this.missingItems].sort(byId),
      unexpected: [...this.unexpectedItems].sort(byId),
      mismatched: [...this.mismatchedItems].sort(byId),
      ...(breakdownKeys.length > 0 ? { breakdown: Object.fromEntries(breakdownKeys.map((k) => [k, this.counts[k]!])) } : {}),
    };
  }
}

/** Suite-level aggregate of per-case results of one metric: numerators/denominators are SUMMED (micro-average — a case with more expected items weighs more, exactly as its items count), item lists concatenated with their `caseId`. */
export function aggregateMetric(id: MetricId, perCase: readonly { readonly caseId: string; readonly metric: MetricResult }[]): MetricResult | undefined {
  const first = perCase[0]?.metric;
  if (first === undefined) return undefined;
  const builder = new MetricBuilder(id, first.stage, first.definition);
  for (const { caseId, metric } of perCase) {
    builder.add(metric.numerator, metric.denominator);
    for (const m of metric.missing) builder.missing({ ...m, caseId });
    for (const m of metric.unexpected) builder.unexpected({ ...m, caseId });
    for (const m of metric.mismatched) builder.mismatched({ ...m, caseId });
    for (const [k, v] of Object.entries(metric.breakdown ?? {})) builder.count(k, v);
  }
  return builder.build();
}
