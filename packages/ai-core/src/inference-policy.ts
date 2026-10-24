import { AiError, ErrorCode } from '@xo/errors';
import { computeCostUsd, findPricing, type PricingTable, DEFAULT_PRICING_TABLE } from './cost.js';
import type { ProviderId, TokenUsage } from './provider-types.js';

/**
 * Inference authorization.
 *
 * Three independent authorities must ALL agree before a provider call is made, and none of them can grant what another denies:
 *
 *  1. NODE   — the capability/step's declaration. `'required'` means "this node needs inference to complete its declared
 *              operation"; it is NOT an instruction to call a model regardless of policy. `'none'` can never infer.
 *              `'undeclared'` (no declaration at all, e.g. every package compiled before declarations existed) is DENIED unless
 *              the server explicitly opts in via `allowUndeclared`.
 *  2. SERVER — organisation policy: kill-switch, provider allow-list, and a cumulative budget.
 *  3. RUN    — a per-execution restriction. It can only DISABLE inference or TIGHTEN limits (`RunInferenceRestriction` has no
 *              field capable of granting anything, and limits combine with `min`).
 *
 * A denial is a structured `InferenceDenial`, never a silent fallback to a different provider or code path.
 */
export type InferenceRequirement = 'none' | 'required';
export type NodeInferenceDeclaration = InferenceRequirement | 'undeclared';

export interface ServerInferencePolicy {
  /** Organisation kill-switch. `false` denies every inference call. */
  readonly enabled: boolean;
  /**
   * Legacy escape hatch: allow nodes with NO inference declaration to infer. Default `false`, so undeclared (pre-declaration)
   * capabilities do not call an LLM by default. Turning this on is an explicit operator decision.
   */
  readonly allowUndeclared: boolean;
  /** When set, only these providers may be called. */
  readonly allowedProviders?: readonly ProviderId[];
  /** Cumulative (process-lifetime, until `resetBudget()`) limits shared by every run. Omit = unlimited. */
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
}

/** Fail-closed default: inference on only for nodes that declare `'required'`. */
export const DEFAULT_SERVER_INFERENCE_POLICY: ServerInferencePolicy = { enabled: true, allowUndeclared: false };

/** Restrict-only by construction: every field either disables or lowers a limit. There is intentionally nothing to "enable". */
export interface RunInferenceRestriction {
  readonly disabled?: boolean;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
}

export type InferenceDenialReason =
  | 'server_disabled'
  | 'run_disabled'
  | 'node_declares_none'
  | 'node_undeclared'
  | 'provider_not_allowed'
  | 'budget_exhausted'
  /** A cost cap is configured but the call's cost cannot be reliably bounded (unknown model price, or no input-size estimate). */
  | 'cost_unestimable';

export interface InferenceDenial {
  readonly reason: InferenceDenialReason;
  readonly message: string;
  readonly nodeId: string;
  readonly providerId: ProviderId;
}

export interface InferenceGrant {
  /** The most output tokens this call may request: the caller's request clamped to what the remaining budget allows. */
  readonly maxOutputTokens: number;
  /** Settle exactly once with the real usage (or `undefined` if the provider reported none), or `release()` if no call completed. */
  settle(settlement: { providerId: ProviderId; model: string; usage: TokenUsage | undefined }): void;
  release(): void;
}

export interface InferenceDispatchContext {
  readonly requirement: NodeInferenceDeclaration;
  readonly nodeId: string;
  readonly scope: InferenceRunScope;
}

export interface AuthorizeInput {
  readonly requirement: NodeInferenceDeclaration;
  readonly nodeId: string;
  readonly providerId: ProviderId;
  readonly requestedMaxOutputTokens: number;
  /** Required for cost-capped inference: the model whose price bounds the call. */
  readonly model?: string;
  /** Required for cost-capped inference: a CONSERVATIVE upper bound on input tokens (see `estimateInputTokensUpperBound`). */
  readonly inputTokensUpperBound?: number;
}

export type AuthorizeResult =
  { readonly ok: true; readonly grant: InferenceGrant } | { readonly ok: false; readonly denial: InferenceDenial };

interface Ledger {
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  tokensSpent: number;
  tokensReserved: number;
  costSpentUsd: number;
  costReserved: number;
}

const newLedger = (maxTokens: number | undefined, maxCostUsd: number | undefined): Ledger => ({
  maxTokens: maxTokens ?? Number.POSITIVE_INFINITY,
  maxCostUsd: maxCostUsd ?? Number.POSITIVE_INFINITY,
  tokensSpent: 0,
  tokensReserved: 0,
  costSpentUsd: 0,
  costReserved: 0,
});

