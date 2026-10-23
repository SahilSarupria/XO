import { CanonicalizationError, canonicalJson, sha256Hex } from './canonical.js';
import { reconcileDispatch, type ReconcileOutcome, type ReconcileRequest } from './reconciliation.js';
import type {
  AdapterInvokeResult,
  DispatchContext,
  DispatchEvidence,
  DispatchLedger,
  ExternalEffectState,
  ExternalToolAdapter,
} from './contract.js';

/**
 * What a dispatch call can end in. The first four never reached the adapter
 * (`dispatched: false`): nothing external happened.
 */
export type DispatchOutcome =
  | { readonly kind: 'not_configured'; readonly dispatched: false; readonly reason: string }
  | { readonly kind: 'invalid_request'; readonly dispatched: false; readonly reason: string }
  | { readonly kind: 'ledger_unavailable'; readonly dispatched: false; readonly reason: string }
  | {
      /** A prior attempt exists for this key; re-dispatch is refused. `requiresReconciliation` is true unless that attempt confirmed success or confirmed no-effect. */
      readonly kind: 'blocked_prior_dispatch';
      readonly dispatched: false;
      readonly priorState: string;
      readonly requiresReconciliation: boolean;
      readonly reason: string;
    }
  | {
      /**
       * An earlier dispatch to this capability settled as `confirmed_failure_no_effect` and no human approval newer than that settlement
       * was supplied. A new attempt needs a fresh approval; nothing was dispatched.
       */
      readonly kind: 'fresh_approval_required';
      readonly dispatched: false;
      readonly previousDispatchKey: string;
      readonly reason: string;
    }
  | { readonly kind: 'confirmed_success'; readonly dispatched: true; readonly adapterId: string; readonly output: unknown }
  | {
      readonly kind: 'confirmed_failure_no_effect';
      readonly dispatched: true;
      readonly adapterId: string;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'outcome_unknown'; readonly dispatched: true; readonly adapterId: string; readonly reason: string };

export interface ExternalToolDispatcherOptions {
  /** Explicit configuration: capability (contract) id -> adapter. Nothing else can ever be dispatched. */
  readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
  readonly ledger: DispatchLedger;
  /**
   * TEST / LOCAL USE ONLY. Without it, construction THROWS unless `ledger.durability === 'durable'`, so a dispatcher over an in-memory (or
   * unlabelled) ledger can never be built by accident. Setting it does not make evidence durable; a restart still loses it, which can
   * allow a blind redispatch. Never set it for a consequential adapter (the API server additionally refuses it when NODE_ENV=production).
   */
  readonly unsafeAllowVolatileLedger?: boolean;
  /** Injectable clock for the freshness rule (tests). Defaults to the host clock. */
  readonly now?: () => Date;
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Parses ONLY the canonical UTC instant form `YYYY-MM-DDTHH:mm:ss.sssZ` (what `Date.prototype.toISOString` and the ledger/approval stores
 * write) and requires an exact round trip. Anything else — offsets, date-only, missing milliseconds, impossible dates, non-strings —
 * is `undefined`: ambiguous timestamps are refused, never interpreted.
 */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? undefined : ms;
}

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Fail-closed, single-shot dispatcher.
 *  - no configured adapter  => nothing is called;
 *  - one dispatch per `dispatchKey`, ever: there is NO retry here, and a second call with the same key is refused;
 *  - `dispatch_attempted` evidence is written BEFORE the adapter is invoked (if that write fails, the adapter is not called);
 *  - a throw, a rejection, or any result that is not exactly one of the three declared shapes is `outcome_unknown`.
 * It never classifies an effect on its own authority and never resolves or clears an unknown outcome.
 */
export class ExternalToolDispatcher {
  private readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
  private readonly ledger: DispatchLedger;
  private readonly now: () => Date;

