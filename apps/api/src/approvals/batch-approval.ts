import { createHash, randomBytes, sign as edSign } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { canonicalJson, type WorkflowComponent } from '@xo/workflow-ir';
import { itemRunId, type JournalEntry, type RunStore } from '@xo/workflow-runtime';

/**
 * UW-8 (ADR 0046): batch preview and batch-bound approval.
 *
 * A preview runs the certified definition over the exact input in the engine's preview mode: approvals count as approved, timers as
 * elapsed, and every would-be call is journaled with its exact arguments. Nothing is sent. Each item (every item of a list run, or the
 * run itself) becomes a leaf naming each action's step, connector, operation, effect class, binding (which includes the sending
 * account) and a digest of its arguments. One root digest covers every leaf plus the definition, certificate and input.
 *
 * A person approves the ROOT they were shown. The approval is signed with the platform's approval key (the one primitive), used once,
 * and checked three times: at start (the preview is computed again and must give the same root), at each approval step of the run
 * (the decision is presented as that person's, and the engine verifies it), and immediately before each call (the call's actual
 * arguments must equal what was approved).
 */

const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const digestOfJson = (v: unknown): string => sha(canonicalJson(v as never));

export type PreviewItemState = 'sends' | 'no_effect' | 'stops' | 'not_exact';

export interface PreviewAction {
  readonly step: string;
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: 'read' | 'write' | 'irreversible';
  readonly binding: string;
  readonly argsDigest: string;
  /** Digest of everything above: what the dispatch check compares. */
  readonly digest: string;
  /** The arguments, for the person reviewing the preview (kept in the workspace's data, never in audit or logs). */
  readonly args: Readonly<Record<string, unknown>>;
}

export interface PreviewItem {
  readonly index: number;
  readonly state: PreviewItemState;
  readonly reason?: string;
  /** Approval steps the item reaches (each is decided by the batch approval in the run). */
  readonly approvals: readonly string[];
  readonly actions: readonly PreviewAction[];
  readonly leaf: string;
}

export interface SenderView {
  readonly connector: string;
  readonly credentialId?: string;
  readonly provider?: string;
  /** How its owner recognises the account (an email address); shown to the reviewer only. */
  readonly account?: string;
  /** UAC-32: for email, the tier it sends in (`native_api`, `smtp_imap`, `send_only`) and what that means, in plain words. */
  readonly tier?: string;
  readonly tierExplanation?: string;
}

export interface PreviewRecord {
  readonly v: 1;
  readonly previewId: string;
  readonly definitionId: string;
  readonly certificateId: string;
  readonly inputDigest: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly forEach: boolean;
  readonly senders: readonly SenderView[];
  readonly items: readonly PreviewItem[];
  readonly counts: Readonly<Record<PreviewItemState, number>>;
  /** True when at least one item would write or do something irreversible. */
  readonly effects: boolean;
  readonly root: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** V1-1 (ADR 0049): the items came from a confirmed source; a start rebuilds them from it and compares. */
  readonly itemsSource?: PreviewItemsSource;
  /** UW-16b: this preview is what a run under a standing approval fell back to, and why (a person approves it as any batch). */
  /** UW-16b: the sample a standing approval was proposed with. It is for the decision on that policy; it is not itself approved or listed in the Inbox. */
  readonly standingSample?: true;
  readonly standingFallback?: { readonly standingApprovalId: string; readonly reasons: readonly string[] };
}

/** Where a preview's items came from, and what was left out (each list bounded; the counts are whole). */
export interface PreviewItemsSource {
  readonly connectionId: string;
  readonly proposalId: string;
  readonly role: string;
  readonly label: string;
  readonly connectionName: string;
  /** The workflow input the items fill (`forEach.over`). */
  readonly over: string;
  readonly digests: readonly string[];
  readonly changedSinceConfirmation: boolean;
  readonly counts: { readonly items: number; readonly excludedRows: number; readonly excludedDocuments: number; readonly loose: number };
  readonly excludedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly excludedDocuments: readonly { readonly name: string; readonly reason: string }[];
  readonly looseRows: readonly { readonly row: number; readonly kind: string }[];
}

export interface BatchApprovalPayload {
  /**
   * v1: decides every approval step the preview showed. v2 (UW-16a, ADR 0051): only the steps in `presignSteps`. v3 (UW-16b): v2,
   * minted by XO from a standing approval (`standing`), which must still be active at every call.
   */
  readonly v: 1 | 2 | 3;
  readonly kind: 'batch';
  readonly approvalId: string;
  readonly previewId: string;
  readonly root: string;
  readonly definitionId: string;
  readonly certificateId: string;
  readonly inputDigest: string;
  readonly items: number;
  readonly reviewerId: string;
  readonly at: string;
  readonly expiresAt: string;
  /** v2: the approval steps this approval also decides, named by its approver (inside the signature). */
  readonly presignSteps?: readonly string[];
  /** v3: the standing approval this approval was minted from, and the digest of its policy. */
  readonly standing?: { readonly standingApprovalId: string; readonly policyDigest: string };
}

