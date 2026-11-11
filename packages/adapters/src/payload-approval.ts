import { createHash, randomUUID } from 'node:crypto';
import type { AtomicBlobStore } from '@xo/storage';
import type { MaybePromise } from './contract.js';

/**
 * PAYLOAD-LEVEL APPROVAL (interim design, owner-approved: a host-declared per-adapter `approvalMode`, until the unavailable O-2
 * effect-classification spec exists; NOT a claim that O-2 is satisfied).
 *
 * A grant is a human's approval of ONE concrete action: bound to a dispatch key (procedure execution + step), a capability, an adapter
 * and the canonical action digest (which covers the adapter's security config and the exact input). It is immutable. Using it is a
 * separate atomic act — `consume` — that succeeds for exactly one caller, so an approval can never authorize two dispatches, even
 * across processes sharing the store. The record holds the approver, the action summary the human saw, the digest and the time; it never
 * holds the input values themselves (the summary is host/adapter-produced text the approver confirmed — keep it free of secrets).
 */

export const MAX_ACTION_SUMMARY = 500;
const APPROVAL_ID_RE = /^pa_[0-9a-f]{32}$/;
export const isPayloadApprovalId = (v: unknown): v is string => typeof v === 'string' && APPROVAL_ID_RE.test(v);

export interface PayloadApprovalGrant {
  readonly approvalId: string;
  readonly dispatchKey: string;
  readonly capabilityId: string;
  readonly adapterId: string;
  /** Canonical digest of the exact action (capability + adapter identity/config + input). Dispatch must reproduce it exactly. */
  readonly actionDigest: string;
  readonly actionSummary: string;
  readonly approver: { readonly kind: 'human'; readonly id: string };
  readonly grantedAt: string;
  /** Correlation id of the audit events written for this grant (a reference, not an atomic link). */
  readonly auditCorrelationId?: string;
}

export type PayloadApprovalDraft = Omit<PayloadApprovalGrant, 'approvalId' | 'grantedAt'>;

export interface PayloadApprovalConsumption {
  readonly approvalId: string;
  readonly dispatchKey: string;
  readonly consumedAt: string;
}

export interface PayloadApprovalStore {
  /** `'durable'` only when grants and consumption markers survive a restart. Same fail-closed meaning as `DispatchLedger.durability`. */
  readonly durability?: 'durable' | 'volatile';
  /** Records a grant. Only a human approver is accepted. Throws on any failure (nothing is then granted). */
  grant(draft: PayloadApprovalDraft): MaybePromise<PayloadApprovalGrant>;
  /** Every grant recorded for one dispatch key (oldest first). Throws if the store is unreadable or corrupt. */
  grantsFor(dispatchKey: string): MaybePromise<readonly PayloadApprovalGrant[]>;
  /** ATOMIC single use: for a given approval id exactly one caller ever gets `consumed: true`. */
  consume(approvalId: string, dispatchKey: string): MaybePromise<{ readonly consumed: boolean }>;
  consumptionOf(approvalId: string): MaybePromise<PayloadApprovalConsumption | undefined>;
}

function validateDraft(d: PayloadApprovalDraft): void {
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!nonEmpty(d.dispatchKey) || !nonEmpty(d.capabilityId) || !nonEmpty(d.adapterId) || !nonEmpty(d.actionDigest)) {
    throw new Error('a payload approval needs a dispatch key, capability, adapter and action digest');
  }
  if (d.approver?.kind !== 'human' || !nonEmpty(d.approver.id)) throw new Error('only an identified human may grant a payload approval');
  if (!nonEmpty(d.actionSummary) || d.actionSummary.length > MAX_ACTION_SUMMARY) {
    throw new Error(`an action summary (1-${MAX_ACTION_SUMMARY} characters) is required`);
  }
}

export class InMemoryPayloadApprovalStore implements PayloadApprovalStore {
  readonly durability = 'volatile' as const;
  private readonly grants: PayloadApprovalGrant[] = [];
  private readonly used = new Map<string, PayloadApprovalConsumption>();
  grant(draft: PayloadApprovalDraft): PayloadApprovalGrant {
    validateDraft(draft);
    const g = Object.freeze({ ...draft, approvalId: `pa_${randomUUID().replace(/-/g, '')}`, grantedAt: new Date().toISOString() });
    this.grants.push(g);
    return g;
  }
  grantsFor(dispatchKey: string): readonly PayloadApprovalGrant[] {
    return this.grants.filter((g) => g.dispatchKey === dispatchKey);
  }
  consume(approvalId: string, dispatchKey: string): { readonly consumed: boolean } {
    if (this.used.has(approvalId)) return { consumed: false };
    this.used.set(approvalId, { approvalId, dispatchKey, consumedAt: new Date().toISOString() });
    return { consumed: true };
  }
  consumptionOf(approvalId: string): PayloadApprovalConsumption | undefined {
    return this.used.get(approvalId);
  }
}

const ROOT = 'external-effects';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const grantPrefix = (dispatchKey: string): string => `${ROOT}/payload-approvals/${sha256(dispatchKey)}`;
const consumedKey = (approvalId: string): string => `${ROOT}/payload-consumed/${approvalId}.json`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const GRANT_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'approvalId',
  'dispatchKey',
  'capabilityId',
  'adapterId',
  'actionDigest',
  'actionSummary',
  'approver',
  'grantedAt',
  'auditCorrelationId',
]);

export class PayloadApprovalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadApprovalCorruptError';
  }
}