  constructor(options: ExternalToolDispatcherOptions) {
    if (options.ledger.durability !== 'durable' && options.unsafeAllowVolatileLedger !== true) {
      throw new Error(
        'ExternalToolDispatcher requires a durable DispatchLedger (e.g. BlobDispatchLedger over a persistent AtomicBlobStore); a volatile or unlabelled ledger may only be used with an explicit unsafeAllowVolatileLedger opt-in (tests/local only)',
      );
    }
    this.adapters = new Map(options.adapters);
    for (const [capabilityId, adapter] of this.adapters) {
      try {
        adapterConfigDigest(adapter);
      } catch (cause) {
        throw new Error(
          `adapter "${adapter.id}" for "${capabilityId}" has a securityConfig that cannot be canonicalized (${describe(cause)}); refused`,
        );
      }
    }
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date());
  }

  /** `'durable'` only when the ledger says so; anything else (including an unlabelled ledger) is `'volatile'`. */
  get ledgerDurability(): 'durable' | 'volatile' {
    return this.ledger.durability === 'durable' ? 'durable' : 'volatile';
  }

  /** True only for an explicitly configured capability id. */
  isConfigured(capabilityId: string): boolean {
    return this.adapters.has(capabilityId);
  }

  /** Digest of the configured adapter's security-relevant configuration, or `undefined` when no adapter is configured. */
  configDigestFor(capabilityId: string): string | undefined {
    const adapter = this.adapters.get(capabilityId);
    return adapter === undefined ? undefined : adapterConfigDigest(adapter);
  }

  adapterIdFor(capabilityId: string): string | undefined {
    return this.adapters.get(capabilityId)?.id;
  }

  /** The full, ordered evidence for one dispatch key (empty if none). Throws if the ledger is unreadable or corrupt. */
  async evidenceFor(dispatchKey: string): Promise<readonly DispatchEvidence[]> {
    return this.ledger.read(dispatchKey);
  }

  /** Records an authorized reconciliation decision. Never invokes an adapter and never redispatches. See `reconciliation.ts`. */
  reconcile(request: ReconcileRequest): Promise<ReconcileOutcome> {
    return reconcileDispatch(this.ledger, request);
  }

  async dispatch(capabilityId: string, dispatchKey: string, input: unknown, context: DispatchContext = {}): Promise<DispatchOutcome> {
    const adapter = this.adapters.get(capabilityId);
    if (adapter === undefined) {
      return { kind: 'not_configured', dispatched: false, reason: `no adapter is configured for capability "${capabilityId}"` };
    }
    if (typeof dispatchKey !== 'string' || dispatchKey.length === 0) {
      return { kind: 'invalid_request', dispatched: false, reason: 'a server-derived dispatchKey is required' };
    }
    if (!isPlainObject(input)) {
      return { kind: 'invalid_request', dispatched: false, reason: 'external_tool input must be a plain object' };
    }

    let inputFingerprint: string;
    try {
      inputFingerprint = fingerprintOf(input);
    } catch (cause) {
      const detail = cause instanceof CanonicalizationError ? cause.message : 'unsupported value';
      return { kind: 'invalid_request', dispatched: false, reason: `external_tool input cannot be canonicalized (${detail})` };
    }

    let prior: readonly DispatchEvidence[];
    try {
      prior = await this.ledger.read(dispatchKey);
    } catch (cause) {
      return { kind: 'ledger_unavailable', dispatched: false, reason: `evidence ledger unreadable: ${describe(cause)}` };
    }
    if (prior.length > 0) return blockedByPrior(dispatchKey, prior[prior.length - 1]!);

    // An earlier dispatch to this capability whose outcome is not settled (unknown, or attempted with no terminal evidence) blocks EVERY
    // further dispatch to it until it is reconciled through `reconcile` (an authorized, recorded decision). There is no automatic recovery.
    let unsettled: string | undefined;
    let follows: DispatchEvidence['follows'];
    try {
      const lastByKey = new Map<string, DispatchEvidence>();
      for (const e of await this.ledger.readByCapability(capabilityId)) lastByKey.set(e.dispatchKey, e);
      let newestNoEffect: DispatchEvidence | undefined;
      let newestOther: DispatchEvidence | undefined;
      for (const [key, last] of lastByKey) {
        if (last.state === 'outcome_unknown' || last.state === 'dispatch_attempted') {
          unsettled = `${key} (${last.state})`;
          break;
        }
        const target = last.state === 'confirmed_failure_no_effect' ? 'noEffect' : 'other';
        const best = target === 'noEffect' ? newestNoEffect : newestOther;
        // Ordering needs parseable instants. An unparsable no-effect settlement is treated as the newest (blocks); an unparsable success never supersedes.
        const at = parseInstant(last.recordedAt);
        const bestAt = best === undefined ? undefined : parseInstant(best.recordedAt);
        const newer =
          best === undefined ||
          (target === 'noEffect'
            ? at === undefined || (bestAt !== undefined && at > bestAt)
            : at !== undefined && (bestAt === undefined || at > bestAt));
        if (newer) {
          if (target === 'noEffect') newestNoEffect = last;
          else newestOther = last;
        }
      }
      // Fresh-approval rule (design decision of this implementation, not a recovered requirement): if the capability's most recent
      // settled dispatch is a confirmed no-effect failure, a new attempt needs a human approval granted AFTER that settlement. Missing or
      // unparsable timestamps cannot establish freshness, so they block.
      if (unsettled === undefined && newestNoEffect !== undefined) {
        const otherAt = newestOther === undefined ? undefined : parseInstant(newestOther.recordedAt);
        const noEffectAt = parseInstant(newestNoEffect.recordedAt);
        const supersededBySuccess = otherAt !== undefined && noEffectAt !== undefined && otherAt > noEffectAt;
        if (!supersededBySuccess) {
          // Freshness needs two unambiguous instants on ONE clock: the settlement (ledger clock) and the approval (approval store clock).
          // Both must parse strictly, neither may lie in the future of this host's clock (a skewed or tampered stamp could make a stale
          // approval look fresh forever, or a settlement look old), and the approval must be strictly later. Otherwise: refuse.
          const settledAt = parseInstant(newestNoEffect.recordedAt);
          const approvedAt = parseInstant(context.approvedAt);
          const nowMs = this.now().getTime();
          const usable = settledAt !== undefined && approvedAt !== undefined && settledAt <= nowMs && approvedAt <= nowMs;
          if (!usable || !(approvedAt > settledAt)) {
            return {
              kind: 'fresh_approval_required',
              dispatched: false,
              previousDispatchKey: newestNoEffect.dispatchKey,
              reason: `capability "${capabilityId}" last settled as confirmed_failure_no_effect (${newestNoEffect.dispatchKey}); a new attempt requires a human approval granted after that settlement`,
            };
          }
          follows = { dispatchKey: newestNoEffect.dispatchKey, outcome: 'confirmed_failure_no_effect' };
        }
      }
    } catch (cause) {
      return { kind: 'ledger_unavailable', dispatched: false, reason: `evidence ledger unreadable: ${describe(cause)}` };
    }
    if (unsettled !== undefined) {
      return {
        kind: 'blocked_prior_dispatch',
        dispatched: false,
        priorState: 'unreconciled',
        requiresReconciliation: true,
        reason: `capability "${capabilityId}" has an unreconciled earlier dispatch ${unsettled}; reconciliation is required before any further dispatch`,
      };
    }

    // Write-ahead evidence. With an atomic `claim` exactly one concurrent caller wins the key; a loser has NOT dispatched and is blocked.
    const attempted = {
      dispatchKey,
      capabilityId,
      adapterId: adapter.id,
      state: 'dispatch_attempted' as const,
      inputFingerprint,
      actionDigest: actionDigestOf(capabilityId, adapter, inputFingerprint),
      ...(context.auditCorrelationId !== undefined ? { auditCorrelationId: context.auditCorrelationId } : {}),
      ...(follows !== undefined ? { follows } : {}),
    };
    try {
      if (this.ledger.claim !== undefined) {
        const claim = await this.ledger.claim(attempted);
        if (!claim.claimed) {
          let after: readonly DispatchEvidence[] = [];
          try {
            after = await this.ledger.read(dispatchKey);
          } catch {
            /* fall through: the claim was lost, which is enough to refuse */
          }
          const last = after[after.length - 1];
          return last !== undefined
            ? blockedByPrior(dispatchKey, last)
            : {
                kind: 'blocked_prior_dispatch',
                dispatched: false,
                priorState: 'dispatch_attempted',
                requiresReconciliation: true,
                reason: `dispatch "${dispatchKey}" is held by another caller; reconciliation is required before any further dispatch`,
              };
        }
      } else {
        await this.ledger.append(attempted);
      }
    } catch (cause) {
      return {
        kind: 'ledger_unavailable',
        dispatched: false,
        reason: `evidence could not be recorded, so nothing was dispatched: ${describe(cause)}`,
      };
    }

    let raw: unknown;
    try {
      raw = await adapter.invoke({ capabilityId, dispatchKey, input: Object.freeze({ ...input }) });
    } catch (cause) {
      return this.settle(capabilityId, dispatchKey, adapter, context.auditCorrelationId, {
        kind: 'outcome_unknown',
        reason: `adapter threw after dispatch: ${describe(cause)}`,
      });
    }
    return this.settle(capabilityId, dispatchKey, adapter, context.auditCorrelationId, normalize(raw));
  }

  private async settle(
    capabilityId: string,
    dispatchKey: string,
    adapter: ExternalToolAdapter,
    auditCorrelationId: string | undefined,
    result: AdapterInvokeResult,
  ): Promise<DispatchOutcome> {
    const detail =
      result.kind === 'outcome_unknown'
        ? result.reason
        : result.kind === 'confirmed_failure_no_effect'
          ? `${result.code}: ${result.message}`
          : undefined;
    try {
      const entry = {
        dispatchKey,
        capabilityId,
        adapterId: adapter.id,
        state: result.kind satisfies ExternalEffectState,
        ...(auditCorrelationId !== undefined ? { auditCorrelationId } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
      if (this.ledger.appendAfter === undefined) {
        await this.ledger.append(entry);
      } else {
        // Compare-and-append: the terminal result is recorded only on top of the evidence this dispatch last saw. If a reconciliation (or
        // anything else) wrote in the meantime, the two accounts of the same effect disagree: keep BOTH and report unknown rather than pick one.
        const seen = await this.ledger.read(dispatchKey);
        const last = seen[seen.length - 1];
        if (last === undefined) throw new Error('the dispatch_attempted entry is missing');
        if (last.state !== 'dispatch_attempted') {
          await this.ledger.appendAfter(dispatchKey, last.seq, {
            ...entry,
            state: 'outcome_unknown',
            detail: `adapter reported ${result.kind} after the evidence had already moved to ${last.state}; the accounts conflict`,
          });
          return {
            kind: 'outcome_unknown',
            dispatched: true,
            adapterId: adapter.id,
            reason: `adapter reported ${result.kind} but the evidence had already been changed (${last.state}); treated as unknown`,
          };
        }
        const appended = await this.ledger.appendAfter(dispatchKey, last.seq, entry);
        if (!appended.appended) throw new Error('the evidence changed while the result was being recorded');
      }
    } catch (cause) {
      // The adapter already ran. If the terminal evidence cannot be recorded the result cannot be trusted to be reconstructable: report unknown.
      // The durable `dispatch_attempted` entry remains, so the key stays blocked (unsettled) after any restart.
      return {
        kind: 'outcome_unknown',
        dispatched: true,
        adapterId: adapter.id,
        reason: `adapter reported ${result.kind} but the terminal evidence could not be recorded: ${describe(cause)}`,
      };
    }
    switch (result.kind) {
      case 'confirmed_success':
        return { kind: 'confirmed_success', dispatched: true, adapterId: adapter.id, output: result.output };
      case 'confirmed_failure_no_effect':
        return { kind: 'confirmed_failure_no_effect', dispatched: true, adapterId: adapter.id, code: result.code, message: result.message };
      case 'outcome_unknown':
        return { kind: 'outcome_unknown', dispatched: true, adapterId: adapter.id, reason: result.reason };
    }
  }
}

function blockedByPrior(dispatchKey: string, last: DispatchEvidence): DispatchOutcome {
  const settled = last.state === 'confirmed_success' || last.state === 'confirmed_failure_no_effect';
  return {
    kind: 'blocked_prior_dispatch',
    dispatched: false,
    priorState: last.state,
    requiresReconciliation: !settled,
    reason: settled
      ? `dispatch "${dispatchKey}" already ran (${last.state}); a second dispatch under the same key is refused`
      : `dispatch "${dispatchKey}" has a prior attempt in state ${last.state}; reconciliation is required before any further dispatch`,
  };
}

/** Stable identity of an input: SHA-256 over STRICT canonical JSON (sorted keys). Throws `CanonicalizationError` for an unsupported value. The input itself is never persisted. */
export function fingerprintOf(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/** Digest of an adapter's security-relevant configuration (`securityConfig`, absent = `{}`). Throws `CanonicalizationError` if it cannot be canonicalized. */
export function adapterConfigDigest(adapter: ExternalToolAdapter): string {
  return sha256Hex(canonicalJson({ schema: 'xo.adapter-config.v1', adapterId: adapter.id, config: adapter.securityConfig ?? {} }));
}

/** The exact action a dispatch key is claimed for: capability + adapter identity/config + input identity. No values are included. */
export function actionDigestOf(capabilityId: string, adapter: ExternalToolAdapter, inputFingerprint: string): string {
  return sha256Hex(
    canonicalJson({ schema: 'xo.external-action.v1', capabilityId, config: adapterConfigDigest(adapter), inputFingerprint }),
  );
}

function normalize(raw: unknown): AdapterInvokeResult {
  if (isPlainObject(raw)) {
    if (raw['kind'] === 'confirmed_success' && 'output' in raw) return { kind: 'confirmed_success', output: raw['output'] };
    if (raw['kind'] === 'confirmed_failure_no_effect' && typeof raw['code'] === 'string' && typeof raw['message'] === 'string') {
      return { kind: 'confirmed_failure_no_effect', code: raw['code'], message: raw['message'] };
    }
    if (raw['kind'] === 'outcome_unknown' && typeof raw['reason'] === 'string') return { kind: 'outcome_unknown', reason: raw['reason'] };
  }
  return { kind: 'outcome_unknown', reason: 'adapter returned a result that is not one of the declared outcome shapes' };
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
