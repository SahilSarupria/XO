import { compileSources } from '../pipeline/compile-sources.js';
import { clarify } from './clarify.js';
import type { PolicyArtifacts } from './artifacts.js';
import type { ClauseModel } from './model-extract.js';

/**
 * Operating numbers for the compiler: how long a compile takes, what model calls cost, and a QUALITY report that can be
 * stored per document and compared over time. Token counts for a model that does not report usage are ESTIMATES
 * (characters / 4) and are labelled as such; prices are supplied by the operator, never assumed.
 */
export interface ModelPrices {
  /** USD per million input tokens */
  readonly inPerMTok: number;
  /** USD per million output tokens */
  readonly outPerMTok: number;
}
export interface ModelUsage {
  readonly calls: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokensAreEstimates: true;
  readonly costUsd: number | null;
  readonly totalMs: number;
  readonly slowestMs: number;
}

export function meteredModel(model: ClauseModel, prices?: ModelPrices): { readonly model: ClauseModel; usage(): ModelUsage } {
  let calls = 0;
  let failures = 0;
  let inTok = 0;
  let outTok = 0;
  let total = 0;
  let slow = 0;
  return {
    model: async (prompt) => {
      calls++;
      inTok += Math.ceil(prompt.length / 4);
      const t0 = performance.now();
      try {
        const out = await model(prompt);
        outTok += Math.ceil(out.length / 4);
        return out;
      } catch (e) {
        failures++;
        throw e;
      } finally {
        const ms = performance.now() - t0;
        total += ms;
        slow = Math.max(slow, ms);
      }
    },
    usage: () => ({
      calls,
      failures,
      inputTokens: inTok,
      outputTokens: outTok,
      tokensAreEstimates: true,
      costUsd: prices === undefined ? null : (inTok * prices.inPerMTok + outTok * prices.outPerMTok) / 1e6,
      totalMs: Math.round(total),
      slowestMs: Math.round(slow),
    }),
  };
}

export interface CompileQuality {
  readonly decisionSentences: number;
  readonly understood: number;
  /** understood / decisionSentences (1 when the manual has none) */
  readonly understoodRatio: number;
  readonly unrecognized: number;
  readonly openQuestions: number;
  readonly blockingQuestions: number;
  readonly failClosedPaths: number;
  readonly treeProblems: number;
  readonly hasTree: boolean;
  readonly rules: number;
  readonly inputs: number;
}
export interface CompileReport {
  readonly quality: CompileQuality;
  readonly compileMs: number;
  readonly model?: ModelUsage;
}

export function qualityOf(art: PolicyArtifacts): CompileQuality {
  const qs = clarify({
    program: art.program,
    recognized: [],
    unrecognized: art.review.unrecognized,
    decisionSentences: art.review.decisionSentences,
  });
  const { decisionSentences, recognizedSentences } = art.review;
  return {
    decisionSentences,
    understood: recognizedSentences,
    understoodRatio: decisionSentences === 0 ? 1 : Math.round((recognizedSentences / decisionSentences) * 1000) / 1000,
    unrecognized: art.review.unrecognized.length,
    openQuestions: qs.length,
    blockingQuestions: qs.filter((q) => q.blocking).length,
    failClosedPaths: art.review.failClosedPaths.length,
    treeProblems: art.review.treeProblems.length,
    hasTree: (art.trees?.length ?? 0) > 0,
    rules: art.program.steps.length,
    inputs: art.program.facts.length,
  };
}

/** Compiles a manual through the production path and returns the artifacts with a timed quality report. */
export async function measureCompile(
  text: string,
  title: string,
  sourcePath = 'manual.md',
): Promise<{ readonly artifacts: PolicyArtifacts; readonly report: CompileReport }> {
  const t0 = performance.now();
  const r = await compileSources([{ kind: 'document', text, title, sourcePath }], {});
  const compileMs = Math.round(performance.now() - t0);
  if (!r.ok || r.value.policy === undefined) throw new Error(`compile failed: ${r.ok ? 'no policy artifacts' : r.error.message}`);
  return { artifacts: r.value.policy, report: { quality: qualityOf(r.value.policy), compileMs } };
}

export interface Tolerances {
  /** allowed drop in understoodRatio (absolute) */
  readonly understoodDrop?: number;
  /** compile time must stay under this many times the baseline (and under `maxMs`) */
  readonly maxMs?: number;
}
/** What got worse since the stored baseline. Empty means no regression. Improvements are not reported as problems. */
export function compareQuality(baseline: CompileQuality, current: CompileQuality, tol: Tolerances = {}): string[] {
  const out: string[] = [];
  if (current.understoodRatio < baseline.understoodRatio - (tol.understoodDrop ?? 0))
    out.push(`understood ${baseline.understoodRatio} → ${current.understoodRatio}`);
  if (current.hasTree === false && baseline.hasTree) out.push('no longer produces a tree');
  if (current.treeProblems > baseline.treeProblems) out.push(`tree problems ${baseline.treeProblems} → ${current.treeProblems}`);
  if (current.blockingQuestions > baseline.blockingQuestions)
    out.push(`blocking questions ${baseline.blockingQuestions} → ${current.blockingQuestions}`);
  if (current.rules < baseline.rules) out.push(`rules ${baseline.rules} → ${current.rules}`);
  return out;
}
