import { createHash } from 'node:crypto';
import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { getInferenceDenial } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { ExperienceUnit } from '../semantic/types.js';
import type { ExtractionResult, KnowledgeExtractor } from './extractor-types.js';
import { RuleBasedKnowledgeExtractor } from './rule-based-extractor.js';
import {
  DEFAULT_ESCALATION_POLICY,
  decideEscalation,
  validateEscalationPolicy,
  type EscalationPolicyConfig,
  type EscalationReason,
  type RuleTier,
} from './escalation-policy.js';
import { MODEL_REJECTION_CODES, validateModelExtraction, type ModelRejectionCode } from './model-validation.js';

export type EscalationOutcome = 'accepted' | 'cache_hit' | 'denied' | 'failed' | 'rejected_invalid' | 'memoized';

export interface EscalationReport {
  readonly unitsSeen: number;
  readonly escalated: number;
  readonly skipped: number;
  /** Decision counts by reason (why a unit did or did not escalate). */
  readonly byReason: Readonly<Partial<Record<EscalationReason, number>>>;
  /** What happened to the units that escalated. `denied` = refused by the compile spend guard/policy; `failed` = provider error. */
  readonly outcomes: Readonly<Partial<Record<EscalationOutcome, number>>>;
  /** Fresh model calls ATTEMPTED by this extractor (escalated units minus memoized repeats). Includes cache replays, denied and failed calls; NOT a provider-call count: use `providerCalls`. */
  readonly modelCallsAttempted: number;
  /**
   * Responses actually OBTAINED from the provider (source `generated`), counted when they occur, including answers later rejected by
   * validation and answers with zero items. Cache replays, memoized repeats, denied calls and failed calls are NOT provider calls.
   */
  readonly providerCalls: number;
  /** Validation rejections by fixed code: the number of rejected units that had at least one violation of that code. Counts only. */
  readonly rejections: Readonly<Partial<Record<ModelRejectionCode, number>>>;
  /** Per rejected unit: its id and the DISTINCT fixed codes (in code-set order). No labels, text or model output. */
  readonly rejectedUnits: readonly { readonly unitId: string; readonly codes: readonly ModelRejectionCode[] }[];
  /**
   * Content-free DIAGNOSTICS about the rule output, computed in every mode. They NEVER affect a call unless `mode: 'gated'` is
   * explicitly opted in (experimental, NOT SUPPORTED by evidence). `ruleTiers` counts what the experimental gate would have classed
   * each (non-fragment) unit as; `unitsWithCompetingCandidates` counts units with competing candidates the rules cannot settle.
   */
  readonly diagnostics: {
    readonly ruleTiers: Readonly<Record<RuleTier, number>>;
    readonly unitsWithCompetingCandidates: number;
  };
}

/**
 * The extractor Stage 4 uses by default. `RuleBasedKnowledgeExtractor` ALWAYS runs first (it never fails, and its unit-primary node
 * is what `relationship-builder.ts` needs regardless). An optional AI extractor runs for every unit with content by default
 * (`mode: 'always'`); confidence gating (`mode: 'gated'`) is an explicit, EXPERIMENTAL opt-in that the live evaluation did NOT support
 * (see `escalation-policy.ts`). Confidence-tier and competing-pair diagnostics are reported as counts and never affect a call by default.
 *
 * Every escalation goes through the injected `AiKnowledgeExtractor` -> `AiCapabilityLayer`, i.e. the compile-scoped spend guard:
 *  - a denial (budget exhausted, kill-switch, unpriceable cost) is logged with `inferenceDenied: <reason>`, counted as `denied`, and
 *    the unit keeps its rule-based result. Nothing here retries, re-routes, or otherwise works around a denial.
 *  - model output is validated (`model-validation.ts`) before it is accepted; an invalid result is rejected whole, and only fixed
 *    rejection CODES are recorded or logged (never labels, ids, unit text, prompts or model output).
 *  - a unit (same id and content) is escalated at most once per extractor instance; repeats reuse the first outcome without a call.
 *    Retries inside one call are the layer's own bounded retry policy; this class adds none.
 * If AI is unavailable for any reason, the unit falls back to rule-based candidates alone — the spec's "lower confidence but correct".
 */
export class HybridKnowledgeExtractor implements KnowledgeExtractor {
  readonly name = 'hybrid';
  private readonly ruleBased = new RuleBasedKnowledgeExtractor();
  private readonly logger: Logger;
  private readonly policy: EscalationPolicyConfig;
  private readonly memo = new Map<string, Promise<Result<ExtractionResult, XoError>>>();
  private readonly counters = { unitsSeen: 0, escalated: 0, skipped: 0, modelCallsAttempted: 0, providerCalls: 0 };
  private readonly rejections: Partial<Record<ModelRejectionCode, number>> = {};
  private readonly rejectedUnits: { unitId: string; codes: ModelRejectionCode[] }[] = [];
  private readonly ruleTiers: Record<RuleTier, number> = { no_candidate: 0, low_confidence: 0, strong: 0 };
  private competingUnits = 0;
  private readonly byReason: Partial<Record<EscalationReason, number>> = {};
  private readonly outcomes: Partial<Record<EscalationOutcome, number>> = {};

  constructor(
    private readonly aiExtractor?: KnowledgeExtractor,
    logger?: Logger,
    escalation: Partial<EscalationPolicyConfig> = {},
  ) {
    this.logger = logger ?? noopLogger;
    this.policy = validateEscalationPolicy({ ...DEFAULT_ESCALATION_POLICY, ...escalation });
  }