const remainingTokens = (l: Ledger): number => l.maxTokens - l.tokensSpent - l.tokensReserved;

function assertLimit(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isFinite(value) && value >= 0)) throw new RangeError(`${name} must be a finite number >= 0`);
}

/**
 * Process-level guard: owns the server policy and the cumulative server budget. One instance per runtime; `beginRun` yields the
 * per-execution scope that dispatch sites must pass to the authoritative executor.
 */
export class InferenceGuard {
  private readonly server: Ledger;

  constructor(
    readonly policy: ServerInferencePolicy = DEFAULT_SERVER_INFERENCE_POLICY,
    private readonly pricing: PricingTable = DEFAULT_PRICING_TABLE,
  ) {
    assertLimit('maxTotalTokens', policy.maxTotalTokens);
    assertLimit('maxCostUsd', policy.maxCostUsd);
    this.server = newLedger(policy.maxTotalTokens, policy.maxCostUsd);
  }

  beginRun(restriction?: RunInferenceRestriction): InferenceRunScope {
    assertLimit('run maxTotalTokens', restriction?.maxTotalTokens);
    assertLimit('run maxCostUsd', restriction?.maxCostUsd);
    return new InferenceRunScope(this.policy, this.server, restriction, this.pricing);
  }

  resetBudget(): void {
    this.server.tokensSpent = 0;
    this.server.costSpentUsd = 0;
  }

  /** Observability only (never used for decisions). */
  budgetSnapshot(): { readonly tokensSpent: number; readonly costSpentUsd: number } {
    return { tokensSpent: this.server.tokensSpent, costSpentUsd: this.server.costSpentUsd };
  }
}

export class InferenceRunScope {
  private readonly run: Ledger;

  constructor(
    private readonly policy: ServerInferencePolicy,
    private readonly server: Ledger,
    private readonly restriction: RunInferenceRestriction | undefined,
    private readonly pricing: PricingTable,
  ) {
    this.run = newLedger(restriction?.maxTotalTokens, restriction?.maxCostUsd);
  }

  /**
   * Every NON-budget check, with no reservation and no side effects. Lets a caller refuse work that policy forbids even when the
   * answer would come from a cache (budget deliberately excluded: serving a cached answer spends nothing).
   */
  checkPolicy(input: Omit<AuthorizeInput, 'requestedMaxOutputTokens'>): InferenceDenial | undefined {
    const deny = (reason: InferenceDenialReason, message: string): InferenceDenial => ({
      reason,
      message,
      nodeId: input.nodeId,
      providerId: input.providerId,
    });
    // Order matters only for which reason is reported; every check must pass.
    if (!this.policy.enabled) return deny('server_disabled', 'Inference is disabled by server policy');
    if (this.restriction?.disabled === true) return deny('run_disabled', 'Inference is disabled for this run');
    if (input.requirement === 'none') return deny('node_declares_none', `Node "${input.nodeId}" declares inference: none`);
    if (input.requirement === 'undeclared' && !this.policy.allowUndeclared) {
      return deny(
        'node_undeclared',
        `Node "${input.nodeId}" has no inference declaration and server policy does not allow undeclared inference`,
      );
    }
    if (this.policy.allowedProviders && !this.policy.allowedProviders.includes(input.providerId)) {
      return deny('provider_not_allowed', `Provider "${input.providerId}" is not permitted by server policy`);
    }
    return undefined;
  }

  /** What this scope's own ledger has spent/reserved (reporting only; never used for decisions). */
  snapshot(): {
    readonly tokensSpent: number;
    readonly tokensReserved: number;
    readonly costSpentUsd: number;
    readonly costReserved: number;
  } {
    return {
      tokensSpent: this.run.tokensSpent,
      tokensReserved: this.run.tokensReserved,
      costSpentUsd: this.run.costSpentUsd,
      costReserved: this.run.costReserved,
    };
  }

  /**
   * `true` when this scope can actually limit something: a finite token or cost limit at server or run level, or inference is
   * disabled. A scope built from an unlimited policy is NOT bounded (it merely measures).
   */
  isBounded(): boolean {
    const finite = [this.server, this.run].some((l) => Number.isFinite(l.maxTokens) || Number.isFinite(l.maxCostUsd));
    return finite || !this.policy.enabled || this.restriction?.disabled === true;
  }

