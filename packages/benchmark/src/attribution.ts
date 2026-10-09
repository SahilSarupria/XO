import type { BenchmarkCaseDefinition } from './definition.js';
import { compareStrings, fingerprintOf } from './json.js';
import type { PipelineObservation } from './observation.js';

/**
 * P0.9C Step 1 — configuration ATTRIBUTION.
 *
 * Answers "which source, configuration, compiler path and execution path
 * produced this result?" without touching what is evaluated. Everything
 * here is descriptive context:
 *
 *   - It never feeds a metric, an item outcome, or a stage fingerprint,
 *     so the historical metrics stay directly comparable with baselines
 *     written before this existed.
 *   - It contains only values that are derivable from the case
 *     definition or from what the real pipeline reported. No timestamps,
 *     machine paths, random ids or environment data.
 *
 * Two deliberately separate parts:
 *
 *   `configuration`   INPUT side — what the case asked the pipeline to do
 *                     (declared, so it is hashed into `configurationId`).
 *   `observedContext` OUTPUT side — what the pipeline reported about its
 *                     own run (source type, quality state, producer
 *                     distribution). It is NOT hashed into the id: if a
 *                     compiler change moved a producer count, the
 *                     configuration did not change, the result did.
 */

/** Bump when the meaning of the attribution model (not any metric) changes. Recorded in every configuration, so a comparator can tell "different evaluation" from "different result". */
export const EVALUATION_VERSION = 'p0.9c-1' as const;

/** Where the graph under evaluation came from. */
export type GraphOrigin = 'compiled_sources' | 'serialized_xoir';

/** Execution paths the case actually REQUESTED. An unrequested path is absent from the list, never labelled as a variant. */
export type ExecutionPathKind = 'direct_capability' | 'workflow';

export interface DeclaredSourceConfig {
  readonly declaredKind: string;
  /** Verbatim from the case definition (relative to the suite's `sourceRoot`; machine-independent). */
  readonly path: string;
  readonly format?: string;
}

export interface ConfigurationDescriptor {
  readonly evaluationVersion: typeof EVALUATION_VERSION;
  readonly entry: 'sources' | 'xoir';
  readonly sources: readonly DeclaredSourceConfig[];
  /** Serialized-XOIR entry only. */
  readonly xoir?: string;
  /** The compiler options the observer actually passes. `aiCore` is never among them — see `ai`. */
  readonly compilerOptions: { readonly domainHint?: string };
  readonly paths: {
    /** The surface driving the pipeline. Only the benchmark observer exists here. */
    readonly host: 'benchmark_observer';
    readonly graphOrigin: GraphOrigin;
    /** The observer always evaluates the in-memory graph. The package / installed path is not exercised and therefore not represented. */
    readonly graphForm: 'live_graph';
    readonly executionPaths: readonly ExecutionPathKind[];
  };
  /**
   * AI-enabled extraction is not reachable through any shipped production
   * benchmark path (`compileSources({ aiCore })` exists, but nothing that
   * runs supplies one). The benchmark supplies none, calls no provider and
   * needs no key. Recorded explicitly so the absence is never mistaken for
   * an oversight; deferred to P1.5.
   */
  readonly ai: 'not_exercised';
}

/** What the compiler reported per input source (`CompileSourcesResult.sources`), in input order. */
export interface ObservedSourceReport {
  readonly sourceType: string;
  /** Declared path, as passed to the compiler. */
  readonly path: string;
  /** Absent for source types the quality pass never runs against. Never defaulted. */
  readonly qualityState?: string;
  readonly semanticExtractionAvailable: boolean;
}

export interface ProducerCounts {
  /** Nodes whose `producedBy` is set, by producer name. */
  readonly producers: Readonly<Record<string, number>>;
  /** Nodes with no `producedBy`. P0.9A leaves some node classes unattributed by design, so this is a count, not a defect. */
  readonly unattributed: number;
}

export interface ProducerDistribution {
  readonly nodeCount: number;
  readonly total: ProducerCounts;
  readonly byKind: Readonly<Record<string, ProducerCounts>>;
}

export interface ObservedContext {
  readonly sources: readonly ObservedSourceReport[];
  readonly producerDistribution: ProducerDistribution;
}

export interface CaseAttribution {
  /** `cfg_` + a hash of `configuration` only. Equal ids mean the case was asked the same thing of the same evaluation version. */
  readonly configurationId: string;
  readonly configuration: ConfigurationDescriptor;
  readonly observedContext: ObservedContext;
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => compareStrings(a, b)));
}

export function describeConfiguration(def: BenchmarkCaseDefinition): ConfigurationDescriptor {
  const executionPaths: ExecutionPathKind[] = [];
  const requested = def.execution ?? [];
  if (requested.some((r) => r.kind === 'capability')) executionPaths.push('direct_capability');
  if (requested.some((r) => r.kind === 'workflow')) executionPaths.push('workflow');
  const entry = def.xoir !== undefined ? 'xoir' : 'sources';
  return {
    evaluationVersion: EVALUATION_VERSION,
    entry,
    sources: (def.sources ?? []).map((s) => ({ declaredKind: s.kind, path: s.path, ...(s.format !== undefined ? { format: s.format } : {}) })),
    ...(def.xoir !== undefined ? { xoir: def.xoir } : {}),
    compilerOptions: def.domainHint !== undefined ? { domainHint: def.domainHint } : {},
    paths: { host: 'benchmark_observer', graphOrigin: entry === 'xoir' ? 'serialized_xoir' : 'compiled_sources', graphForm: 'live_graph', executionPaths },
    ai: 'not_exercised',
  };
}

export function describeProducers(obs: Pick<PipelineObservation, 'nodes'>): ProducerDistribution {
  const totalProducers = new Map<string, number>();
  let totalUnattributed = 0;
  const kinds = new Map<string, { producers: Map<string, number>; unattributed: number }>();
  for (const n of obs.nodes) {
    const bucket = kinds.get(n.kind) ?? { producers: new Map<string, number>(), unattributed: 0 };
    kinds.set(n.kind, bucket);
    if (n.producedBy === undefined) {
      bucket.unattributed += 1;
      totalUnattributed += 1;
    } else {
      bucket.producers.set(n.producedBy, (bucket.producers.get(n.producedBy) ?? 0) + 1);
      totalProducers.set(n.producedBy, (totalProducers.get(n.producedBy) ?? 0) + 1);
    }
  }
  const byKind: Record<string, ProducerCounts> = {};
  for (const kind of [...kinds.keys()].sort(compareStrings)) {
    const b = kinds.get(kind)!;
    byKind[kind] = { producers: sortedRecord(b.producers), unattributed: b.unattributed };
  }
  return { nodeCount: obs.nodes.length, total: { producers: sortedRecord(totalProducers), unattributed: totalUnattributed }, byKind };
}

export function attributeCase(def: BenchmarkCaseDefinition, obs: Pick<PipelineObservation, 'nodes' | 'sourceReports'>): CaseAttribution {
  const configuration = describeConfiguration(def);
  return {
    configurationId: `cfg_${fingerprintOf(configuration)}`,
    configuration,
    observedContext: { sources: obs.sourceReports ?? [], producerDistribution: describeProducers(obs) },
  };
}
