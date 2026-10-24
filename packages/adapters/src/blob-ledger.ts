import { createHash } from 'node:crypto';
import type { AtomicBlobStore } from '@xo/storage';
import type { DispatchEvidence, DispatchLedger, LedgerEntryDraft, ReconciliationRecord } from './contract.js';

/**
 * Durable, append-only dispatch-evidence ledger over an {@link AtomicBlobStore} (the repository's existing atomic storage port).
 *
 * LAYOUT (every blob is immutable once created; nothing in this class deletes or overwrites):
 *   `external-effects/events/<sha256(dispatchKey)>/<seq, 10 digits>.json`   one evidence entry
 *   `external-effects/by-capability/<sha256(capabilityId)>/<sha256(dispatchKey)>.json`   index marker (key -> capability)
 *
 * ATOMICITY. The only synchronization primitive is `putIfAbsent` (create-if-absent, complete-or-nothing). Claiming a dispatch key is
 * `putIfAbsent(<key>/0000000001.json)`; any number of concurrent callers (threads, workers, or processes sharing the store) race for
 * that one name and exactly one wins. Appending after seq N is `putIfAbsent(<key>/<N+1>.json)`, i.e. compare-and-append: if the
 * evidence moved, the create loses. There is no lock and no lease, so nothing can be left locked by a crash.
 *
 * WHAT THIS DOES NOT GIVE. It is as strong as the store's `putIfAbsent`: `LocalFsBlobStore` is atomic across processes on one
 * filesystem only. It is NOT distributed locking and it does not make the external effect exactly-once. A multi-host deployment needs
 * a store whose conditional-create is linearizable (e.g. a Postgres unique key or an object store's if-none-match) behind the same
 * `AtomicBlobStore` port. Corrupt, out-of-order or unparseable evidence throws (the dispatcher then refuses to dispatch).
 */

const ROOT = 'external-effects';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const pad = (n: number): string => String(n).padStart(10, '0');
const eventPrefix = (dispatchKey: string): string => `${ROOT}/events/${sha256(dispatchKey)}`;
const eventKey = (dispatchKey: string, seq: number): string => `${eventPrefix(dispatchKey)}/${pad(seq)}.json`;
const markerPrefix = (capabilityId: string): string => `${ROOT}/by-capability/${sha256(capabilityId)}`;
const markerKey = (capabilityId: string, dispatchKey: string): string => `${markerPrefix(capabilityId)}/${sha256(dispatchKey)}.json`;

const STATES: ReadonlySet<string> = new Set(['dispatch_attempted', 'confirmed_success', 'confirmed_failure_no_effect', 'outcome_unknown']);
const DECISIONS: ReadonlySet<string> = new Set(['confirmed_success', 'confirmed_failure_no_effect', 'unresolved']);
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'seq',
  'dispatchKey',
  'capabilityId',
  'adapterId',
  'state',
  'detail',
  'recordedAt',
  'inputFingerprint',
  'actionDigest',
  'auditCorrelationId',
  'approvalMode',
  'payloadApprovalId',
  'reconciliation',
  'follows',
]);
const RECON_KEYS: ReadonlySet<string> = new Set(['actorKind', 'actorId', 'decision', 'reason', 'evidenceExamined', 'auditCorrelationId']);

/**
 * `AtomicBlobStore.putIfAbsent` stages content in a private `<name>.<pid>.<uuid>.tmp` file and then links it to its final name, so a
 * listing taken while another writer is mid-write can include that staging file. It is not evidence (it is not yet visible under its real
 * name, and an orphan left by a crash is inert): only complete `.json` entries count.
 */
const visible = (names: readonly string[]): string[] => names.filter((n) => n.endsWith('.json')).sort();