  authorize(input: AuthorizeInput): AuthorizeResult {
    const deny = (reason: InferenceDenialReason, message: string): AuthorizeResult => ({
      ok: false,
      denial: { reason, message, nodeId: input.nodeId, providerId: input.providerId },
    });
    const policyDenial = this.checkPolicy(input);
    if (policyDenial) return { ok: false, denial: policyDenial };

    // Budgets are RESERVED up front (so concurrent calls cannot jointly overshoot) and reconciled on settle.
    const ledgers = [this.server, this.run];
    const tokenAvailable = Math.floor(Math.min(remainingTokens(this.server), remainingTokens(this.run)));
    if (tokenAvailable < 1) return deny('budget_exhausted', 'Inference budget is exhausted');
    let granted = Math.max(1, Math.min(input.requestedMaxOutputTokens, tokenAvailable));

    // Dollar cap: bound the call's cost BEFORE it is made, from the model's price and a conservative input-size bound. An unknown
    // price is never treated as free, and a call whose cost cannot be bounded is refused rather than allowed to run unmetered.
    let costReserve = 0;
    if (ledgers.some((l) => Number.isFinite(l.maxCostUsd))) {
      const price = input.model !== undefined ? findPricing(this.pricing, input.providerId, input.model) : undefined;
      if (!price || input.inputTokensUpperBound === undefined) {
        return deny(
          'cost_unestimable',
          `A cost limit is set but the cost of "${input.providerId}/${input.model ?? '?'}" cannot be bounded (${price ? 'no input-size estimate supplied' : 'no price for this model; add it to the pricing table'})`,
        );
      }
      const remainingCost = Math.min(...ledgers.map((l) => l.maxCostUsd - l.costSpentUsd - l.costReserved));
      const inputCost = (input.inputTokensUpperBound / 1000) * price.inputPerThousand;
      if (remainingCost <= inputCost) return deny('budget_exhausted', 'Inference cost budget is exhausted');
      if (price.outputPerThousand > 0) {
        const affordable = Math.floor(((remainingCost - inputCost) / price.outputPerThousand) * 1000);
        if (affordable < 1) return deny('budget_exhausted', 'Inference cost budget is exhausted');
        granted = Math.min(granted, affordable);
      }
      costReserve = inputCost + (granted / 1000) * price.outputPerThousand;
    }

    for (const ledger of ledgers) {
      ledger.tokensReserved += granted;
      ledger.costReserved += costReserve;
    }
    let settled = false;
    const finish = (spent: number, costUsd: number): void => {
      if (settled) return;
      settled = true;
      for (const ledger of ledgers) {
        ledger.tokensReserved -= granted;
        ledger.costReserved -= costReserve;
        ledger.tokensSpent += spent;
        ledger.costSpentUsd += costUsd;
      }
    };
    return {
      ok: true,
      grant: {
        maxOutputTokens: granted,
        settle: ({ providerId, model, usage }) => {
          // Unknown usage is charged at the reservation for BOTH tokens and (when a cost cap is active) cost: the worst we
          // allowed, never "free". With no cost cap there is no price bound to charge, so cost stays 0 (nothing is fabricated).
          finish(
            usage ? usage.inputTokens + usage.outputTokens : granted,
            usage ? computeCostUsd(providerId, model, usage, this.pricing) : costReserve,
          );
        },
        release: () => finish(0, 0),
      },
    };
  }
}

/**
 * A deliberately conservative UPPER bound on input tokens, for cost reservation. Every token occupies at least one byte of the
 * serialized prompt, so UTF-8 byte length bounds the token count for byte-level tokenizers; the fixed margin covers chat-template and
 * special-token overhead. `extraText` should carry anything else sent as input (e.g. a serialized response schema). It over-estimates
 * (often several times) by design: the cost of being wrong in this direction is a clamped output cap, not an overspend. It is an
 * assumption about tokenizers, not a guarantee; a provider that bills input differently (e.g. images, tool definitions) is not covered.
 */
export function estimateInputTokensUpperBound(messages: readonly { readonly content: string }[], extraText = ''): number {
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), Buffer.byteLength(extraText, 'utf8'));
  return bytes + 512 + messages.length * 16;
}

/** The typed outcome for a denied call: its own error code (NOT a provider failure), carrying the structured denial. */
export function inferenceDeniedError(denial: InferenceDenial, scope: 'compile' | 'runtime' = 'compile'): AiError {
  return new AiError(ErrorCode.AI_INFERENCE_DENIED, `Inference denied (${denial.reason}): ${denial.message}`, {
    context: { inferenceDenial: { ...denial }, scope },
  });
}

export function getInferenceDenial(error: unknown): InferenceDenial | undefined {
  if (!(error instanceof AiError) || error.code !== ErrorCode.AI_INFERENCE_DENIED) return undefined;
  return (error.context as { inferenceDenial?: InferenceDenial }).inferenceDenial;
}
