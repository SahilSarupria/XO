import { CanonicalizationError, canonicalJson, sha256Hex } from './canonical.js';
import { MAX_ACTION_SUMMARY } from './payload-approval.js';
import type { PayloadApprovalConsumption, PayloadApprovalGrant, PayloadApprovalStore } from './payload-approval.js';
import { reconcileDispatch, type ReconcileOutcome, type ReconcileRequest } from './reconciliation.js';
import type {
  AdapterInvokeResult,
  DispatchContext,
  DispatchEvidence,
  DispatchLedger,
  ExternalEffectState,
  ExternalToolAdapter,
  ApprovalMode,
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
  | {
      /** Payload mode: no valid, unused approval of this exact action exists for this dispatch. Nothing was claimed or dispatched. */
      readonly kind: 'payload_approval_required';
      readonly dispatched: false;
      readonly actionDigest: string;
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
  /**
   * Required when ANY configured adapter declares `approvalMode: 'payload'` (construction throws otherwise). Must be durable unless
   * `unsafeAllowVolatileLedger` (tests/local only).
   */
  readonly payloadApprovals?: PayloadApprovalStore;
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
  private readonly payloadApprovals: PayloadApprovalStore | undefined;

  constructor(options: ExternalToolDispatcherOptions) {
    if (options.ledger.durability !== 'durable' && options.unsafeAllowVolatileLedger !== true) {
      throw new Error(
        'ExternalToolDispatcher requires a durable DispatchLedger (e.g. BlobDispatchLedger over a persistent AtomicBlobStore); a volatile or unlabelled ledger may only be used with an explicit unsafeAllowVolatileLedger opt-in (tests/local only)',
      );
    }
    this.adapters = new Map(options.adapters);
    this.payloadApprovals = options.payloadApprovals;
    let needsPayloadStore = false;
    for (const [capabilityId, adapter] of this.adapters) {
      // The approval mode is REQUIRED and has no default: a missing or unknown value is a configuration error, never "definition".
      if ((adapter.approvalMode as unknown) !== 'definition' && (adapter.approvalMode as unknown) !== 'payload') {
        throw new Error(
          `adapter "${adapter.id}" for "${capabilityId}" must declare approvalMode 'definition' or 'payload'; none was valid`,
        );
      }
      if (adapter.approvalMode === 'payload') needsPayloadStore = true;
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
    if (needsPayloadStore) {
      const store = options.payloadApprovals;
      if (store === undefined) throw new Error('an adapter declares approvalMode "payload" but no payloadApprovals store was configured');
      if (store.durability !== 'durable' && options.unsafeAllowVolatileLedger !== true) {
        throw new Error('payload approvals require a durable PayloadApprovalStore (or the explicit unsafeAllowVolatileLedger test opt-in)');
      }
    }
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

  /** The host-declared approval mode of a configured capability's adapter, or `undefined` when none is configured. */
  approvalModeFor(capabilityId: string): ApprovalMode | undefined {
    return this.adapters.get(capabilityId)?.approvalMode;
  }

  /**
   * The exact action `input` would dispatch, as identities plus the human-readable summary shown to a payload approver. Throws
   * `CanonicalizationError` for an input that cannot be canonicalized; `undefined` when no adapter is configured.
   */
  previewAction(
    capabilityId: string,
    input: unknown,
  ):
    | {
        readonly adapterId: string;
        readonly approvalMode: ApprovalMode;
        readonly inputFingerprint: string;
        readonly actionDigest: string;
        readonly actionSummary: string;
      }
    | undefined {
    const adapter = this.adapters.get(capabilityId);
    if (adapter === undefined) return undefined;
    const inputFingerprint = fingerprintOf(input);
    const actionDigest = actionDigestOf(capabilityId, adapter, inputFingerprint);
    return {
      adapterId: adapter.id,
      approvalMode: adapter.approvalMode,
      inputFingerprint,
      actionDigest,
      actionSummary: summaryFor(adapter, capabilityId, input, actionDigest),
    };
  }

  /**
   * Records a human's payload approval for ONE dispatch key. The caller (the API) has already authenticated the human and checked the
   * dedicated permission. Refused unless: the capability is payload-mode; the approver supplied the digest AND the summary the server
   * computed for the actual input (so they approved what was shown); and the key has no dispatch evidence yet (an approval can never
   * unblock, re-open or follow an existing dispatch). Never dispatches.
   */
  async grantPayloadApproval(request: {
    readonly dispatchKey: string;
    readonly capabilityId: string;
    readonly input: unknown;
    readonly expectedActionDigest: string;
    readonly expectedActionSummary: string;
    readonly approver: { readonly kind: 'human'; readonly id: string };
    readonly auditCorrelationId?: string;
  }): Promise<
    | { readonly kind: 'granted'; readonly grant: PayloadApprovalGrant }
    | {
        readonly kind: 'refused';
        readonly reason:
          | 'not_configured'
          | 'not_payload_mode'
          | 'invalid_request'
          | 'digest_mismatch'
          | 'summary_mismatch'
          | 'already_dispatched'
          | 'store_unavailable';
        readonly message: string;
      }
  > {
    const adapter = this.adapters.get(request.capabilityId);
    if (adapter === undefined)
      return { kind: 'refused', reason: 'not_configured', message: 'no adapter is configured for this capability' };
    if (adapter.approvalMode !== 'payload' || this.payloadApprovals === undefined) {
      return { kind: 'refused', reason: 'not_payload_mode', message: 'this adapter does not use payload-level approval' };
    }
    if (typeof request.dispatchKey !== 'string' || request.dispatchKey.length === 0) {
      return { kind: 'refused', reason: 'invalid_request', message: 'a dispatch key is required' };
    }
    let preview: ReturnType<ExternalToolDispatcher['previewAction']>;
    try {
      preview = this.previewAction(request.capabilityId, request.input);
    } catch {
      return { kind: 'refused', reason: 'invalid_request', message: 'the input cannot be canonicalized' };
    }
    if (preview === undefined)
      return { kind: 'refused', reason: 'not_configured', message: 'no adapter is configured for this capability' };
    if (request.expectedActionDigest !== preview.actionDigest) {
      return {
        kind: 'refused',
        reason: 'digest_mismatch',
        message: 'the supplied digest is not the digest of the actual input; nothing was approved',
      };
    }
    if (request.expectedActionSummary !== preview.actionSummary) {
      return {
        kind: 'refused',
        reason: 'summary_mismatch',
        message: 'the supplied action summary is not the one shown for the actual input; nothing was approved',
      };
    }
    try {
      if ((await this.ledger.read(request.dispatchKey)).length > 0) {
        return {
          kind: 'refused',
          reason: 'already_dispatched',
          message: 'this dispatch already has evidence; an approval cannot change or follow it',
        };
      }
      const grant = await this.payloadApprovals.grant({
        dispatchKey: request.dispatchKey,
        capabilityId: request.capabilityId,
        adapterId: adapter.id,
        actionDigest: preview.actionDigest,
        actionSummary: preview.actionSummary,
        approver: request.approver,
        ...(request.auditCorrelationId !== undefined ? { auditCorrelationId: request.auditCorrelationId } : {}),
      });
      return { kind: 'granted', grant };
    } catch (cause) {
      return { kind: 'refused', reason: 'store_unavailable', message: `the approval could not be recorded: ${describe(cause)}` };
    }
  }

  /** Grants for one dispatch key with their use (read-only). Throws if the store is unreadable or corrupt. */
  async payloadApprovalsFor(
    dispatchKey: string,
  ): Promise<readonly { readonly grant: PayloadApprovalGrant; readonly consumption: PayloadApprovalConsumption | undefined }[]> {
    const store = this.payloadApprovals;
    if (store === undefined) return [];
    const out = [];
    for (const grant of await store.grantsFor(dispatchKey)) out.push({ grant, consumption: await store.consumptionOf(grant.approvalId) });
    return out;
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
    let floor: { readonly previousKey: string; readonly settledAt: number | undefined } | undefined;
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
        if (!supersededBySuccess) floor = { previousKey: newestNoEffect.dispatchKey, settledAt: noEffectAt };
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

    const actionDigest = actionDigestOf(capabilityId, adapter, inputFingerprint);

    // Freshness needs two unambiguous instants on ONE clock: the settlement (ledger clock) and the approval (approval/grant clock). Both
    // must parse strictly, neither may lie in the future of this host's clock (a skewed or forged stamp could make a stale approval look
    // fresh forever, or a settlement look old), and the approval must be strictly later. Otherwise: refuse.
    const isFresh = (approvedAtText: string | undefined): boolean => {
      if (floor === undefined) return true;
      const approvedAt = parseInstant(approvedAtText);
      const nowMs = this.now().getTime();
      return (
        floor.settledAt !== undefined &&
        approvedAt !== undefined &&
        floor.settledAt <= nowMs &&
        approvedAt <= nowMs &&
        approvedAt > floor.settledAt
      );
    };

    // PAYLOAD MODE (host-declared, never downgraded): dispatch needs a human approval of THIS exact action for THIS dispatch key — same
    // canonical digest (so any input/config change invalidates it), unused, and (after a no-effect failure) granted after that settlement.
    // It is checked only AFTER the key/capability blocks above, so an approval can never unblock an ambiguous or settled outcome. The
    // approval is consumed atomically in the authoritative store BEFORE the claim; a consumed-but-unclaimed approval is spent (fail closed).
    let effectiveApprovedAt = context.approvedAt;
    let payloadApprovalId: string | undefined;
    if (adapter.approvalMode === 'payload') {
      const store = this.payloadApprovals;
      if (store === undefined) {
        return { kind: 'payload_approval_required', dispatched: false, actionDigest, reason: 'no payload approval store is configured' };
      }
      try {
        const grants = await store.grantsFor(dispatchKey);
        let chosen: PayloadApprovalGrant | undefined;
        let sawDigest = false;
        let sawUnused = false;
        for (const g of grants.slice().reverse()) {
          if (g.actionDigest !== actionDigest || g.capabilityId !== capabilityId || g.adapterId !== adapter.id) continue;
          sawDigest = true;
          if ((await store.consumptionOf(g.approvalId)) !== undefined) continue;
          sawUnused = true;
          if (!isFresh(g.grantedAt)) continue;
          chosen = g;
          break;
        }
        if (chosen === undefined) {
          const why = !sawDigest
            ? grants.length === 0
              ? 'no payload approval exists for this dispatch'
              : 'no payload approval matches this exact action (the input or adapter configuration differs from what was approved)'
            : !sawUnused
              ? 'the matching payload approval has already been used'
              : 'the matching payload approval predates the last confirmed no-effect failure; a newer approval is required';
          return { kind: 'payload_approval_required', dispatched: false, actionDigest, reason: why };
        }
        const used = await store.consume(chosen.approvalId, dispatchKey);
        if (!used.consumed) {
          return {
            kind: 'payload_approval_required',
            dispatched: false,
            actionDigest,
            reason: 'the payload approval was consumed by another caller',
          };
        }
        effectiveApprovedAt = chosen.grantedAt;
        payloadApprovalId = chosen.approvalId;
      } catch (cause) {
        return {
          kind: 'ledger_unavailable',
          dispatched: false,
          reason: `payload approval store unavailable, so nothing was dispatched: ${describe(cause)}`,
        };
      }
    }
    if (floor !== undefined) {
      if (!isFresh(effectiveApprovedAt)) {
        return {
          kind: 'fresh_approval_required',
          dispatched: false,
          previousDispatchKey: floor.previousKey,
          reason: `capability "${capabilityId}" last settled as confirmed_failure_no_effect (${floor.previousKey}); a new attempt requires a human approval granted after that settlement`,
        };
      }
      follows = { dispatchKey: floor.previousKey, outcome: 'confirmed_failure_no_effect' };
    }

    // Write-ahead evidence. With an atomic `claim` exactly one concurrent caller wins the key; a loser has NOT dispatched and is blocked.
    const attempted = {
      dispatchKey,
      capabilityId,
      adapterId: adapter.id,
      state: 'dispatch_attempted' as const,
      inputFingerprint,
      actionDigest,
      approvalMode: adapter.approvalMode,
      ...(payloadApprovalId !== undefined ? { payloadApprovalId } : {}),
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
  return sha256Hex(
    canonicalJson({
      schema: 'xo.adapter-config.v1',
      adapterId: adapter.id,
      config: adapter.securityConfig ?? {},
      approvalMode: adapter.approvalMode,
    }),
  );
}

/** The exact action a dispatch key is claimed for: capability + adapter identity/config + input identity. No values are included. */
export function actionDigestOf(capabilityId: string, adapter: ExternalToolAdapter, inputFingerprint: string): string {
  return sha256Hex(
    canonicalJson({ schema: 'xo.external-action.v1', capabilityId, config: adapterConfigDigest(adapter), inputFingerprint }),
  );
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Adapter-provided summary when valid, otherwise a generic, value-free one. A throwing/oversized/odd summarizer never blocks approval. */
function summaryFor(adapter: ExternalToolAdapter, capabilityId: string, input: unknown, actionDigest: string): string {
  try {
    const text = adapter.summarize?.(Object.freeze({ ...(input as Record<string, unknown>) }));
    if (typeof text === 'string') {
      const t = text.trim();
      if (t.length > 0 && t.length <= MAX_ACTION_SUMMARY && !CONTROL.test(t)) return t;
    }
  } catch {
    /* fall through to the generic summary */
  }
  return `External action via adapter "${adapter.id}" for capability "${capabilityId}" (action digest ${actionDigest.slice(0, 12)})`;
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
