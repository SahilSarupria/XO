import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { canonicalJson, type WorkflowComponent } from '@xo/workflow-ir';
import { digestOfJson, type PreviewRecord } from './batch-approval.js';

/**
 * UW-16 (ADR 0051): standing approvals. A person approves, once, the bounds within which runs may start without a per-batch approval.
 * Each run under it still gets its own preview and its own batch approval (minted from the policy, signed as the standing approver's
 * decision), so every check of ADR 0046 applies unchanged. This file holds the types, the bounds check and the storage; the flows
 * (propose, approve, start, revoke) are in `standing-approval.ts`.
 *
 * The record lives at `<data>/<workspace>/standing-approvals/<sap_id>/`: files created exclusively and never rewritten.
 */

export type StandingPeriod = 'day' | 'week' | 'month';
export type StandingTrigger = 'manual' | 'schedule';

export interface StandingLimits {
  /** 1..10000 */
  readonly maxItemsPerRun: number;
  /** maxItemsPerRun..100000 */
  readonly maxItemsPerPeriod: number;
  /** 1..1000 */
  readonly maxRunsPerPeriod: number;
  readonly period: StandingPeriod;
  /** 0..10000 */
  readonly maxExcludedRows: number;
}

export interface StandingEffect {
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: 'write' | 'irreversible';
}

export interface ArgumentRef {
  readonly step: string;
  readonly argument: string;
}

/** An argument pinned to the values the approver saw: sorted, domain-separated value digests (never the values). */
export interface PinnedArgument extends ArgumentRef {
  readonly values: readonly string[];
}

export interface StandingPolicy {
  readonly v: 1;
  readonly standingApprovalId: string;
  readonly workspaceId: string;
  readonly definitionId: string;
  readonly componentSha256: string;
  readonly workflow?: { readonly workflowId: string; readonly version: number };
  readonly certificate: { readonly certificateId: string; readonly digest: string };
  /** Per connector: the digest of its bindings plus the sending account. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly items:
    | { readonly kind: 'source'; readonly connectionId: string; readonly proposalId: string; readonly over: string }
    | { readonly kind: 'input'; readonly inputDigest: string };
  /** Digest of the input without the `forEach.over` key. */
  readonly restInputDigest: string;
  readonly effects: readonly StandingEffect[];
  readonly pinned: readonly PinnedArgument[];
  readonly mayVary: readonly ArgumentRef[];
  readonly presignSteps: readonly string[];
  readonly limits: StandingLimits;
  readonly triggers: readonly StandingTrigger[];
  readonly startsAs: { readonly id: string; readonly kind: 'human' };
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly sample: { readonly previewId: string; readonly root: string; readonly items: number };
}

export interface StandingProposal {
  readonly policy: StandingPolicy;
  /** `digestOfJson(policy)`: what the approver approves. */
  readonly policyDigest: string;
  readonly proposedBy: { readonly id: string; readonly kind: string };
  readonly proposedAt: string;
  readonly note?: string;
}

export interface StandingApprovalPayload {
  readonly v: 1;
  readonly kind: 'standing';
  readonly standingApprovalId: string;
  readonly policyDigest: string;
  readonly reviewerId: string;
  readonly selfApproved: boolean;
  readonly at: string;
  readonly expiresAt: string;
}

export interface StandingApprovalRecord {
  readonly payload: StandingApprovalPayload;
  readonly signature: string;
  readonly keyId: string;
}

export interface StandingRevocation {
  readonly standingApprovalId: string;
  readonly by: { readonly id: string; readonly kind: string };
  readonly at: string;
  readonly reason: string;
}

export interface StandingChangesRequested {
  readonly by: { readonly id: string };
  readonly at: string;
  readonly comment: string;
}

export interface StandingUse {
  readonly runId: string;
  readonly approvalId: string;
  readonly items: number;
  readonly periodKey: string;
  readonly at: string;
}

export type StandingReason =
  | 'not_yet_valid'
  | 'expired'
  | 'revoked'
  | 'not_approved'
  | 'definition_changed'
  | 'binding_changed'
  | 'input_changed'
  | 'source_changed'
  | 'too_many_items'
  | 'period_items'
  | 'period_runs'
  | 'excluded_rows'
  | 'exceptions'
  | 'not_exact'
  | 'effect_not_allowed'
  | 'value_not_approved'
  | 'nothing_to_do';

export interface StandingFallback {
  readonly at: string;
  readonly trigger: StandingTrigger;
  readonly reasons: readonly StandingReason[];
  readonly previewId?: string;
}

export type StandingStatus = 'proposed' | 'changes_requested' | 'active' | 'expired' | 'revoked';

export const STANDING_MAX_DAYS = 90;
export const STANDING_ID = /^sap_[0-9a-f]{24}$/;

const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/** A value's digest, domain-separated and per workspace, so a stored digest cannot be compared with another workspace's. */
export const valueDigest = (workspaceId: string, v: unknown): string =>
  sha(`xo.standing.value.v1\u0000${workspaceId}\u0000${canonicalJson(v as never)}`);

