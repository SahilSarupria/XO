/**
 * PX-1 (gap PX-G06): the complete compilation artifact.
 *
 * `compileSources` returns much more than a graph — validation, quality and coverage diagnostics, the review queue, the
 * sentences no rule pattern parsed, cross-document conflicts, execution readiness, the policy reviewer's account, pass
 * history. The API used to keep only the capability list and part of the first source's report, so review items, conflicts
 * and lost sentences never reached approval, start or Studio. The artifact keeps all of it, in one serializable,
 * content-addressed record bound to the exact source set and compile configuration that produced it.
 *
 * The graph itself is referenced by id and content hash (it is stored next to the artifact, already hash-verified on load);
 * the artifact digest covers the graph hash, so a different graph is a different artifact.
 *
 * Volatile fields: `durationMs` (pass timings) is kept for operators and excluded from the digest — it is the only field
 * that differs between two compilations of the same set under the same configuration.
 */
import type { CompileSourcesResult } from '@xo/compiler';
import { digestOf, toPlainJson, type Digest } from './canonical.js';
import { configurationDigest, type CompileConfiguration } from './compile-configuration.js';
import type { SourceSetManifest } from './source-set.js';

export const COMPILATION_ARTIFACT_SCHEMA = 'xo.compilation-artifact.v1';
export const ARTIFACT_VOLATILE_KEYS: readonly string[] = ['durationMs'];

export interface CompilationArtifact {
  readonly schema: typeof COMPILATION_ARTIFACT_SCHEMA;
  /** The `@xo/pre-execution` build that assembled the artifact, and each source's reader version (in `sources`). */
  readonly producer: string;
  readonly sourceSet: SourceSetManifest;
  readonly configuration: CompileConfiguration;
  readonly configurationDigest: Digest;
  /** Notes about the run itself — for example a configuration asking for OCR with no OCR engine supplied. */
  readonly runNotes: readonly string[];
  readonly graph: { readonly id: string; readonly contentHash: string; readonly nodeCount: number; readonly edgeCount: number };
  /** Structural validity of the graph. Completeness is a separate assessment (ADR 0029 decision 7). */
  readonly valid: boolean;
  readonly validation: unknown;
  readonly diagnostics: unknown;
  readonly passRuns: unknown;
  readonly stats: unknown;
  readonly sources: unknown;
  readonly unclassified: unknown;
  readonly promptInterpretations?: unknown;
  readonly executionReadiness?: unknown;
  readonly reviewQueue?: unknown;
  readonly crossDocument?: unknown;
  readonly policyReview?: unknown;
  /** Decision trees and workflows synthesised from the sources (the policy pipeline's artifacts), when any were built. */
  readonly policy?: unknown;
  readonly aiCandidates?: unknown;
  /** `sha256:` digest of the canonical JSON of every other field, volatile keys excluded. */
  readonly digest: Digest;
}

export const PRE_EXECUTION_PRODUCER = '@xo/pre-execution@0.1.0';

export interface ArtifactInput {
  readonly result: CompileSourcesResult;
  readonly sourceSet: SourceSetManifest;
  readonly configuration: CompileConfiguration;
  readonly runNotes?: readonly string[];
}

/** Assembles the artifact for one compilation. Pure: the same inputs give the same artifact and digest. */
export function buildCompilationArtifact(input: ArtifactInput): CompilationArtifact {
  const r = input.result;
  const stats = r.graph.stats();
  const body: Omit<CompilationArtifact, 'digest'> = {
    schema: COMPILATION_ARTIFACT_SCHEMA,
    producer: PRE_EXECUTION_PRODUCER,
    sourceSet: input.sourceSet,
    configuration: input.configuration,
    configurationDigest: configurationDigest(input.configuration),
    runNotes: input.runNotes ?? [],
    graph: { id: String(r.graph.id), contentHash: r.graph.contentHash(), nodeCount: stats.nodeCount, edgeCount: stats.edgeCount },
    valid: r.valid,
    validation: toPlainJson(r.validation),
    diagnostics: toPlainJson(r.diagnostics),
    passRuns: toPlainJson(r.passRuns),
    stats: toPlainJson(r.stats),
    sources: toPlainJson(r.sources),
    unclassified: toPlainJson(r.unclassified),
    ...(r.promptInterpretations !== undefined ? { promptInterpretations: toPlainJson(r.promptInterpretations) } : {}),
    ...(r.executionReadiness !== undefined ? { executionReadiness: toPlainJson(r.executionReadiness) } : {}),
    ...(r.reviewQueue !== undefined ? { reviewQueue: toPlainJson(r.reviewQueue) } : {}),
    ...(r.crossDocument !== undefined ? { crossDocument: toPlainJson(r.crossDocument) } : {}),
    ...(r.policyReview !== undefined ? { policyReview: toPlainJson(r.policyReview) } : {}),
    ...(r.policy !== undefined ? { policy: toPlainJson(r.policy) } : {}),
    ...(r.aiCandidates !== undefined ? { aiCandidates: toPlainJson(r.aiCandidates) } : {}),
  };
  return { ...body, digest: artifactDigestOf(body) };
}

/**
 * The digest covers what was compiled, not which upload delivered it: the source set enters by its identity (versions,
 * names, roles), without the upload-record ids, so the same bytes compiled from two uploads or two surfaces agree.
 */
function artifactDigestOf(body: Omit<CompilationArtifact, 'digest'>): Digest {
  const { sourceSet, ...rest } = body;
  const identity = { ...sourceSet, entries: sourceSet.entries.map(({ sourceId: _recordId, ...e }) => e) };
  return digestOf({ ...rest, sourceSet: identity }, ARTIFACT_VOLATILE_KEYS);
}

/** Recomputes the artifact digest and compares it with the one recorded (tamper and corruption check on load). */
export function verifyCompilationArtifact(
  artifact: CompilationArtifact,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (artifact.schema !== COMPILATION_ARTIFACT_SCHEMA) return { ok: false, reason: `unknown artifact schema "${String(artifact.schema)}"` };
  const { digest, ...body } = artifact;
  const recomputed = artifactDigestOf(body);
  if (recomputed !== digest) return { ok: false, reason: 'the artifact digest does not match its content' };
  if (artifact.configurationDigest !== configurationDigest(artifact.configuration))
    return { ok: false, reason: 'the configuration digest does not match the configuration' };
  return { ok: true };
}

/** The review items, unclassified sentences and conflicts in an artifact, counted — what a reviewer has left to look at. */
export function artifactOpenWork(artifact: CompilationArtifact): {
  readonly reviewItems: number;
  readonly unclassified: number;
  readonly conflicts: number;
  readonly unresolvedConflicts: number;
} {
  const queue = artifact.reviewQueue as { items?: readonly unknown[] } | undefined;
  const cross = artifact.crossDocument as { conflicts?: readonly { resolution?: { status?: string } }[] } | undefined;
  const conflicts = cross?.conflicts ?? [];
  return {
    reviewItems: queue?.items?.length ?? 0,
    unclassified: Array.isArray(artifact.unclassified) ? artifact.unclassified.length : 0,
    conflicts: conflicts.length,
    unresolvedConflicts: conflicts.filter((c) => c.resolution?.status === 'unresolved').length,
  };
}
