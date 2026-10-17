import { createHash } from 'node:crypto';
import {
  ChainedAuditStore,
  actorFromPrincipal,
  type AuditEvent,
  type AuditEventDraft,
  type AuditExtensionSchema,
  type FileOps,
} from '@xo/audit';
import { ErrorCode, type AuditError as PlatformAuditError } from '@xo/errors';
import { isAuthenticatedPrincipal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuditTrust } from './audit.js';
import type { ConnectorContext, DetectedSource } from './connector.js';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from './errors.js';
import type { Evidence } from './evidence.js';
import { EvidenceLedger, type EvidenceState } from './evidence-ledger.js';
import { ConnectorId, EvidenceId, SourceId } from './ids.js';
import type { EnvironmentInventory, SourceRecord } from './inventory.js';
import { summarize, type SourceAxes } from './source-state.js';

/**
 * C0.4 — the EI STATE JOURNAL: durable EI lifecycle state (ledger entries + inventory source state).
 *
 * It is a SEPARATE `ChainedAuditStore` instance (its own directory, its own `x-ei-state` closed extension) that reuses the C0.3
 * mechanics: hash chain, single-writer lock, fsync-confirmed writes, indeterminate-write poisoning, torn-tail recording,
 * verify-on-open, authenticated-principal actor, closed schema + global secret filter, single-use read grants.
 *
 * AUTHORITY SPLIT: the audit chain is authoritative for what happened and who did it; THIS journal is authoritative only
 * for CURRENT LIFECYCLE STATE. There is NO atomicity across the two stores: ordering + restart reconciliation keep every
 * crash window at a state that is never more permissive than the last confirmed fact. See
 * docs/environment-intelligence/c0-4-state-journal.md for the full crash matrix.
 *
 * NEVER persisted: locators, display names, error messages/contexts, transition history, evidence payloads or provenance.
 */
export const EI_STATE_NAMESPACE = 'x-ei-state';

const AXES_FIELDS = {
  connectorAvailability: { kind: 'enum', values: ['unknown', 'supported', 'unsupported'] },
  connection: { kind: 'enum', values: ['not_planned', 'required', 'configured', 'validated', 'failed'] },
  // NB: the global key filter forbids the word "authorization" in a field name, so the axis is persisted as `authz`.
  authz: { kind: 'enum', values: ['not_requested', 'required', 'granted', 'denied', 'revoked'] },
  acquisition: { kind: 'enum', values: ['not_attempted', 'succeeded', 'partial', 'failed'] },
  unavailable: { kind: 'bool' },
} as const;

export const EI_STATE_EXTENSION_SCHEMA: AuditExtensionSchema = {
  namespace: EI_STATE_NAMESPACE,
  fields: {
    rec: { kind: 'enum', values: ['release', 'quarantine', 'intent', 'transition', 'source'] },
    operationId: { kind: 'id', optional: true },
    sourceId: { kind: 'id', optional: true },
    ids: { kind: 'list', max: 5000, of: { kind: 'id' }, optional: true },
    kind: { kind: 'enum', values: ['revoke', 'purge', 'revoked', 'purged'], optional: true },
    // Diagnostic / cross-reference values that may legitimately differ between a first attempt and an idempotent retry.
    count: { kind: 'count', optional: true, volatile: true },
    recovered: { kind: 'bool', optional: true, volatile: true },
    auditEventId: { kind: 'id', optional: true, volatile: true },
    rev: { kind: 'count', optional: true },
    src: {
      kind: 'object',
      optional: true,
      fields: {
        sourceType: { kind: 'id', maxLength: 60 },
        detectedBy: { kind: 'id', maxLength: 80 },
        connectorId: { kind: 'id', maxLength: 80, optional: true },
        detectedAt: { kind: 'isoTime' },
        firstSeenAt: { kind: 'isoTime' },
        lastSeenAt: { kind: 'isoTime' },
        fingerprint: { kind: 'opaque', pattern: /^[0-9a-f]{64}$/, maxLength: 64 },
        lastScanFingerprint: { kind: 'opaque', pattern: /^[0-9a-f]{64}$/, maxLength: 64, optional: true },
        observationCount: { kind: 'count' },
        scanCount: { kind: 'count' },
        changedSinceLastScan: { kind: 'bool' },
        purgeRequired: { kind: 'bool' },
        lastErrorCode: { kind: 'id', maxLength: 60, optional: true },
        lastErrorRetryable: { kind: 'bool', optional: true },
        axes: { kind: 'object', fields: AXES_FIELDS },
      },
    },
  },
};

// ── errors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StateOutcome =
  'rejected' | 'indeterminate' | 'unavailable' | 'corrupt' | 'locked' | 'denied' | 'config' | 'not_operational' | 'disagreement';

function stateError(phase: string, outcome: StateOutcome): DiscoveryError {
  return discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'the durable lifecycle state could not be persisted or verified', {
    phase,
    outcome,
  });
}