/** The approval steps a batch approval decides: every step its preview showed (v1), or the ones its approver named (v2). */
export function presignedSteps(p: BatchApprovalPayload): ReadonlySet<string> | 'all' {
  return p.v === 1 ? 'all' : new Set(p.presignSteps ?? []);
}

/** UW-16a: the id of the preview a schedule slot prepares: the same slot, on any instance, is the same preview. */
export const slotPreviewId = (definitionId: string, key: string): string =>
  `pvw_${createHash('sha256').update(`${definitionId}\u0000${key}`).digest('hex').slice(0, 24)}`;

export interface BatchApprovalRecord {
  readonly payload: BatchApprovalPayload;
  /** base64 Ed25519 over canonicalJson(payload), by the platform's approval key on behalf of the reviewer. */
  readonly signature: string;
  readonly keyId: string;
}

export interface ConsumedRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly by: string;
  readonly at: string;
}

export interface RevokedApprovalRecord {
  readonly approvalId: string;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

export const PREVIEW_TTL_MS = 24 * 60 * 60_000;

/** Where a definition's previews and batch approvals live: beside its runs. */
export const batchDir = (runsDir: string): string => join(runsDir, 'batch');

// ---------------------------------------------------------------------------------------------------------- what is exact

/**
 * Step ids whose outputs a preview cannot know: connector calls (a preview sends nothing, so their results are unknown) and every
 * step that takes an input from one, transitively. An action among them cannot be previewed exactly.
 */
export function unknowableSteps(component: WorkflowComponent): ReadonlySet<string> {
  const wf = component.workflows[0];
  if (wf === undefined) return new Set();
  const unknown = new Set(wf.steps.filter((s) => s.type === 'act' || s.type === 'compensate').map((s) => s.id));
  const refsOf = (s: (typeof wf.steps)[number]): string[] =>
    Object.values((s as { inputs?: Record<string, { from?: unknown }> }).inputs ?? {}).flatMap((i) =>
      typeof i?.from === 'string' && i.from.startsWith('steps.') ? [i.from.split('.')[1] ?? ''] : [],
    );
  const tainted = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const s of wf.steps)
      if (!tainted.has(s.id) && refsOf(s).some((r) => unknown.has(r) || tainted.has(r))) {
        tainted.add(s.id);
        changed = true;
      }
  }
  return tainted;
}

/** True when the definition can have any write or irreversible effect. */
export function hasEffects(component: WorkflowComponent): boolean {
  const wf = component.workflows[0];
  return (wf?.steps ?? []).some(
    (s) => (s.type === 'act' || s.type === 'compensate') && (s as { sideEffect?: string }).sideEffect !== 'read',
  );
}

// ---------------------------------------------------------------------------------------------------------- building

export interface BuildPreviewArgs {
  readonly component: WorkflowComponent;
  readonly definitionId: string;
  readonly certificateId: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The preview run's journal, after the engine ran it in preview mode. */
  readonly store: RunStore;
  readonly runId: string;
  /** Per connector: the binding digest (adapter, kind, connection and its account) and what to show about the sender. */
  readonly bindings: ReadonlyMap<string, { readonly digest: string; readonly sender: SenderView }>;
  readonly createdBy: string;
  readonly now: Date;
  readonly previewId?: string;
}

export async function buildPreview(a: BuildPreviewArgs): Promise<PreviewRecord> {
  const unknowable = unknowableSteps(a.component);
  const first = (await a.store.read(a.runId))[0];
  const fanout = (first?.data as { fanout?: { count: number } } | undefined)?.fanout;
  const runIds = fanout !== undefined ? Array.from({ length: fanout.count }, (_, i) => itemRunId(a.runId, i)) : [a.runId];
  const items: PreviewItem[] = [];
  for (const [index, id] of runIds.entries()) items.push(await itemOf(index, await a.store.read(id), a.bindings, unknowable));
  const counts = { sends: 0, no_effect: 0, stops: 0, not_exact: 0 };
  for (const it of items) counts[it.state]++;
  const inputDigest = digestOfJson(a.input);
  const root = rootOf({ definitionId: a.definitionId, certificateId: a.certificateId, inputDigest, leaves: items.map((i) => i.leaf) });
  return {
    v: 1,
    previewId: a.previewId ?? `pvw_${randomBytes(12).toString('hex')}`,
    definitionId: a.definitionId,
    certificateId: a.certificateId,
    inputDigest,
    input: a.input,
    forEach: fanout !== undefined,
    senders: [...a.bindings.values()].map((b) => b.sender),
    items,
    counts,
    effects: items.some((i) => i.actions.some((x) => x.sideEffect !== 'read')),
    root,
    createdBy: a.createdBy,
    createdAt: a.now.toISOString(),
    expiresAt: new Date(a.now.getTime() + PREVIEW_TTL_MS).toISOString(),
  };
}

