/**
 * M4 adapter contract.
 *
 * EFFECT STATES. The owner-approved effect model (O-3) names six states:
 * intent_recorded, dispatch_attempted, confirmed_success,
 * confirmed_failure_no_effect, outcome_unknown, reconciliation_required.
 * Their exact definitions (Review §5.3) are NOT available in this repository,
 * so this package does not define transitions between them and implements no
 * recovery. It only uses the state NAMES a single dispatch can honestly end in:
 *   - `dispatch_attempted`  — written to the ledger BEFORE the adapter is called;
 *   - `confirmed_success`, `confirmed_failure_no_effect`, `outcome_unknown` —
 *     the adapter's reported terminal result.
 * Anything not positively reported as confirmed is `outcome_unknown`.
 */

/** Terminal states a dispatch can produce (names from the approved O-3 model). */
export type ExternalEffectState = 'confirmed_success' | 'confirmed_failure_no_effect' | 'outcome_unknown';

/** Every state this package writes to the evidence ledger. */
export type LedgerEffectState = 'dispatch_attempted' | ExternalEffectState;

export interface AdapterInvokeRequest {
  readonly capabilityId: string;
  /** Server-derived identity of THIS dispatch (never client-supplied). One dispatch per key, ever. */
  readonly dispatchKey: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type AdapterInvokeResult =
  | { readonly kind: 'confirmed_success'; readonly output: unknown }
  | { readonly kind: 'confirmed_failure_no_effect'; readonly code: string; readonly message: string }
  | { readonly kind: 'outcome_unknown'; readonly reason: string };

/**
 * An external system adapter. It MUST report `confirmed_failure_no_effect` only
 * when it positively knows the external system made no change; every other
 * failure or ambiguity (timeouts, dropped connections, malformed replies) is
 * `outcome_unknown`, or a throw/rejection, which the dispatcher maps to it.
 */
export interface ExternalToolAdapter {
  readonly id: string;
  /**
   * Every security-relevant, NON-SECRET configuration value of this adapter (endpoint/host, account or tenant id, region, scopes, mode…),
   * as plain JSON. It is hashed (canonically) into the approval digest, so changing any value makes an earlier approval stale. NEVER put a
   * secret here: represent a credential by a non-reversible identifier the adapter computes itself (key id, or a hash of the secret).
   * Absent means "no security-relevant configuration" — an adapter with such configuration that omits it is NOT covered by approval
   * binding. A value that cannot be canonicalized fails dispatcher construction (fail closed).
   */
  readonly securityConfig?: Readonly<Record<string, unknown>>;
  invoke(request: AdapterInvokeRequest): Promise<AdapterInvokeResult>;
}

export type MaybePromise<T> = T | Promise<T>;

/** Decisions a reconciliation can record. `unresolved` records that someone looked and could not establish the outcome; it settles nothing. */
export type ReconciliationDecision = 'confirmed_success' | 'confirmed_failure_no_effect' | 'unresolved';

/**
 * Who reconciled, why, and what they examined. Written verbatim into the (append-only) evidence entry, so the actor, reason and
 * evidence examined are retained with the decision. The ACTOR is minted by the host from an authenticated principal — never from
 * client input — and the adapter package does not decide who is allowed to reconcile (the host/API does, before calling).
 */
export interface ReconciliationRecord {
  readonly actorKind: 'human' | 'service' | 'system';
  readonly actorId: string;
  readonly decision: ReconciliationDecision;
  readonly reason: string;
  readonly evidenceExamined: string;
  /**
   * Correlation id of the AUDIT event(s) written for this reconciliation attempt (the same `correlationId` as the audit trail's
   * `procedure.attempted` event for it). A reference only: the ledger and the audit trail are separate stores and are NOT written
   * atomically together.
   */
  readonly auditCorrelationId?: string;
}

export interface DispatchEvidence {
  readonly seq: number;
  readonly dispatchKey: string;
  readonly capabilityId: string;
  readonly adapterId: string;
  /** The EFFECTIVE state after this entry. For a reconciliation entry: the decision, or (for `unresolved`) the unchanged prior state. */
  readonly state: LedgerEffectState;
  readonly detail?: string;
  /** Server clock at the moment the ledger accepted the entry. Set by the ledger; a caller-supplied value is ignored. */
  readonly recordedAt?: string;
  /** SHA-256 over the canonical JSON of the dispatched input. Identity only: the input itself is NEVER written to the ledger. */
  readonly inputFingerprint?: string;
  /** Present only on entries written by a reconciliation. */
  readonly reconciliation?: ReconciliationRecord;
  /**
   * SHA-256 over canonical {capabilityId, adapterId, adapter security-config digest, input fingerprint}: the exact action this key was
   * claimed for. Identity only (no input, no config values). Set on the `dispatch_attempted` entry.
   */
  readonly actionDigest?: string;
  /** Correlation id of the procedure-execution audit events for the run that made this dispatch (set on dispatch entries). */
  readonly auditCorrelationId?: string;
  /**
   * Present only on a `dispatch_attempted` entry that is a NEW ATTEMPT after an earlier dispatch to the same capability settled as
   * `confirmed_failure_no_effect`: names that earlier dispatch and its confirmed outcome. A reference for audit/recovery, not a link
   * that reopens anything — the earlier key stays settled and is never redispatched.
   */
  readonly follows?: { readonly dispatchKey: string; readonly outcome: 'confirmed_failure_no_effect' };
}

/**
 * What the host knows about THIS dispatch that the adapter and the ledger cannot: when the human approval in force was granted.
 * Used for the fresh-approval rule (see {@link ExternalToolDispatcher}).
 */
export interface DispatchContext {
  /** ISO-8601 time the approval authorizing this dispatch was granted. Absent => freshness cannot be established. */
  readonly approvedAt?: string;
  /** Correlation id of the audit trail for this execution; recorded on the dispatch evidence so ledger and audit can be joined. */
  readonly auditCorrelationId?: string;
}

export type LedgerEntryDraft = Omit<DispatchEvidence, 'seq' | 'recordedAt'>;

/**
 * Retained evidence of dispatch attempts. Methods may be synchronous (in-memory) or asynchronous (durable); a failed or unconfirmed
 * write must throw/reject, and a failed write before dispatch means NO dispatch.
 */
export interface DispatchLedger {
  /**
   * What the ledger promises about surviving a restart. `'durable'` is a promise the ledger's backing store keeps across process
   * restarts; `'volatile'` (or ABSENT) means evidence can be lost. Absent is treated as volatile (fail closed): a dispatcher refuses to be
   * built over a non-durable ledger unless the host explicitly opts in (`unsafeAllowVolatileLedger`), and a production server refuses
   * a volatile ledger even then.
   */
  readonly durability?: 'durable' | 'volatile';
  read(dispatchKey: string): MaybePromise<readonly DispatchEvidence[]>;
  /** Every entry for one capability. Used to refuse a new dispatch while an earlier one is unreconciled. */
  readByCapability(capabilityId: string): MaybePromise<readonly DispatchEvidence[]>;
  append(entry: LedgerEntryDraft): MaybePromise<void>;
  /**
   * ATOMIC claim of a dispatch key: records the FIRST entry for the key if, and only if, no entry exists for it (one winner among any
   * number of concurrent callers, including other processes sharing the same durable store). `claimed: false` => another caller
   * already holds the key and nothing was written. Optional only for legacy single-process ledgers; the dispatcher falls back to
   * read-then-append, which is NOT concurrency-safe, when it is absent.
   */
  claim?(entry: LedgerEntryDraft): MaybePromise<{ readonly claimed: boolean }>;
  /**
   * Append iff the key's last entry still has sequence `expectedLastSeq` (compare-and-append). `appended: false` => the evidence moved
   * since it was read (e.g. a concurrent reconciliation); nothing was written and the caller must re-read. Required for reconciliation.
   */
  appendAfter?(dispatchKey: string, expectedLastSeq: number, entry: LedgerEntryDraft): MaybePromise<{ readonly appended: boolean }>;
}

/**
 * Volatile, single-process ledger for tests and local development ONLY. Its evidence does not survive a restart, so it must never
 * back a host that can dispatch consequential effects (use a durable ledger such as {@link BlobDispatchLedger}).
 */
export class InMemoryDispatchLedger implements DispatchLedger {
  readonly durability = 'volatile' as const;
  private readonly entries: DispatchEvidence[] = [];
  read(dispatchKey: string): readonly DispatchEvidence[] {
    return this.entries.filter((e) => e.dispatchKey === dispatchKey);
  }
  readByCapability(capabilityId: string): readonly DispatchEvidence[] {
    return this.entries.filter((e) => e.capabilityId === capabilityId);
  }
  append(entry: LedgerEntryDraft): void {
    this.entries.push(Object.freeze({ ...entry, seq: this.entries.length + 1, recordedAt: new Date().toISOString() }));
  }
  claim(entry: LedgerEntryDraft): { readonly claimed: boolean } {
    if (this.entries.some((e) => e.dispatchKey === entry.dispatchKey)) return { claimed: false };
    this.append(entry);
    return { claimed: true };
  }
  appendAfter(dispatchKey: string, expectedLastSeq: number, entry: LedgerEntryDraft): { readonly appended: boolean } {
    const own = this.entries.filter((e) => e.dispatchKey === dispatchKey);
    const last = own[own.length - 1];
    if (last === undefined || last.seq !== expectedLastSeq) return { appended: false };
    this.append(entry);
    return { appended: true };
  }
  all(): readonly DispatchEvidence[] {
    return [...this.entries];
  }
}