function outcomeOf(e: PlatformAuditError): StateOutcome {
  switch (e.code) {
    case ErrorCode.AUDIT_CORRUPT:
      return 'corrupt';
    case ErrorCode.AUDIT_LOCKED:
      return 'locked';
    case ErrorCode.AUDIT_CONFIG_INVALID:
      return 'config';
    case ErrorCode.AUDIT_ACCESS_DENIED:
      return 'denied';
    case ErrorCode.AUDIT_EVENT_INVALID:
    case ErrorCode.AUDIT_CONFLICT:
    case ErrorCode.AUDIT_ORDER_VIOLATION:
      return 'rejected';
    default:
      return 'unavailable';
  }
}

// ── records ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SourceSnapshot {
  readonly sourceType: string;
  readonly detectedBy: string;
  readonly connectorId?: string;
  readonly detectedAt: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly fingerprint: string;
  readonly lastScanFingerprint?: string;
  readonly observationCount: number;
  readonly scanCount: number;
  readonly changedSinceLastScan: boolean;
  readonly purgeRequired: boolean;
  readonly lastErrorCode?: string;
  readonly lastErrorRetryable?: boolean;
  readonly axes: {
    readonly connectorAvailability: string;
    readonly connection: string;
    readonly authz: string;
    readonly acquisition: string;
    readonly unavailable: boolean;
  };
}

type StateRecord =
  | { rec: 'release' | 'quarantine'; operationId: string; sourceId: string; ids: string[]; auditEventId?: string; key: string }
  | { rec: 'intent'; operationId: string; sourceId: string; kind: 'revoke' | 'purge'; auditEventId?: string; key: string }
  | {
      rec: 'transition';
      operationId: string;
      sourceId: string;
      kind: 'revoked' | 'purged';
      count: number;
      recovered?: boolean;
      key: string;
    }
  | { rec: 'source'; sourceId: string; rev: number; src: SourceSnapshot; key: string };

const TYPE_OF: Readonly<Record<string, readonly [AuditEventDraft['type'], AuditEventDraft['outcome']]>> = {
  release: ['environment.completed', 'completed'],
  quarantine: ['environment.quarantined', 'quarantined'],
  intent: ['environment.attempted', 'attempted'],
  revoked: ['environment.revoked', 'revoked'],
  purged: ['environment.purged', 'purged'],
  source: ['environment.completed', 'completed'],
};

function draftFor(actor: AuditEventDraft['actor'], r: StateRecord): AuditEventDraft {
  const [type, outcome] = TYPE_OF[r.rec === 'transition' ? r.kind : r.rec] as readonly [
    AuditEventDraft['type'],
    AuditEventDraft['outcome'],
  ];
  const ext: Record<string, unknown> = { rec: r.rec, sourceId: r.sourceId };
  if (r.rec !== 'source') ext['operationId'] = r.operationId;
  if (r.rec === 'release' || r.rec === 'quarantine') ext['ids'] = r.ids;
  if (r.rec === 'intent' || r.rec === 'transition') ext['kind'] = r.kind;
  if (r.rec === 'transition') {
    ext['count'] = r.count;
    if (r.recovered === true) ext['recovered'] = true;
  }
  if ((r.rec === 'release' || r.rec === 'quarantine' || r.rec === 'intent') && r.auditEventId !== undefined)
    ext['auditEventId'] = r.auditEventId;
  if (r.rec === 'source') {
    ext['rev'] = r.rev;
    ext['src'] = r.src;
  }
  return {
    type,
    action: `ei-state.${r.rec}`,
    outcome,
    actor,
    correlationId: r.rec === 'source' ? r.sourceId : r.operationId,
    idempotencyKey: r.key,
    extensions: { [EI_STATE_NAMESPACE]: ext },
  };
}

// ── source snapshots ──────────────────────────────────────────────────────────────────────────────────────────────────

function snapshotOf(r: SourceRecord): SourceSnapshot {
  return {
    sourceType: r.source.sourceType,
    detectedBy: r.source.detectedBy,
    ...(r.connectorId !== undefined ? { connectorId: r.connectorId } : {}),
    detectedAt: r.source.detectedAt,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    fingerprint: r.source.fingerprint,
    ...(r.lastScanFingerprint !== undefined ? { lastScanFingerprint: r.lastScanFingerprint } : {}),
    observationCount: r.observationCount,
    scanCount: r.scanCount,
    changedSinceLastScan: r.changedSinceLastScan,
    purgeRequired: r.purgeRequired,
    // Only the CODE and the retryable flag of the last error: never its message or context.
    ...(r.lastError !== undefined ? { lastErrorCode: r.lastError.code, lastErrorRetryable: r.lastError.retryable } : {}),
    axes: {
      connectorAvailability: r.axes.connectorAvailability,
      connection: r.axes.connection,
      authz: r.axes.authorization,
      acquisition: r.axes.acquisition,
      unavailable: r.axes.unavailable,
    },
  };
}