export class LedgerCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerCorruptError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Strict: unknown fields, wrong types or an impossible shape throw (=> the caller fails closed). */
function parseEntry(raw: unknown, where: string): DispatchEvidence {
  const bad = (why: string): never => {
    throw new LedgerCorruptError(`dispatch evidence ${where} is not valid: ${why}`);
  };
  if (!isRecord(raw)) return bad('not an object');
  for (const k of Object.keys(raw)) if (!ENTRY_KEYS.has(k)) return bad(`unknown field "${k}"`);
  if (raw['schemaVersion'] !== 1) return bad('unsupported schemaVersion');
  const seq = raw['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return bad('seq');
  if (!isStr(raw['dispatchKey']) || !isStr(raw['capabilityId']) || !isStr(raw['adapterId'])) return bad('identity fields');
  if (typeof raw['state'] !== 'string' || !STATES.has(raw['state'])) return bad('state');
  if (raw['detail'] !== undefined && typeof raw['detail'] !== 'string') return bad('detail');
  if (raw['recordedAt'] !== undefined && typeof raw['recordedAt'] !== 'string') return bad('recordedAt');
  if (raw['inputFingerprint'] !== undefined && typeof raw['inputFingerprint'] !== 'string') return bad('inputFingerprint');
  if (raw['actionDigest'] !== undefined && !isStr(raw['actionDigest'])) return bad('actionDigest');
  if (raw['auditCorrelationId'] !== undefined && !isStr(raw['auditCorrelationId'])) return bad('auditCorrelationId');
  if (raw['approvalMode'] !== undefined && raw['approvalMode'] !== 'definition' && raw['approvalMode'] !== 'payload')
    return bad('approvalMode');
  if (raw['payloadApprovalId'] !== undefined && !isStr(raw['payloadApprovalId'])) return bad('payloadApprovalId');
  let reconciliation: ReconciliationRecord | undefined;
  if (raw['reconciliation'] !== undefined) {
    const r = raw['reconciliation'];
    if (!isRecord(r)) return bad('reconciliation');
    for (const k of Object.keys(r)) if (!RECON_KEYS.has(k)) return bad(`unknown reconciliation field "${k}"`);
    if (r['actorKind'] !== 'human' && r['actorKind'] !== 'service' && r['actorKind'] !== 'system') return bad('reconciliation.actorKind');
    if (!isStr(r['actorId'])) return bad('reconciliation.actorId');
    if (typeof r['decision'] !== 'string' || !DECISIONS.has(r['decision'])) return bad('reconciliation.decision');
    if (typeof r['reason'] !== 'string' || typeof r['evidenceExamined'] !== 'string') return bad('reconciliation text');
    if (r['auditCorrelationId'] !== undefined && !isStr(r['auditCorrelationId'])) return bad('reconciliation.auditCorrelationId');
    reconciliation = {
      ...(r['auditCorrelationId'] !== undefined ? { auditCorrelationId: r['auditCorrelationId'] as string } : {}),
      actorKind: r['actorKind'],
      actorId: r['actorId'],
      decision: r['decision'] as ReconciliationRecord['decision'],
      reason: r['reason'],
      evidenceExamined: r['evidenceExamined'],
    };
  }
  let follows: DispatchEvidence['follows'];
  if (raw['follows'] !== undefined) {
    const f = raw['follows'];
    if (!isRecord(f) || Object.keys(f).some((k) => k !== 'dispatchKey' && k !== 'outcome')) return bad('follows');
    if (!isStr(f['dispatchKey']) || f['outcome'] !== 'confirmed_failure_no_effect') return bad('follows');
    follows = { dispatchKey: f['dispatchKey'], outcome: 'confirmed_failure_no_effect' };
  }
  return Object.freeze({
    seq,
    dispatchKey: raw['dispatchKey'] as string,
    capabilityId: raw['capabilityId'] as string,
    adapterId: raw['adapterId'] as string,
    state: raw['state'] as DispatchEvidence['state'],
    ...(raw['detail'] !== undefined ? { detail: raw['detail'] as string } : {}),
    ...(raw['recordedAt'] !== undefined ? { recordedAt: raw['recordedAt'] as string } : {}),
    ...(raw['inputFingerprint'] !== undefined ? { inputFingerprint: raw['inputFingerprint'] as string } : {}),
    ...(raw['actionDigest'] !== undefined ? { actionDigest: raw['actionDigest'] as string } : {}),
    ...(raw['auditCorrelationId'] !== undefined ? { auditCorrelationId: raw['auditCorrelationId'] as string } : {}),
    ...(raw['approvalMode'] !== undefined ? { approvalMode: raw['approvalMode'] as 'definition' | 'payload' } : {}),
    ...(raw['payloadApprovalId'] !== undefined ? { payloadApprovalId: raw['payloadApprovalId'] as string } : {}),
    ...(reconciliation !== undefined ? { reconciliation } : {}),
    ...(follows !== undefined ? { follows } : {}),
  });
}

export interface BlobDispatchLedgerOptions {
  /** Injectable clock (tests). Defaults to the server clock. */
  readonly now?: () => Date;
}

export class BlobDispatchLedger implements DispatchLedger {
  /** Durable ONLY as far as the injected store is: the caller attests that `store` persists across restarts (LocalFsBlobStore on a real directory does). */
  readonly durability = 'durable' as const;
  private readonly now: () => Date;
  constructor(
    private readonly store: AtomicBlobStore,
    options: BlobDispatchLedgerOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  private serialize(seq: number, entry: LedgerEntryDraft): string {
    return JSON.stringify({
      schemaVersion: 1,
      seq,
      dispatchKey: entry.dispatchKey,
      capabilityId: entry.capabilityId,
      adapterId: entry.adapterId,
      state: entry.state,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      recordedAt: this.now().toISOString(),
      ...(entry.inputFingerprint !== undefined ? { inputFingerprint: entry.inputFingerprint } : {}),
      ...(entry.actionDigest !== undefined ? { actionDigest: entry.actionDigest } : {}),
      ...(entry.auditCorrelationId !== undefined ? { auditCorrelationId: entry.auditCorrelationId } : {}),
      ...(entry.approvalMode !== undefined ? { approvalMode: entry.approvalMode } : {}),
      ...(entry.payloadApprovalId !== undefined ? { payloadApprovalId: entry.payloadApprovalId } : {}),
      ...(entry.reconciliation !== undefined ? { reconciliation: entry.reconciliation } : {}),
      ...(entry.follows !== undefined ? { follows: entry.follows } : {}),
    });
  }

  /** Every entry of one key, validated contiguous from 1. A gap or a duplicate is corruption => throws (never "treated as absent"). */
  async read(dispatchKey: string): Promise<readonly DispatchEvidence[]> {
    const prefix = eventPrefix(dispatchKey);
    if (!(await this.store.has(prefix))) return [];
    const listed = await this.store.list(prefix);
    if (!listed.ok) throw new LedgerCorruptError(`evidence for a dispatch key could not be listed: ${listed.error.message}`);
    const names = visible(listed.value);
    const out: DispatchEvidence[] = [];
    for (const [i, name] of names.entries()) {
      if (name !== `${prefix}/${pad(i + 1)}.json`) throw new LedgerCorruptError(`evidence sequence is not contiguous at "${name}"`);
      const got = await this.store.get(name);
      if (!got.ok) throw new LedgerCorruptError(`evidence entry could not be read: ${got.error.message}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(got.value));
      } catch {
        throw new LedgerCorruptError(`evidence entry "${name}" is not valid JSON`);
      }
      const entry = parseEntry(parsed, `"${name}"`);
      if (entry.seq !== i + 1 || entry.dispatchKey !== dispatchKey)
        throw new LedgerCorruptError(`evidence entry "${name}" does not match its position or key`);
      out.push(entry);
    }
    return out;
  }

  async readByCapability(capabilityId: string): Promise<readonly DispatchEvidence[]> {
    const prefix = markerPrefix(capabilityId);
    if (!(await this.store.has(prefix))) return [];
    const listed = await this.store.list(prefix);
    if (!listed.ok) throw new LedgerCorruptError(`the capability index could not be listed: ${listed.error.message}`);
    const out: DispatchEvidence[] = [];
    for (const name of visible(listed.value)) {
      const got = await this.store.get(name);
      if (!got.ok) throw new LedgerCorruptError(`a capability index marker could not be read: ${got.error.message}`);
      let marker: unknown;
      try {
        marker = JSON.parse(new TextDecoder().decode(got.value));
      } catch {
        throw new LedgerCorruptError('a capability index marker is not valid JSON');
      }
      if (!isRecord(marker) || !isStr(marker['dispatchKey']) || marker['capabilityId'] !== capabilityId) {
        throw new LedgerCorruptError('a capability index marker is malformed');
      }
      // A marker with no events means the claim never happened (crash between marker and claim): nothing was dispatched.
      out.push(...(await this.read(marker['dispatchKey'])));
    }
    return out;
  }

  /** Non-atomic convenience used only where the caller already holds the key; prefer `claim` / `appendAfter`. */
  async append(entry: LedgerEntryDraft): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.read(entry.dispatchKey);
      const result = await this.appendAfter(entry.dispatchKey, existing.length, entry);
      if (result.appended) return;
    }
    throw new LedgerCorruptError('evidence could not be appended: persistent write contention');
  }

  async claim(entry: LedgerEntryDraft): Promise<{ readonly claimed: boolean }> {
    // Marker first: an event can then never exist without its capability index entry.
    const marker = await this.store.putIfAbsent(
      markerKey(entry.capabilityId, entry.dispatchKey),
      JSON.stringify({ schemaVersion: 1, dispatchKey: entry.dispatchKey, capabilityId: entry.capabilityId }),
      { contentType: 'application/json' },
    );
    if (!marker.ok) throw new LedgerCorruptError(`capability index marker could not be written: ${marker.error.message}`);
    const put = await this.store.putIfAbsent(eventKey(entry.dispatchKey, 1), this.serialize(1, entry), { contentType: 'application/json' });
    if (!put.ok) throw new LedgerCorruptError(`evidence could not be written: ${put.error.message}`);
    return { claimed: put.value.created };
  }

  async appendAfter(dispatchKey: string, expectedLastSeq: number, entry: LedgerEntryDraft): Promise<{ readonly appended: boolean }> {
    const seq = expectedLastSeq + 1;
    // Never leave a gap: the entry we are appending after must exist (a gap would be read back as corruption and block the key forever).
    if (expectedLastSeq < 1 || !(await this.store.has(eventKey(dispatchKey, expectedLastSeq)))) {
      throw new LedgerCorruptError('evidence cannot be appended after an entry that does not exist');
    }
    const put = await this.store.putIfAbsent(eventKey(dispatchKey, seq), this.serialize(seq, entry), { contentType: 'application/json' });
    if (!put.ok) throw new LedgerCorruptError(`evidence could not be written: ${put.error.message}`);
    return { appended: put.value.created };
  }
}