export const newStandingId = (): string => `sap_${randomBytes(12).toString('hex')}`;

/** The key of the period an instant falls in (UTC; weeks are ISO weeks): `d:2026-11-23`, `w:2026-W48`, `m:2026-11`. */
export function periodKey(period: StandingPeriod, at: Date): string {
  const y = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  if (period === 'day') return `d:${y}-${mm}-${dd}`;
  if (period === 'month') return `m:${y}-${mm}`;
  // ISO week: the Thursday of this week decides the year.
  const d = new Date(Date.UTC(y, at.getUTCMonth(), at.getUTCDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `w:${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The arguments a run derives from an item or the input (an `item.…` or `input.…` binding) at every step that writes or does
 * something irreversible. These are what a standing approval pins, or lets vary.
 */
export function derivedArguments(
  component: WorkflowComponent,
): (ArgumentRef & { readonly from: string; readonly sideEffect: 'write' | 'irreversible' })[] {
  const out: (ArgumentRef & { from: string; sideEffect: 'write' | 'irreversible' })[] = [];
  for (const s of component.workflows[0]?.steps ?? []) {
    if (s.type !== 'act' && s.type !== 'compensate') continue;
    const sideEffect = (s as { sideEffect?: string }).sideEffect;
    if (sideEffect !== 'write' && sideEffect !== 'irreversible') continue;
    for (const [name, b] of Object.entries((s as { inputs?: Record<string, { from?: unknown }> }).inputs ?? {}))
      if (typeof b?.from === 'string' && (b.from.startsWith('item.') || b.from.startsWith('input.')))
        out.push({ step: s.id, argument: name, from: b.from, sideEffect });
  }
  return out;
}

/**
 * Whether a preview of today's items is inside a standing approval's bounds. Every rule is evaluated; the reasons are returned
 * without duplicates, in the order of `StandingReason`. An empty list means the run may start without a per-batch approval.
 */
export function checkBounds(
  policy: StandingPolicy,
  preview: PreviewRecord,
  workspaceId: string,
  bindingDigests: ReadonlyMap<string, string>,
  restInput: unknown,
  fullInput: unknown,
): StandingReason[] {
  const r = new Set<StandingReason>();
  if (preview.items.length > policy.limits.maxItemsPerRun) r.add('too_many_items');
  if (!preview.items.some((i) => i.state === 'sends')) r.add('nothing_to_do');
  if (preview.items.some((i) => i.state === 'stops')) r.add('exceptions');
  if (preview.items.some((i) => i.state === 'not_exact')) r.add('not_exact');
  if ((preview.itemsSource?.counts.excludedRows ?? 0) > policy.limits.maxExcludedRows) r.add('excluded_rows');
  const allowed = new Set(policy.effects.map((e) => `${e.connector}\u0000${e.operation}\u0000${e.sideEffect}`));
  const pinned = new Map(policy.pinned.map((p) => [`${p.step}\u0000${p.argument}`, new Set(p.values)]));
  for (const item of preview.items)
    for (const a of item.actions) {
      if (a.sideEffect === 'read') continue;
      if (!allowed.has(`${a.connector}\u0000${a.operation}\u0000${a.sideEffect}`)) r.add('effect_not_allowed');
      if (policy.bindings[a.connector] === undefined || bindingDigests.get(a.connector) !== policy.bindings[a.connector])
        r.add('binding_changed');
    }
  for (const p of policy.pinned)
    for (const item of preview.items)
      for (const a of item.actions)
        if (a.step === p.step && !(pinned.get(`${p.step}\u0000${p.argument}`)?.has(valueDigest(workspaceId, a.args[p.argument])) ?? false))
          r.add('value_not_approved');
  if (policy.items.kind === 'input') {
    if (digestOfJson(fullInput) !== policy.items.inputDigest) r.add('input_changed');
  } else if (digestOfJson(restInput) !== policy.restInputDigest) r.add('input_changed');
  const order: StandingReason[] = [
    'too_many_items',
    'period_items',
    'period_runs',
    'excluded_rows',
    'exceptions',
    'not_exact',
    'effect_not_allowed',
    'value_not_approved',
    'binding_changed',
    'input_changed',
    'nothing_to_do',
  ];
  return order.filter((x) => r.has(x));
}

// ---------------------------------------------------------------------------------------------------------- storage

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function createOnce(path: string, v: unknown): Promise<'created' | 'exists'> {
  try {
    await writeFile(path, JSON.stringify(v), { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw e;
  }
}

export interface StandingRecord {
  readonly proposal: StandingProposal;
  readonly approval?: StandingApprovalRecord;
  readonly revocation?: StandingRevocation;
  readonly changes?: StandingChangesRequested;
}

export class StandingStore {
  private readonly root: string;
  constructor(
    dataRoot: string,
    readonly workspaceId: string,
  ) {
    this.root = join(dataRoot, workspaceId, 'standing-approvals');
  }

  private dir(id: string): string {
    if (!STANDING_ID.test(id)) throw new NotFoundError(`standing approval "${id}"`);
    return join(this.root, id);
  }

  async propose(p: StandingProposal): Promise<void> {
    const dir = this.dir(p.policy.standingApprovalId);
    await mkdir(join(dir, 'uses'), { recursive: true });
    await mkdir(join(dir, 'fallbacks'), { recursive: true });
    if ((await createOnce(join(dir, 'proposal.json'), p)) === 'exists')
      throw new XoError(ErrorCode.ALREADY_EXISTS, `standing approval ${p.policy.standingApprovalId} already exists`);
  }

  async get(id: string): Promise<StandingRecord> {
    const dir = this.dir(id);
    const proposal = await readJson<StandingProposal>(join(dir, 'proposal.json'));
    if (proposal === undefined) throw new NotFoundError(`standing approval "${id}"`);
    const [approval, revocation, changes] = await Promise.all([
      readJson<StandingApprovalRecord>(join(dir, 'approval.json')),
      readJson<StandingRevocation>(join(dir, 'revocation.json')),
      readJson<StandingChangesRequested>(join(dir, 'changes-requested.json')),
    ]);
    return {
      proposal,
      ...(approval !== undefined ? { approval } : {}),
      ...(revocation !== undefined ? { revocation } : {}),
      ...(changes !== undefined ? { changes } : {}),
    };
  }

  /** Newest first. An unreadable record is skipped. */
  async list(): Promise<StandingRecord[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const out: StandingRecord[] = [];
    for (const n of names) if (STANDING_ID.test(n)) out.push(await this.get(n).catch(() => undefined as never));
    return out.filter((x) => x !== undefined).sort((a, b) => b.proposal.proposedAt.localeCompare(a.proposal.proposedAt));
  }

  status(r: StandingRecord, now: Date): StandingStatus {
    if (r.revocation !== undefined) return 'revoked';
    if (r.approval === undefined) return r.changes !== undefined ? 'changes_requested' : 'proposed';
    return Date.parse(r.proposal.policy.expiresAt) <= now.getTime() ? 'expired' : 'active';
  }

  async approve(rec: StandingApprovalRecord): Promise<void> {
    if ((await createOnce(join(this.dir(rec.payload.standingApprovalId), 'approval.json'), rec)) === 'exists')
      throw new XoError(ErrorCode.STANDING_APPROVAL_REFUSED, 'this standing approval was already approved', {
        context: { reason: 'not_proposed' },
      });
  }

  async requestChanges(id: string, c: StandingChangesRequested): Promise<void> {
    await createOnce(join(this.dir(id), 'changes-requested.json'), c);
  }

  /** A second revoke returns the first record. */
  async revoke(r: StandingRevocation): Promise<StandingRevocation> {
    const path = join(this.dir(r.standingApprovalId), 'revocation.json');
    if ((await createOnce(path, r)) === 'created') return r;
    return (await readJson<StandingRevocation>(path)) ?? r;
  }

  /** The reservation of a run in the period's count: an exclusive create, so the same run reserved twice is one use. */
  async reserve(id: string, use: StandingUse): Promise<'reserved' | 'exists'> {
    const dir = join(this.dir(id), 'uses');
    await mkdir(dir, { recursive: true });
    return (await createOnce(join(dir, `${use.runId}.json`), use)) === 'created' ? 'reserved' : 'exists';
  }

  async release(id: string, runId: string): Promise<void> {
    await rm(join(this.dir(id), 'uses', `${runId}.json`), { force: true });
  }

  async uses(id: string): Promise<StandingUse[]> {
    const dir = join(this.dir(id), 'uses');
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: StandingUse[] = [];
    for (const n of names) {
      const u = await readJson<StandingUse>(join(dir, n)).catch(() => undefined);
      if (u !== undefined) out.push(u);
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async usesIn(id: string, key: string): Promise<{ readonly runs: number; readonly items: number }> {
    const mine = (await this.uses(id)).filter((u) => u.periodKey === key);
    return { runs: mine.length, items: mine.reduce((n, u) => n + u.items, 0) };
  }

  async fallback(id: string, f: StandingFallback): Promise<void> {
    const dir = join(this.dir(id), 'fallbacks');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${f.at.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`);
    await writeFile(`${tmp}.tmp`, JSON.stringify(f), { mode: 0o600 });
    await rename(`${tmp}.tmp`, tmp);
  }

  async fallbacks(id: string, sinceIso?: string): Promise<StandingFallback[]> {
    const dir = join(this.dir(id), 'fallbacks');
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: StandingFallback[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const f = await readJson<StandingFallback>(join(dir, n)).catch(() => undefined);
      if (f !== undefined && (sinceIso === undefined || f.at >= sinceIso)) out.push(f);
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Whether a run may still start or go on under this approval. Read from disk at every call: approved, not revoked, within its dates.
   * Anything that cannot be read answers `false`: the check fails closed.
   */
  async isActive(id: string, now: Date): Promise<boolean> {
    try {
      const r = await this.get(id);
      return this.status(r, now) === 'active' && Date.parse(r.proposal.policy.notBefore) <= now.getTime();
    } catch {
      return false;
    }
  }
}