function recordOf(sourceId: string, s: SourceSnapshot): SourceRecord {
  const axes: SourceAxes = {
    connectorAvailability: s.axes.connectorAvailability as SourceAxes['connectorAvailability'],
    connection: s.axes.connection as SourceAxes['connection'],
    authorization: s.axes.authz as SourceAxes['authorization'],
    acquisition: s.axes.acquisition as SourceAxes['acquisition'],
    unavailable: s.axes.unavailable,
  };
  // locator and displayName are NOT persisted; they are empty until the next detection re-observes the source.
  const source = {
    sourceId: SourceId(sourceId),
    sourceType: s.sourceType,
    displayName: '',
    locator: '',
    detectedBy: ConnectorId(s.detectedBy),
    detectedAt: s.detectedAt,
    fingerprint: s.fingerprint,
  } as unknown as DetectedSource;
  return Object.freeze({
    source,
    ...(s.connectorId !== undefined ? { connectorId: ConnectorId(s.connectorId) } : {}),
    axes,
    status: summarize(axes),
    firstSeenAt: s.firstSeenAt,
    lastSeenAt: s.lastSeenAt,
    observationCount: s.observationCount,
    scanCount: s.scanCount,
    ...(s.lastScanFingerprint !== undefined ? { lastScanFingerprint: s.lastScanFingerprint } : {}),
    changedSinceLastScan: s.changedSinceLastScan,
    purgeRequired: s.purgeRequired,
    ...(s.lastErrorCode !== undefined
      ? {
          lastError: {
            code: s.lastErrorCode as DiscoveryError['code'],
            message: '',
            retryable: s.lastErrorRetryable === true,
            context: {},
          },
        }
      : {}),
    history: Object.freeze([]),
  }) as SourceRecord;
}

const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const digestOf = (s: SourceSnapshot): string => createHash('sha256').update(sortedJson(s)).digest('hex');

// ── fold (load) ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StateOperation {
  readonly operationId: string;
  readonly rec: 'release' | 'quarantine' | 'intent' | 'transition';
  readonly kind?: 'revoke' | 'purge' | 'revoked' | 'purged';
  readonly count: number;
  readonly auditEventId?: string;
}

interface IntentState {
  readonly kind: 'revoke' | 'purge';
  readonly sourceId: string;
  revoked: boolean;
  purged: boolean;
}

interface Folded {
  readonly ledger: EvidenceLedger;
  readonly sources: Map<string, { rev: number; snap: SourceSnapshot }>;
  readonly intents: Map<string, IntentState>;
  readonly operations: StateOperation[];
  /**
   * Sources whose last journaled lifecycle transition (revoked/purged) has NO later inventory snapshot, i.e. the snapshot write
   * following the transition was lost. The ledger already reflects the transition; recovery re-applies it to the inventory.
   * A later snapshot (for example a deliberate re-authorization) supersedes it, so recovery never undoes a later change.
   */
  readonly pending: Map<string, 'revoked' | 'purged'>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fold(events: readonly AuditEvent[]): Result<Folded, DiscoveryError> {
  const bad = (): Result<Folded, DiscoveryError> => err(stateError('load', 'corrupt'));
  const f: Folded = { ledger: new EvidenceLedger(), sources: new Map(), intents: new Map(), operations: [], pending: new Map() };
  const stub = (id: string, sourceId: string): Evidence => ({ id: EvidenceId(id), sourceId: SourceId(sourceId) }) as unknown as Evidence;
  for (const e of events) {
    const x = e.extensions?.[EI_STATE_NAMESPACE];
    if (!isObj(x) || typeof x['rec'] !== 'string' || e.action !== `ei-state.${x['rec']}`) return bad();
    const rec = x['rec'];
    const op = x['operationId'];
    const sid = x['sourceId'];
    if (typeof sid !== 'string') return bad();
    if (rec === 'source') {
      const src = x['src'];
      if (!isObj(src) || typeof x['rev'] !== 'number') return bad();
      const prior = f.sources.get(sid);
      if (prior !== undefined && x['rev'] <= prior.rev) return bad();
      f.sources.set(sid, { rev: x['rev'], snap: src as unknown as SourceSnapshot });
      f.pending.delete(sid);
      continue;
    }
    if (typeof op !== 'string') return bad();
    if (rec === 'release' || rec === 'quarantine') {
      const ids = x['ids'];
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) return bad();
      const evidence = (ids as string[]).map((i) => stub(i, sid));
      if (rec === 'release') f.ledger.release(op, evidence);
      else f.ledger.quarantine(op, evidence);
      f.operations.push({
        operationId: op,
        rec,
        count: ids.length,
        ...(typeof x['auditEventId'] === 'string' ? { auditEventId: x['auditEventId'] } : {}),
      });
    } else if (rec === 'intent') {
      const kind = x['kind'];
      if (kind !== 'revoke' && kind !== 'purge') return bad();
      if (!f.intents.has(op)) f.intents.set(op, { kind, sourceId: sid, revoked: false, purged: false });
      f.operations.push({ operationId: op, rec, kind, count: 0 });
    } else if (rec === 'transition') {
      const kind = x['kind'];
      if (kind !== 'revoked' && kind !== 'purged') return bad();
      const affected = kind === 'revoked' ? f.ledger.revokeSource(SourceId(sid), op) : f.ledger.purgeSource(SourceId(sid), op);
      f.pending.set(sid, kind);
      const intent = f.intents.get(op);
      if (intent !== undefined) {
        if (kind === 'revoked') intent.revoked = true;
        else {
          intent.revoked = true;
          intent.purged = true;
        }
      }
      f.operations.push({ operationId: op, rec, kind, count: affected.length });
    } else return bad();
  }
  return ok(f);
}

// ── store ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EiStateStoreOptions {
  readonly dir: string;
  readonly integrityKey?: Uint8Array;
  readonly clock?: () => Date;
  /** Fault-injection seam (platform `FileOps`). Production code passes nothing. */
  readonly ops?: FileOps;
}