  report(): EscalationReport {
    return {
      ...this.counters,
      byReason: { ...this.byReason },
      outcomes: { ...this.outcomes },
      rejections: { ...this.rejections },
      rejectedUnits: this.rejectedUnits.map((r) => ({ unitId: r.unitId, codes: [...r.codes] })),
      diagnostics: { ruleTiers: { ...this.ruleTiers }, unitsWithCompetingCandidates: this.competingUnits },
    };
  }

  async extract(unit: ExperienceUnit): Promise<Result<ExtractionResult, XoError>> {
    // P0.9A area C (Table Detection + Quarantine): a table-quarantined unit's content is cell text, not prose — running the
    // rule-based heuristics (tuned for sentences) against it would silently reinterpret table data as domain knowledge. No node is
    // minted for it at all; the unit and its provenance stay inspectable on `ExperienceDocument`.
    if (unit.isTableQuarantined) return ok({ nodes: [], edges: [] });

    const ruleResult = await this.ruleBased.extract(unit);
    if (!ruleResult.ok) return ruleResult; // RuleBasedKnowledgeExtractor never returns err, but the type permits it, so it is handled honestly

    // P0.9A area A: stamp each candidate with the extractor that actually produced it, at the one point every candidate passes through.
    const ruleNodes = ruleResult.value.nodes.map((n) => ({ ...n, extractorName: this.ruleBased.name }));
    const ruleOnly: ExtractionResult = { nodes: ruleNodes, edges: ruleResult.value.edges };

    if (!this.aiExtractor) return ok(ruleOnly);

    this.counters.unitsSeen += 1;
    const decision = decideEscalation(unit, ruleNodes, this.policy);
    this.byReason[decision.reason] = (this.byReason[decision.reason] ?? 0) + 1;
    if (decision.diagnostics) {
      this.ruleTiers[decision.diagnostics.ruleTier] += 1;
      if (decision.diagnostics.competing) this.competingUnits += 1;
    }
    if (!decision.escalate) {
      this.counters.skipped += 1;
      return ok(ruleOnly);
    }
    this.counters.escalated += 1;

    const key = `${unit.id}:${createHash('sha256').update(unit.content).digest('hex')}`;
    const existing = this.memo.get(key);
    if (existing) this.bump('memoized');
    const pending =
      existing ??
      (() => {
        this.counters.modelCallsAttempted += 1;
        const call = this.aiExtractor!.extract(unit);
        this.memo.set(key, call);
        return call;
      })();
    const aiResult = await pending;
    // Call accounting happens once per distinct call (the creator, not memoized repeats), BEFORE validation, so an answer that is later
    // rejected, or that holds zero items, still counts as the provider response it was. Denied/failed calls carry no response.
    if (!existing && aiResult.ok && callSource(aiResult.value) === 'generated') this.counters.providerCalls += 1;

    if (!aiResult.ok) {
      const denial = getInferenceDenial(aiResult.error);
      if (!existing) this.bump(denial ? 'denied' : 'failed');
      this.logger.warn('AI knowledge extraction unavailable for this unit; falling back to rule-based only', {
        unitId: unit.id,
        error: aiResult.error.message,
        errorCode: aiResult.error.code,
        escalationReason: decision.reason,
        // Distinguishes "inference was refused (budget/policy)" from "provider failed"; the compile continues degraded either way.
        ...(denial ? { inferenceDenied: denial.reason } : {}),
      });
      return ok(ruleOnly);
    }

    const violations = validateModelExtraction(unit, aiResult.value);
    if (violations.length > 0) {
      const codes = MODEL_REJECTION_CODES.filter((c) => violations.includes(c));
      if (!existing) {
        this.bump('rejected_invalid');
        for (const c of codes) this.rejections[c] = (this.rejections[c] ?? 0) + 1;
        this.rejectedUnits.push({ unitId: unit.id, codes: [...codes] });
      }
      this.logger.warn('Model-derived knowledge failed validation; rejected (rule-based result kept)', {
        unitId: unit.id,
        escalationReason: decision.reason,
        violationCount: violations.length,
        rejectionCodes: codes,
      });
      return ok(ruleOnly);
    }

    const aiNodes = aiResult.value.nodes.map((n) => ({
      ...n,
      extractorName: this.aiExtractor!.name,
      provenance: {
        ...n.provenance,
        ...(n.provenance.derivation ? { derivation: { ...n.provenance.derivation, escalationReason: decision.reason } } : {}),
      },
    }));
    if (!existing) this.bump(callSource(aiResult.value) === 'cache' ? 'cache_hit' : 'accepted');
    return ok({ nodes: [...ruleNodes, ...aiNodes], edges: [...ruleResult.value.edges, ...aiResult.value.edges] });
  }

  private bump(outcome: EscalationOutcome): void {
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
  }
}

/**
 * Where a model answer came from. Prefers the explicit `modelCall` on the result (present even for zero-item answers); falls back to
 * node derivations for a custom extractor that does not set it. `undefined` = unknown, and unknown is never counted as a provider call.
 */
function callSource(result: ExtractionResult): 'generated' | 'cache' | undefined {
  if (result.modelCall) return result.modelCall.source;
  const sources = result.nodes.map((n) => n.provenance.derivation?.source);
  if (sources.includes('cache')) return 'cache';
  return sources.includes('generated') ? 'generated' : undefined;
}
