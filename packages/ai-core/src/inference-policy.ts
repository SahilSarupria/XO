import { AiError, ErrorCode } from '@xo/errors';
import { computeCostUsd, type PricingTable, DEFAULT_PRICING_TABLE } from './cost.js';
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
  'server_disabled' | 'run_disabled' | 'node_declares_none' | 'node_undeclared' | 'provider_not_allowed' | 'budget_exhausted';

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
}

export type AuthorizeResult =
  { readonly ok: true; readonly grant: InferenceGrant } | { readonly ok: false; readonly denial: InferenceDenial };

interface Ledger {
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  tokensSpent: number;
  tokensReserved: number;
  costSpentUsd: number;
}

const newLedger = (maxTokens: number | undefined, maxCostUsd: number | undefined): Ledger => ({
  maxTokens: maxTokens ?? Number.POSITIVE_INFINITY,
  maxCostUsd: maxCostUsd ?? Number.POSITIVE_INFINITY,
  tokensSpent: 0,
  tokensReserved: 0,
  costSpentUsd: 0,
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
  snapshot(): { readonly tokensSpent: number; readonly tokensReserved: number; readonly costSpentUsd: number } {
    return { tokensSpent: this.run.tokensSpent, tokensReserved: this.run.tokensReserved, costSpentUsd: this.run.costSpentUsd };
  }

  authorize(input: AuthorizeInput): AuthorizeResult {
    const deny = (reason: InferenceDenialReason, message: string): AuthorizeResult => ({
      ok: false,
      denial: { reason, message, nodeId: input.nodeId, providerId: input.providerId },
    });
    const policyDenial = this.checkPolicy(input);
    if (policyDenial) return { ok: false, denial: policyDenial };

    // Budgets: tokens are reserved up front (so concurrent calls cannot jointly overshoot) and reconciled on settle.
    const available = Math.min(remainingTokens(this.server), remainingTokens(this.run));
    const costExhausted = this.server.costSpentUsd >= this.server.maxCostUsd || this.run.costSpentUsd >= this.run.maxCostUsd;
    if (available < 1 || costExhausted) return deny('budget_exhausted', 'Inference budget is exhausted');

    const granted = Math.max(1, Math.min(input.requestedMaxOutputTokens, Math.floor(available)));
    this.server.tokensReserved += granted;
    this.run.tokensReserved += granted;
    let settled = false;
    const finish = (spent: number, costUsd: number): void => {
      if (settled) return;
      settled = true;
      for (const ledger of [this.server, this.run]) {
        ledger.tokensReserved -= granted;
        ledger.tokensSpent += spent;
        ledger.costSpentUsd += costUsd;
      }
    };
    return {
      ok: true,
      grant: {
        maxOutputTokens: granted,
        settle: ({ providerId, model, usage }) => {
          // Unknown usage is charged at the reservation: for BUDGET purposes we assume the worst we allowed, never "free".
          // (Cost stays 0 because we will not fabricate a price for tokens we cannot count.)
          const spent = usage ? usage.inputTokens + usage.outputTokens : granted;
          finish(spent, usage ? computeCostUsd(providerId, model, usage, this.pricing) : 0);
        },
        release: () => finish(0, 0),
      },
    };
  }
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