export interface StateStartReport {
  readonly records: number;
  readonly events: number;
  readonly ledgerCounts: Readonly<Record<EvidenceState, number>>;
  readonly sources: number;
  /** Unresolved intents replayed as a REVOKE at startup (never as a purge). */
  readonly reconciledIntents: number;
  /** Sources whose journaled revoke/purge transition had no later inventory snapshot and was re-applied to the inventory. */
  readonly reconciledSources: number;
  /** Journal records in order (ids and kinds only) for `crossCheckState`. */
  readonly operations: readonly StateOperation[];
}

export interface StateDiagnostics {
  readonly status: 'unstarted' | 'starting' | 'operational' | 'poisoned' | 'corrupt' | 'failed' | 'closed';
  readonly records: number;
  readonly events: number;
  readonly headHash: string;
  readonly ledgerCounts: Readonly<Record<EvidenceState, number>>;
  /** Operation ids of revoke/purge intents that have not reached their terminal transition. */
  readonly openIntents: readonly string[];
  readonly recoveries: number;
  readonly lastLoad: 'none' | 'ok' | StateOutcome;
}

const SAFE_ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const CHUNK = 5000;

/**
 * THE ID CONTRACT. The same pattern EI's audit normalization uses (`SAFE_ID` in audit.ts) and the platform extension `id` kind:
 * `[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}`. EI NEVER normalizes or truncates such ids: a malformed one is REJECTED (hash-mapping via
 * `safeIdentifier` exists only for log-safe display fields, never for evidence, operation or source ids). Operation and source ids are
 * also bounded to 100 characters so every idempotency key (`<prefix>:<id>:<n>`) fits the platform's 128-character limit.
 */
const STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const MAX_KEY_ID = 100;
/** Longest operation/source id the journal can key (audit accepts up to 200; the journal's idempotency keys need headroom). */
export const STATE_ID_MAX_LENGTH = MAX_KEY_ID;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const validId = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max && STATE_ID.test(v);
function validEvidence(evidence: readonly Evidence[]): boolean {
  return Array.isArray(evidence) && evidence.every((e) => validId(e?.id) && validId(e?.sourceId, MAX_KEY_ID));
}

export class EiStateStore {
  private chain: Promise<unknown> = Promise.resolve();
  private status: StateDiagnostics['status'] = 'unstarted';
  private lastLoad: StateDiagnostics['lastLoad'] = 'none';
  private ledger: EvidenceLedger | undefined;
  private inventory: EnvironmentInventory | undefined;
  private readonly digests = new Map<string, string>();
  private readonly revs = new Map<string, number>();
  private readonly intents = new Map<string, IntentState>();

  private constructor(
    private readonly store: ChainedAuditStore,
    private readonly clock: () => Date,
  ) {}

  static async open(options: EiStateStoreOptions): Promise<Result<EiStateStore, DiscoveryError>> {
    const opened = await ChainedAuditStore.open({
      dir: options.dir,
      ...(options.integrityKey !== undefined ? { integrityKey: options.integrityKey } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.ops !== undefined ? { ops: options.ops } : {}),
      extensionSchemas: { [EI_STATE_NAMESPACE]: EI_STATE_EXTENSION_SCHEMA },
      // Header-only torn-journal recovery, provable under the crash model (see ChainedAuditStore `creationMarker`).
      creationMarker: true,
    });
    if (!opened.ok) return err(stateError('open', outcomeOf(opened.error)));
    return ok(new EiStateStore(opened.value, options.clock ?? (() => new Date())));
  }

  /** True only after a successful `start()` and until a persistence/integrity failure, an indeterminate write, or close. */
  get operational(): boolean {
    return this.status === 'operational';
  }