function parseGrant(raw: unknown, expectedKey: string): PayloadApprovalGrant {
  const bad = (why: string): never => {
    throw new PayloadApprovalCorruptError(`payload approval record is invalid (${why})`);
  };
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) return bad('shape');
  for (const k of Object.keys(raw)) if (!GRANT_KEYS.has(k)) return bad(`unknown field "${k}"`);
  const s = (k: string): string => (typeof raw[k] === 'string' && (raw[k] as string).length > 0 ? (raw[k] as string) : bad(k));
  const approver = raw['approver'];
  if (!isRecord(approver) || approver['kind'] !== 'human' || typeof approver['id'] !== 'string' || approver['id'].length === 0)
    bad('approver');
  if (!isPayloadApprovalId(raw['approvalId'])) bad('approvalId');
  if (raw['dispatchKey'] !== expectedKey) bad('dispatchKey does not match its location');
  if (raw['auditCorrelationId'] !== undefined && typeof raw['auditCorrelationId'] !== 'string') bad('auditCorrelationId');
  return Object.freeze({
    approvalId: raw['approvalId'] as string,
    dispatchKey: s('dispatchKey'),
    capabilityId: s('capabilityId'),
    adapterId: s('adapterId'),
    actionDigest: s('actionDigest'),
    actionSummary: s('actionSummary'),
    approver: { kind: 'human' as const, id: (approver as Record<string, string>)['id'] as string },
    grantedAt: s('grantedAt'),
    ...(raw['auditCorrelationId'] !== undefined ? { auditCorrelationId: raw['auditCorrelationId'] as string } : {}),
  });
}

/**
 * Durable payload-approval store over the repository's {@link AtomicBlobStore}. Grants are immutable blobs; consumption is
 * `putIfAbsent` of a per-approval marker, so exactly one caller wins — atomic in the authoritative store, never an in-memory check.
 * Same limit as the dispatch ledger: atomic across processes on ONE filesystem only; a multi-host deployment needs a store with
 * linearizable conditional create behind the same port. Nothing here deletes or overwrites.
 */
export class BlobPayloadApprovalStore implements PayloadApprovalStore {
  readonly durability = 'durable' as const;
  private readonly now: () => Date;
  constructor(
    private readonly store: AtomicBlobStore,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async grant(draft: PayloadApprovalDraft): Promise<PayloadApprovalGrant> {
    validateDraft(draft);
    const approvalId = `pa_${randomUUID().replace(/-/g, '')}`;
    const grantedAt = this.now().toISOString();
    const body = {
      schemaVersion: 1,
      approvalId,
      dispatchKey: draft.dispatchKey,
      capabilityId: draft.capabilityId,
      adapterId: draft.adapterId,
      actionDigest: draft.actionDigest,
      actionSummary: draft.actionSummary,
      approver: { kind: 'human', id: draft.approver.id },
      grantedAt,
      ...(draft.auditCorrelationId !== undefined ? { auditCorrelationId: draft.auditCorrelationId } : {}),
    };
    const put = await this.store.putIfAbsent(`${grantPrefix(draft.dispatchKey)}/${approvalId}.json`, JSON.stringify(body), {
      contentType: 'application/json',
    });
    if (!put.ok) throw new PayloadApprovalCorruptError(`payload approval could not be written: ${put.error.message}`);
    if (!put.value.created) throw new PayloadApprovalCorruptError('payload approval id collision');
    return parseGrant(body, draft.dispatchKey);
  }

  async grantsFor(dispatchKey: string): Promise<readonly PayloadApprovalGrant[]> {
    const prefix = grantPrefix(dispatchKey);
    if (!(await this.store.has(prefix))) return [];
    const listed = await this.store.list(prefix);
    if (!listed.ok) throw new PayloadApprovalCorruptError(`payload approvals could not be listed: ${listed.error.message}`);
    const out: PayloadApprovalGrant[] = [];
    // Only complete `.json` blobs count (a writer's private staging file is not an approval).
    for (const name of listed.value.filter((n) => n.endsWith('.json')).sort()) {
      const got = await this.store.get(name);
      if (!got.ok) throw new PayloadApprovalCorruptError(`payload approval could not be read: ${got.error.message}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(got.value));
      } catch {
        throw new PayloadApprovalCorruptError('payload approval record is not valid JSON');
      }
      out.push(parseGrant(parsed, dispatchKey));
    }
    return out.sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : a.grantedAt > b.grantedAt ? 1 : 0));
  }

  async consume(approvalId: string, dispatchKey: string): Promise<{ readonly consumed: boolean }> {
    if (!isPayloadApprovalId(approvalId)) throw new PayloadApprovalCorruptError('invalid approval id');
    const body = { schemaVersion: 1, approvalId, dispatchKey, consumedAt: this.now().toISOString() };
    const put = await this.store.putIfAbsent(consumedKey(approvalId), JSON.stringify(body), { contentType: 'application/json' });
    if (!put.ok) throw new PayloadApprovalCorruptError(`payload approval could not be consumed: ${put.error.message}`);
    return { consumed: put.value.created };
  }

  async consumptionOf(approvalId: string): Promise<PayloadApprovalConsumption | undefined> {
    if (!isPayloadApprovalId(approvalId)) throw new PayloadApprovalCorruptError('invalid approval id');
    if (!(await this.store.has(consumedKey(approvalId)))) return undefined;
    const got = await this.store.get(consumedKey(approvalId));
    if (!got.ok) throw new PayloadApprovalCorruptError(`consumption record could not be read: ${got.error.message}`);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(got.value));
    } catch {
      throw new PayloadApprovalCorruptError('consumption record is not valid JSON');
    }
    if (
      !isRecord(raw) ||
      raw['approvalId'] !== approvalId ||
      typeof raw['dispatchKey'] !== 'string' ||
      typeof raw['consumedAt'] !== 'string'
    ) {
      throw new PayloadApprovalCorruptError('consumption record is invalid');
    }
    return { approvalId, dispatchKey: raw['dispatchKey'], consumedAt: raw['consumedAt'] };
  }
}