export function rootOf(r: { definitionId: string; certificateId: string; inputDigest: string; leaves: readonly string[] }): string {
  return digestOfJson({ v: 1, definitionId: r.definitionId, certificateId: r.certificateId, input: r.inputDigest, leaves: r.leaves });
}

export function actionDigest(x: Omit<PreviewAction, 'digest' | 'args'>): string {
  return digestOfJson({
    step: x.step,
    connector: x.connector,
    operation: x.operation,
    sideEffect: x.sideEffect,
    binding: x.binding,
    args: x.argsDigest,
  });
}

async function itemOf(
  index: number,
  journal: readonly JournalEntry[],
  bindings: BuildPreviewArgs['bindings'],
  unknowable: ReadonlySet<string>,
): Promise<PreviewItem> {
  const actions: PreviewAction[] = [];
  const approvals: string[] = [];
  let escalation: { code?: string; message?: string } | undefined;
  let failed: string | undefined;
  for (const e of journal) {
    const d = e.data as Record<string, unknown>;
    if (e.type === 'shadow_action') {
      const args = (d['args'] ?? {}) as Record<string, unknown>;
      const connector = String(d['connector']);
      const base = {
        step: String(d['step']),
        connector,
        operation: String(d['operation']),
        sideEffect: (d['sideEffect'] ?? 'write') as PreviewAction['sideEffect'],
        binding: bindings.get(connector)?.digest ?? 'unbound',
        argsDigest: digestOfJson(args),
      };
      actions.push({ ...base, digest: actionDigest(base), args });
    } else if (e.type === 'preview_approval') approvals.push(String(d['step']));
    else if (e.type === 'escalation') escalation = d as { code?: string; message?: string };
    else if (e.type === 'step_failed') failed = String(d['message'] ?? d['code'] ?? 'a step failed');
  }
  let state: PreviewItemState;
  let reason: string | undefined;
  const inexact = actions.find((x) => x.sideEffect !== 'read' && unknowable.has(x.step));
  if (escalation?.code === 'PREVIEW_NOT_EXACT') [state, reason] = ['not_exact', escalation.message];
  else if (inexact !== undefined)
    [state, reason] = ['not_exact', `step "${inexact.step}" uses the result of another call, so what it sends cannot be shown exactly`];
  else if (escalation !== undefined) [state, reason] = ['stops', escalation.message ?? escalation.code ?? 'stops for a person'];
  else if (failed !== undefined) [state, reason] = ['stops', failed];
  else state = actions.some((x) => x.sideEffect !== 'read') ? 'sends' : 'no_effect';
  const leaf = digestOfJson({ index, state, approvals, actions: actions.map((x) => x.digest) });
  return { index, state, ...(reason !== undefined ? { reason: reason.slice(0, 300) } : {}), approvals, actions, leaf };
}

/** Exceptions first (stops, then not exact), then what sends, then what does nothing; each in item order. */
export function exceptionsFirst(items: readonly PreviewItem[]): PreviewItem[] {
  const rank: Record<PreviewItemState, number> = { stops: 0, not_exact: 1, sends: 2, no_effect: 3 };
  return [...items].sort((a, b) => rank[a.state] - rank[b.state] || a.index - b.index);
}

// ---------------------------------------------------------------------------------------------------------- storage