  /** The ledger this store is attached to (set by `start`). Protected operations require `ctx.ledger` to be this one. */
  get attachedLedger(): EvidenceLedger | undefined {
    return this.ledger;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private writable(): boolean {
    return this.status === 'operational' || this.status === 'starting';
  }

  /** The single write path: binds the TRUSTED principal, appends, and maps the outcome. */
  private async append(
    trust: AuditTrust,
    r: StateRecord,
    phase: string,
    opts: { poisonOnReject?: boolean } = {},
  ): Promise<Result<{ duplicate: boolean }, DiscoveryError>> {
    if (!this.writable()) return err(stateError(phase, 'not_operational'));
    const principal = trust?.principal;
    if (
      !isAuthenticatedPrincipal(principal) ||
      !SAFE_ACTOR_ID.test(principal.id) ||
      (principal.orgId !== undefined && !SAFE_ACTOR_ID.test(principal.orgId))
    )
      return err(stateError(phase, 'rejected'));
    let actor: AuditEventDraft['actor'];
    try {
      actor = actorFromPrincipal(principal);
    } catch {
      return err(stateError(phase, 'rejected'));
    }
    const result = await this.store.append(draftFor(actor, r));
    if (result.ok) return ok({ duplicate: result.duplicate });
    const outcome = result.indeterminate ? 'indeterminate' : outcomeOf(result.error);
    // Only a DEFINITE content rejection (nothing written) leaves the store operational. Anything else - unavailable storage,
    // integrity failure, an unconfirmed write - makes it non-operational: nothing is eligible until reopened and started.
    // The exception: when the caller ALREADY applied the change in memory (the safe direction), a rejection would leave memory
    // ahead of the journal while "operational", so it fails closed too.
    if (outcome !== 'rejected') this.status = outcome === 'corrupt' ? 'corrupt' : 'poisoned';
    else if (opts.poisonOnReject === true) this.status = 'poisoned';
    return err(stateError(phase, outcome));
  }

  // ── startup ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Loads and verifies the whole journal (needs a single-use `read` grant), restores the ledger and inventory, replays
   * unresolved revoke/purge intents as a REVOKE, installs the fail-closed eligibility gate, and only then becomes operational.
   */
  start(args: {
    grant: unknown;
    trust: AuditTrust;
    inventory: EnvironmentInventory;
    ledger: EvidenceLedger;
    /**
     * OPTIONAL audit-chain events (read by the caller with its own grant). When supplied, a DANGEROUS disagreement between the
     * journal and the audit chain makes the store refuse to become operational (`disagreement`): a release nobody audited, or an
     * audited revoke/purge the journal does not contain (a rolled-back journal). Benign crash windows are NOT blocked. When not
     * supplied no cross-check happens, and a journal rolled back to a valid earlier prefix cannot be detected (documented limit).
     */
    audit?: readonly AuditEvent[];
  }): Promise<Result<StateStartReport, DiscoveryError>> {
    return this.serialize(async () => {
      if (this.status !== 'unstarted') return err(stateError('start', 'not_operational'));
      const { inventory, ledger } = args;
      this.ledger = ledger;
      this.inventory = inventory;
      ledger.setEligibilityGate(() => this.operational); // closed until we are operational
      const fail = (outcome: StateOutcome): Result<StateStartReport, DiscoveryError> => {
        this.status = outcome === 'corrupt' ? 'corrupt' : 'failed';
        this.lastLoad = outcome;
        return err(stateError('start', outcome));
      };
      const read = await this.store.read(args.grant);
      if (!read.ok) return fail(outcomeOf(read.error));
      const folded = fold(read.value.events);
      if (!folded.ok) return fail('corrupt');
      const f = folded.value;
      if (args.audit !== undefined && crossCheckState(f.operations, args.audit).some((x) => DANGEROUS_FINDINGS.has(x.kind)))
        return fail('disagreement');
      ledger.restoreEntries(f.ledger.exportEntries());
      const records: SourceRecord[] = [];
      for (const [sid, { rev, snap }] of [...f.sources.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        records.push(recordOf(sid, snap));
        this.revs.set(sid, rev);
        this.digests.set(sid, digestOf(snap));
      }
      inventory.restoreRecords(records);
      for (const [op, i] of f.intents) this.intents.set(op, { ...i });

      this.status = 'starting';
      let reconciled = 0;
      const at = this.clock().toISOString();
      // A journaled ledger transition whose inventory snapshot was LOST (a failure between the two writes): re-apply it to the
      // inventory (the revoked authorization axis that acquisition checks, and the purge obligation) and make the correction durable.
      let reconciledSources = 0;
      for (const [sid, kind] of [...f.pending.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const id = SourceId(sid);
        if (inventory.get(id) === undefined) continue;
        inventory.apply(id, 'authorization_revoked', at);
        if (kind === 'purged') inventory.markPurged(id, at);
        reconciledSources += 1;
      }
      if (reconciledSources > 0) {
        const synced = await this.syncLocked(args.trust);
        if (!synced.ok) return fail('unavailable');
      }
      for (const [op, i] of [...this.intents.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (i.revoked) continue;
        // The revoke began (its intent is durable) but its transition is not: finish it in the SAFE direction.
        const sid = SourceId(i.sourceId);
        const affected = ledger.revokeSource(sid, op);
        inventory.apply(sid, 'authorization_revoked', at);
        const w = await this.append(
          args.trust,
          {
            rec: 'transition',
            operationId: op,
            sourceId: i.sourceId,
            kind: 'revoked',
            count: affected.length,
            recovered: true,
            key: `trn:${op}:revoked`,
          },
          'recover',
        );
        if (!w.ok) return fail('unavailable');
        i.revoked = true;
        reconciled += 1;
        const s = await this.syncLocked(args.trust);
        if (!s.ok) return fail('unavailable');
      }
      this.status = 'operational';
      this.lastLoad = 'ok';
      const cp = this.store.checkpoint();
      return ok({
        records: cp.records,
        events: cp.events,
        ledgerCounts: ledger.counts(),
        sources: records.length,
        reconciledIntents: reconciled,
        reconciledSources,
        operations: f.operations,
      });
    });
  }

  // ── ledger mutations (journal order == in-memory apply order, inside one serialized section) ─────────────────────────

  /**
   * Journals a release, THEN applies it to the ledger. The caller must already hold a CONFIRMED audit completion. On any journal
   * failure the evidence is withheld: quarantined in memory (the safe direction) and the error is returned.
   *
   * A DUPLICATE (an exact retry of a release the journal already holds) never re-applies anything: the ledger already reflects
   * everything that happened since. If any of that evidence is no longer `released` (revoked, purged, quarantined) the retry is
   * WITHHELD. A retry can therefore never turn revoked evidence back into eligible evidence.
   */
  release(
    trust: AuditTrust,
    operationId: string,
    evidence: readonly Evidence[],
    auditEventId?: string,
  ): Promise<Result<void, DiscoveryError>> {
    return this.serialize(async () => {
      // Validation FIRST: a malformed id changes nothing anywhere (not the journal, not the ledger).
      if (!validId(operationId, MAX_KEY_ID) || !validEvidence(evidence) || (auditEventId !== undefined && !validId(auditEventId)))
        return err(stateError('release', 'rejected'));
      const ledger = this.ledger;
      if (ledger === undefined || !this.operational) {
        ledger?.quarantine(operationId, evidence);
        return err(stateError('release', 'not_operational'));
      }
      const byId = new Map<string, Evidence>();
      const bySource = new Map<string, string[]>();
      for (const e of evidence) {
        byId.set(e.id as string, e);
        bySource.set(e.sourceId, [...(bySource.get(e.sourceId) ?? []), e.id as string]);
      }
      const fresh: Evidence[] = [];
      const already: string[] = [];
      let n = 0;
      let confirmed = 0;
      for (const [sourceId, ids] of [...bySource.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const sorted = [...new Set(ids)].sort();
        for (let i = 0; i < sorted.length; i += CHUNK) {
          const chunk = sorted.slice(i, i + CHUNK);
          const w = await this.append(
            trust,
            {
              rec: 'release',
              operationId,
              sourceId,
              ids: chunk,
              ...(auditEventId !== undefined ? { auditEventId } : {}),
              key: `rel:${operationId}:${n}`,
            },
            'release',
          );
          n += 1;
          if (!w.ok) {
            ledger.quarantine(operationId, evidence);
            // Some chunks may already be durable while memory withholds everything: fail closed rather than diverge.
            if (confirmed > 0 && this.status === 'operational') this.status = 'poisoned';
            return w;
          }
          confirmed += 1;
          for (const id of chunk) {
            if (w.value.duplicate) already.push(id);
            else fresh.push(byId.get(id) as Evidence);
          }
        }
      }
      const stale = already.filter((id) => ledger.stateOf(EvidenceId(id)) !== 'released');
      if (stale.length > 0) {
        // An exact retry of a release whose evidence has since been revoked/purged/quarantined: never re-release it.
        if (fresh.length > 0) {
          ledger.quarantine(operationId, fresh);
          this.status = 'poisoned'; // journal holds new chunks that memory withheld
        }
        return err(stateError('release', 'rejected'));
      }
      if (fresh.length > 0) ledger.release(operationId, fresh);
      return ok(undefined);
    });
  }

  /** Withholds evidence (memory FIRST — the safe direction), then journals it best-effort. Journaled COMPLETELY (chunked), never truncated. */
  quarantine(
    trust: AuditTrust,
    operationId: string,
    evidence: readonly Evidence[],
    auditEventId?: string,
  ): Promise<Result<void, DiscoveryError>> {
    return this.serialize(async () => {
      if (!validId(operationId, MAX_KEY_ID) || !validEvidence(evidence) || (auditEventId !== undefined && !validId(auditEventId)))
        return err(stateError('quarantine', 'rejected'));
      this.ledger?.quarantine(operationId, evidence);
      if (!this.operational || evidence.length === 0) return err(stateError('quarantine', 'not_operational'));
      const bySource = new Map<string, string[]>();
      for (const e of evidence) bySource.set(e.sourceId, [...(bySource.get(e.sourceId) ?? []), e.id as string]);
      let n = 0;
      for (const [sourceId, ids] of [...bySource.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const sorted = [...new Set(ids)].sort();
        for (let i = 0; i < sorted.length; i += CHUNK) {
          const w = await this.append(
            trust,
            {
              rec: 'quarantine',
              operationId,
              sourceId,
              ids: sorted.slice(i, i + CHUNK),
              ...(auditEventId !== undefined ? { auditEventId } : {}),
              key: `qua:${operationId}:${n}`,
            },
            'quarantine',
          );
          n += 1;
          if (!w.ok) return w;
        }
      }
      return ok(undefined);
    });
  }

  // ── revoke / purge ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Makes sure the inventory snapshot exists, then journals the write-ahead INTENT.
   *  - A DEFINITE rejection (nothing written; the store stays operational) changes NOTHING in memory: a rejected request must not
   *    be able to revoke anything.
   *  - If the store is (or becomes) non-operational, everything is already ineligible; the source is also revoked in memory as
   *    defence in depth.
   */
  beginLifecycle(
    trust: AuditTrust,
    args: { kind: 'revoke' | 'purge'; operationId: string; sourceId: SourceId; at?: string; auditEventId?: string },
  ): Promise<Result<void, DiscoveryError>> {
    return this.serialize(async () => {
      if (
        (args.kind !== 'revoke' && args.kind !== 'purge') ||
        !validId(args.operationId, MAX_KEY_ID) ||
        !validId(args.sourceId, MAX_KEY_ID) ||
        (args.at !== undefined && !ISO_TIME.test(args.at)) ||
        (args.auditEventId !== undefined && !validId(args.auditEventId))
      )
        return err(stateError('intent', 'rejected'));
      const at = args.at ?? this.clock().toISOString();
      const failed = (e: DiscoveryError): Result<void, DiscoveryError> => {
        if (!this.operational) {
          this.ledger?.revokeSource(args.sourceId, args.operationId);
          this.inventory?.apply(args.sourceId, 'authorization_revoked', at);
        }
        return err(e);
      };
      if (!this.operational) return failed(stateError('intent', 'not_operational'));
      const s = await this.syncLocked(trust);
      if (!s.ok) return failed(s.error);
      const w = await this.append(
        trust,
        {
          rec: 'intent',
          operationId: args.operationId,
          sourceId: args.sourceId,
          kind: args.kind,
          ...(args.auditEventId !== undefined ? { auditEventId: args.auditEventId } : {}),
          key: `int:${args.operationId}`,
        },
        'intent',
      );
      if (!w.ok) return failed(w.error);
      if (!this.intents.has(args.operationId))
        this.intents.set(args.operationId, { kind: args.kind, sourceId: args.sourceId, revoked: false, purged: false });
      return ok(undefined);
    });
  }

  /** Applies the revoke in memory FIRST (safe direction), then journals the transition and the inventory snapshot. */
  applyRevoke(
    trust: AuditTrust,
    args: { operationId: string; sourceId: SourceId; at: string },
  ): Promise<Result<{ ids: readonly string[] }, DiscoveryError>> {
    return this.serialize(async () => {
      if (!validId(args.operationId, MAX_KEY_ID) || !validId(args.sourceId, MAX_KEY_ID) || !ISO_TIME.test(args.at))
        return err(stateError('revoke', 'rejected'));
      const ledger = this.ledger;
      const inventory = this.inventory;
      if (ledger === undefined || inventory === undefined) return err(stateError('revoke', 'not_operational'));
      inventory.apply(args.sourceId, 'authorization_revoked', args.at);
      const ids = ledger.revokeSource(args.sourceId, args.operationId);
      if (!this.operational) return err(stateError('revoke', 'not_operational'));
      const w = await this.append(
        trust,
        {
          rec: 'transition',
          operationId: args.operationId,
          sourceId: args.sourceId,
          kind: 'revoked',
          count: ids.length,
          key: `trn:${args.operationId}:revoked`,
        },
        'revoke',
        { poisonOnReject: true },
      );
      if (!w.ok) return w;
      const intent = this.intents.get(args.operationId);
      if (intent !== undefined) intent.revoked = true;
      const s = await this.syncLocked(trust);
      if (!s.ok) return s;
      return ok({ ids });
    });
  }

  /** Applies the purge in memory, then journals `purged`. Call ONLY after every purge target resolved. */
  applyPurge(
    trust: AuditTrust,
    args: { operationId: string; sourceId: SourceId; at: string },
  ): Promise<Result<{ ids: readonly string[] }, DiscoveryError>> {
    return this.serialize(async () => {
      if (!validId(args.operationId, MAX_KEY_ID) || !validId(args.sourceId, MAX_KEY_ID) || !ISO_TIME.test(args.at))
        return err(stateError('purge', 'rejected'));
      const ledger = this.ledger;
      const inventory = this.inventory;
      if (ledger === undefined || inventory === undefined) return err(stateError('purge', 'not_operational'));
      const ids = ledger.purgeSource(args.sourceId, args.operationId);
      inventory.markPurged(args.sourceId, args.at);
      if (!this.operational) return err(stateError('purge', 'not_operational'));
      const w = await this.append(
        trust,
        {
          rec: 'transition',
          operationId: args.operationId,
          sourceId: args.sourceId,
          kind: 'purged',
          count: ids.length,
          key: `trn:${args.operationId}:purged`,
        },
        'purge',
        { poisonOnReject: true },
      );
      if (!w.ok) return w;
      const intent = this.intents.get(args.operationId);
      if (intent !== undefined) {
        intent.revoked = true;
        intent.purged = true;
      }
      const s = await this.syncLocked(trust);
      if (!s.ok) return s;
      return ok({ ids });
    });
  }

  // ── inventory ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Persists a snapshot for every source whose persisted form changed since it was last persisted. */
  syncInventory(trust: AuditTrust): Promise<Result<{ written: number }, DiscoveryError>> {
    return this.serialize(() => this.syncLocked(trust));
  }

  private async syncLocked(trust: AuditTrust): Promise<Result<{ written: number }, DiscoveryError>> {
    const inventory = this.inventory;
    if (inventory === undefined || !this.writable()) return err(stateError('inventory', 'not_operational'));
    let written = 0;
    for (const record of inventory.list()) {
      const sourceId = record.source.sourceId as string;
      const snap = snapshotOf(record);
      const digest = digestOf(snap);
      if (this.digests.get(sourceId) === digest) continue;
      const rev = (this.revs.get(sourceId) ?? 0) + 1;
      const w = await this.append(trust, { rec: 'source', sourceId, rev, src: snap, key: `src:${sourceId}:${rev}` }, 'inventory');
      if (!w.ok) return w;
      this.revs.set(sourceId, rev);
      this.digests.set(sourceId, digest);
      written += 1;
    }
    return ok({ written });
  }

  // ── observability ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Content-free: counts, a head hash, a status code, and ids of unresolved intents. No paths, payloads, evidence ids or messages. */
  diagnostics(): StateDiagnostics {
    const cp = this.store.checkpoint();
    return {
      status: this.status,
      records: cp.records,
      events: cp.events,
      headHash: cp.hash,
      ledgerCounts: this.ledger?.counts() ?? { released: 0, quarantined: 0, revoked: 0, purged: 0 },
      openIntents: [...this.intents.entries()]
        .filter(([, i]) => (i.kind === 'revoke' ? !i.revoked : !i.purged))
        .map(([op]) => op)
        .sort(),
      recoveries: this.store.recoveryCount,
      lastLoad: this.lastLoad,
    };
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      this.status = 'closed';
      await this.store.close();
    });
  }
}

/** True when `id` is a source/operation id the journal can key. Used to refuse unrepresentable ids BEFORE they enter any state. */
export function isStateRepresentableId(id: unknown): boolean {
  return validId(id, MAX_KEY_ID);
}

/** The fixed, bounded error for a request refused before any mutation (never echoes the offending value). */
export function rejectedForState(phase: string): DiscoveryError {
  return stateError(phase, 'rejected');
}

// ── guards used by the EI operations ──────────────────────────────────────────────────────────────────────────────────────

/** The trusted audit context of a connector context: the branded principal, or nothing. Never built from a snapshot. */
export function trustFromContext(ctx: Pick<ConnectorContext, 'principal'>): AuditTrust | undefined {
  return isAuthenticatedPrincipal(ctx.principal) ? { principal: ctx.principal } : undefined;
}

/**
 * Fail-closed precondition for protected operations. With no durable store configured it is a no-op (behaviour unchanged).
 * With one configured, the store must be operational AND attached to the ledger in this context.
 */
export function requireOperationalState(ctx: Pick<ConnectorContext, 'state' | 'ledger'>): Result<void, DiscoveryError> {
  const state = ctx.state;
  if (state === undefined) return ok(undefined);
  if (!state.operational) return err(stateError('guard', 'not_operational'));
  if (ctx.ledger === undefined || ctx.ledger !== state.attachedLedger) return err(stateError('guard', 'config'));
  return ok(undefined);
}

// ── cross-check against the audit chain ───────────────────────────────────────────────────────────────────────────────────

export interface CrossCheckFinding {
  readonly kind: 'audited_not_released' | 'released_without_audit' | 'applied_not_audited' | 'audited_not_applied';
  readonly operationId: string;
}

/**
 * Findings that mean the journal can be MORE PERMISSIVE than what the audit chain says happened (or grants eligibility nobody audited).
 * `start({ audit })` refuses to become operational on any of these. The others are the benign, documented crash windows.
 */
export const DANGEROUS_FINDINGS: ReadonlySet<CrossCheckFinding['kind']> = new Set(['released_without_audit', 'audited_not_applied']);

/**
 * Compares journal records with audit events by operation id. FINDINGS ARE DIAGNOSTICS, never authority: the audit chain says
 * what happened, the journal says what the current state is. Disagreements are expected only in the benign crash windows documented
 * in c0-4-state-journal.md; `DANGEROUS_FINDINGS` are not, and fail closed when audit evidence is supplied to `start`.
 */
export function crossCheckState(operations: readonly StateOperation[], auditEvents: readonly AuditEvent[]): readonly CrossCheckFinding[] {
  const terminals = new Map<string, AuditEvent>();
  for (const e of auditEvents) if (e.lifecycle?.phase === 'terminal') terminals.set(e.lifecycle.operationId, e);
  const findings: CrossCheckFinding[] = [];
  const journalReleased = new Set<string>();
  const transitions = new Map<string, Set<string>>();
  for (const o of operations) {
    if (o.rec === 'release' || o.rec === 'quarantine') journalReleased.add(o.operationId);
    if (o.rec === 'transition' && o.kind !== undefined)
      transitions.set(o.operationId, (transitions.get(o.operationId) ?? new Set()).add(o.kind));
    if (o.rec === 'release') {
      const t = terminals.get(o.operationId);
      if (t === undefined || t.outcome !== 'completed') findings.push({ kind: 'released_without_audit', operationId: o.operationId });
    }
    if (o.rec === 'transition' && !terminals.has(o.operationId)) findings.push({ kind: 'applied_not_audited', operationId: o.operationId });
  }
  for (const [op, t] of terminals) {
    const counts = t.extensions?.['x-ei-audit']?.['counts'] as { evidence?: number } | undefined;
    if (t.outcome === 'completed' && (counts?.evidence ?? 0) > 0 && !journalReleased.has(op))
      findings.push({ kind: 'audited_not_released', operationId: op });
    const seen = transitions.get(op);
    // An audited revoke/purge whose transition is not in the journal: the journal is BEHIND the audit chain.
    if (t.outcome === 'revoked' && !(seen?.has('revoked') || seen?.has('purged')))
      findings.push({ kind: 'audited_not_applied', operationId: op });
    if (t.outcome === 'purged' && !seen?.has('purged')) findings.push({ kind: 'audited_not_applied', operationId: op });
  }
  const dedupe = new Set<string>();
  return findings.filter((f) => !dedupe.has(`${f.kind}:${f.operationId}`) && dedupe.add(`${f.kind}:${f.operationId}`));
}