async function writeJson(path: string, v: unknown, exclusive = false): Promise<void> {
  if (exclusive) {
    await writeFile(path, JSON.stringify(v), { flag: 'wx', mode: 0o600 });
    return;
  }
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(v), { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

const ID = /^(pvw|bap)_[0-9a-f]{24}$/;

export class BatchStore {
  constructor(private readonly dir: string) {}

  async putPreview(p: PreviewRecord): Promise<void> {
    await mkdir(join(this.dir, 'previews'), { recursive: true });
    await writeJson(join(this.dir, 'previews', `${p.previewId}.json`), p);
  }

  /** UW-16a: an exclusive create, so two instances preparing one slot's preview prepare one. */
  async putPreviewOnce(p: PreviewRecord): Promise<'created' | 'exists'> {
    await mkdir(join(this.dir, 'previews'), { recursive: true });
    try {
      await writeJson(join(this.dir, 'previews', `${p.previewId}.json`), p, true);
      return 'created';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw e;
    }
  }

  async getPreview(previewId: string): Promise<PreviewRecord> {
    const p = ID.test(previewId) ? await readJson<PreviewRecord>(join(this.dir, 'previews', `${previewId}.json`)) : undefined;
    if (p === undefined) throw new NotFoundError(`batch preview "${previewId}"`);
    return p;
  }

  /** UW-12b: every preview of this definition, newest first (the inbox filters them). An unreadable file is skipped. */
  async listPreviews(): Promise<PreviewRecord[]> {
    const names = await readdir(join(this.dir, 'previews')).catch(() => [] as string[]);
    const out: PreviewRecord[] = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, '');
      if (!ID.test(id)) continue;
      const p = await readJson<PreviewRecord>(join(this.dir, 'previews', n)).catch(() => undefined);
      if (p !== undefined) out.push(p);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** At most one approval per preview: the first one stands. */
  async putApproval(a: BatchApprovalRecord): Promise<void> {
    await mkdir(join(this.dir, 'approvals'), { recursive: true });
    try {
      await writeJson(join(this.dir, 'approvals', `${a.payload.previewId}.json`), a, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new XoError(ErrorCode.ALREADY_EXISTS, 'this preview was already approved; prepare a new preview to approve again');
      throw e;
    }
  }

  async getApprovalOfPreview(previewId: string): Promise<BatchApprovalRecord | undefined> {
    return ID.test(previewId) ? readJson<BatchApprovalRecord>(join(this.dir, 'approvals', `${previewId}.json`)) : undefined;
  }

  async getApproval(approvalId: string): Promise<BatchApprovalRecord> {
    const index = ID.test(approvalId)
      ? await readJson<{ previewId: string }>(join(this.dir, 'approval-ids', `${approvalId}.json`))
      : undefined;
    const a = index !== undefined ? await this.getApprovalOfPreview(index.previewId) : undefined;
    if (a === undefined) throw new NotFoundError(`batch approval "${approvalId}"`);
    return a;
  }

  async indexApproval(approvalId: string, previewId: string): Promise<void> {
    await mkdir(join(this.dir, 'approval-ids'), { recursive: true });
    await writeJson(join(this.dir, 'approval-ids', `${approvalId}.json`), { previewId }, true);
  }

  /**
   * Uses the approval once: an exclusive create, so of two requests (or two processes) only one consumes it. The same run id again is
   * the same use (a retried start); any other run is refused.
   */
  async consume(approvalId: string, runId: string, by: string): Promise<'consumed' | 'same_run'> {
    await mkdir(join(this.dir, 'consumed'), { recursive: true });
    const path = join(this.dir, 'consumed', `${approvalId}.json`);
    try {
      await writeJson(path, { approvalId, runId, by, at: new Date().toISOString() } satisfies ConsumedRecord, true);
      return 'consumed';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const prior = await readJson<ConsumedRecord>(path);
      if (prior?.runId === runId) return 'same_run';
      throw new XoError(
        ErrorCode.BATCH_APPROVAL_REFUSED,
        `batch approval ${approvalId} was already used for run ${prior?.runId ?? 'another run'}; approvals are single-use`,
      );
    }
  }

  /** UW-16b: an approval that has not been used can be revoked; the record is created exclusively (the first stands). */
  async revokeApproval(r: RevokedApprovalRecord): Promise<RevokedApprovalRecord> {
    await mkdir(join(this.dir, 'revoked'), { recursive: true });
    const path = join(this.dir, 'revoked', `${r.approvalId}.json`);
    try {
      await writeJson(path, r, true);
      return r;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return (await readJson<RevokedApprovalRecord>(path)) ?? r;
    }
  }

  async revokedApproval(approvalId: string): Promise<RevokedApprovalRecord | undefined> {
    return ID.test(approvalId) ? readJson<RevokedApprovalRecord>(join(this.dir, 'revoked', `${approvalId}.json`)) : undefined;
  }

  async consumedBy(approvalId: string): Promise<ConsumedRecord | undefined> {
    return ID.test(approvalId) ? readJson<ConsumedRecord>(join(this.dir, 'consumed', `${approvalId}.json`)) : undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------- signing

export function signBatchApproval(payload: BatchApprovalPayload, key: { keyId: string; privateKeyPem: string }): BatchApprovalRecord {
  const signature = edSign(null, Buffer.from(canonicalJson(payload as never)), key.privateKeyPem).toString('base64');
  return { payload, signature, keyId: key.keyId };
}

export const newBatchApprovalId = (): string => `bap_${randomBytes(12).toString('hex')}`;
