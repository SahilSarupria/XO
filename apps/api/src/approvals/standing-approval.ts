import { createHash, randomBytes, sign as edSign } from 'node:crypto';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import { canonicalJson, type WorkflowComponent } from '@xo/workflow-ir';
import { approvalKeyring, currentPublicKeys, verifyJournaledDecision } from '../pre-execution/approval-keys.js';
import { safeId } from '../audit/audit-service.js';
import {
  bindingIdentities,
  computePreview,
  inputFromSource,
  requireStartable,
  runsDir,
  startGeneratedRun,
  type AuditDraft,
  type RunnerDeps,
} from '../routes/generated-run-routes.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import { workspaceCertificatesStore } from '../routes/readiness-routes.js';
import { componentSha256 } from '../runs/run-manifest.js';
import type { ItemSourceRef } from '../source-connections/items-from-sources.js';
import { roleAllows } from '../workspace/permissions.js';
import { roleOf, type WorkspaceRecord } from '../workspace/workspace.js';
import {
  BatchStore,
  batchDir,
  digestOfJson,
  signBatchApproval,
  slotPreviewId,
  type BatchApprovalPayload,
  type PreviewRecord,
} from './batch-approval.js';
import {
  STANDING_MAX_DAYS,
  StandingStore,
  checkBounds,
  derivedArguments,
  newStandingId,
  periodKey,
  valueDigest,
  type ArgumentRef,
  type PinnedArgument,
  type StandingApprovalPayload,
  type StandingApprovalRecord,
  type StandingLimits,
  type StandingPolicy,
  type StandingProposal,
  type StandingReason,
  type StandingRecord,
  type StandingStatus,
  type StandingTrigger,
} from './standing-store.js';

/**
 * UW-16 (ADR 0051): the flows of a standing approval: propose, approve, start under it, revoke, ask for changes. The types, the bounds
 * check and the storage are in `standing-store.ts`.
 *
 * Nothing here weakens ADR 0046. A start under a standing approval mints an ordinary batch approval for its own preview (payload v3,
 * signed as the standing approver's decision) and starts through `startGeneratedRun` with it, so the start check, the decision at each
 * approval step and the check before each call all run as for any batch. Anything outside the bounds falls back to an ordinary batch
 * preview that waits for a person.
 */

const HEX24 = 24;

export type Auth = { readonly credential?: string } | undefined;

const refuse = (reason: string, message: string): never => {
  throw new XoError(ErrorCode.STANDING_APPROVAL_REFUSED, message, { context: { reason } });
};

const target = (ws: WorkspaceRecord, definition: WorkflowDefinitionRecord) =>
  ({ kind: 'standing-approval', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: ws.workspaceId }) as never;

function int(v: unknown, lo: number, hi: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `${name} must be a whole number from ${lo} to ${hi}`);
  return v;
}

export function parseLimits(v: unknown): StandingLimits {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'limits must be an object');
  const o = v as Record<string, unknown>;
  const known = new Set(['maxItemsPerRun', 'maxItemsPerPeriod', 'maxRunsPerPeriod', 'period', 'maxExcludedRows']);
  const stray = Object.keys(o).filter((k) => !known.has(k));
  if (stray.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown limit(s): ${stray.join(', ')}`);
  const maxItemsPerRun = int(o['maxItemsPerRun'], 1, 10_000, 'maxItemsPerRun');
  const maxItemsPerPeriod = int(o['maxItemsPerPeriod'], maxItemsPerRun, 100_000, 'maxItemsPerPeriod');
  const maxRunsPerPeriod = int(o['maxRunsPerPeriod'], 1, 1000, 'maxRunsPerPeriod');
  const maxExcludedRows = o['maxExcludedRows'] === undefined ? 0 : int(o['maxExcludedRows'], 0, 10_000, 'maxExcludedRows');
  if (o['period'] !== 'day' && o['period'] !== 'week' && o['period'] !== 'month')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'period must be "day", "week" or "month"');
  return { maxItemsPerRun, maxItemsPerPeriod, maxRunsPerPeriod, period: o['period'], maxExcludedRows };
}

/** Who may review in this workspace: the owner and each member whose role allows it. */
const reviewers = (ws: WorkspaceRecord): string[] =>
  [ws.identityId, ...(ws.members ?? []).map((m) => m.identityId)].filter((id) => {
    const role = roleOf(ws, id);
    return role !== undefined && roleAllows(role, 'review');
  });

// ---------------------------------------------------------------------------------------------------------- propose

export interface ProposeStanding {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly certificateId: unknown;
  readonly workflow?: { readonly workflowId: string; readonly version: number };
  readonly items?: ItemSourceRef;
  readonly input?: Record<string, unknown>;
  readonly limits: unknown;
  readonly mayVary?: readonly ArgumentRef[];
  readonly presignSteps?: readonly string[];
  readonly triggers: readonly StandingTrigger[];
  readonly expiresInDays?: unknown;
  readonly startsAs?: string;
  readonly note?: unknown;
  readonly correlationId: string;
}

/** The record a person sees and decides on. It carries counts of pinned values, never the values. */
export function standingView(r: StandingRecord, store: StandingStore, now: Date): Record<string, unknown> {
  const p = r.proposal.policy;
  return {
    standingApprovalId: p.standingApprovalId,
    status: store.status(r, now),
    definitionId: p.definitionId,
    ...(p.workflow !== undefined ? { workflow: p.workflow } : {}),
    certificateId: p.certificate.certificateId,
    policyDigest: r.proposal.policyDigest,
    items:
      p.items.kind === 'source'
        ? { kind: 'source', connectionId: p.items.connectionId, proposalId: p.items.proposalId }
        : { kind: 'input' },
    effects: p.effects,
    pinned: p.pinned.map((x) => ({ step: x.step, argument: x.argument, count: x.values.length })),
    mayVary: p.mayVary,
    presignSteps: p.presignSteps,
    limits: p.limits,
    triggers: p.triggers,
    startsAs: p.startsAs,
    notBefore: p.notBefore,
    expiresAt: p.expiresAt,
    sample: p.sample,
    proposedBy: r.proposal.proposedBy.id,
    proposedAt: r.proposal.proposedAt,
    ...(r.proposal.note !== undefined ? { note: r.proposal.note } : {}),
    ...(r.approval !== undefined
      ? { approvedBy: r.approval.payload.reviewerId, approvedAt: r.approval.payload.at, selfApproved: r.approval.payload.selfApproved }
      : {}),
    ...(r.changes !== undefined ? { changesRequested: { comment: r.changes.comment, at: r.changes.at } } : {}),
    ...(r.revocation !== undefined ? { revoked: { at: r.revocation.at, reason: r.revocation.reason } } : {}),
  };
}

export async function proposeStanding(deps: RunnerDeps, p: ProposeStanding): Promise<Record<string, unknown>> {
  const { workspace, actor, definition } = p;
  if (actor.kind !== 'human') refuse('standing_requires_person', 'a standing approval is proposed by a person, not by a key or a service');
  const draft: AuditDraft = {
    action: 'standing-approval.propose',
    actor: actorFromPrincipal(actor),
    correlationId: p.correlationId,
    target: target(workspace, definition),
  };
  const certificateId = await requireStartable(deps, workspace, definition, p.certificateId, draft, p.workflow?.workflowId);
  const limits = parseLimits(p.limits);
  const days = p.expiresInDays === undefined ? 30 : int(p.expiresInDays, 1, STANDING_MAX_DAYS, 'expiresInDays');
  if (!Array.isArray(p.triggers) || p.triggers.length === 0 || !p.triggers.every((t) => t === 'manual' || t === 'schedule'))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'triggers must name "manual", "schedule" or both');
  const note = typeof p.note === 'string' ? p.note.slice(0, 500) : undefined;
  const startsAsId = p.startsAs ?? actor.id;
  if (startsAsId !== actor.id) {
    const role = roleOf(workspace, startsAsId);
    if (role === undefined || !roleAllows(role, 'author'))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'startsAs must be a person in this workspace who can author');
  }
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'this generated workflow has no definition to run');

  // The sample: an ordinary preview of today's items, stored as any preview is, and shown to the approver.
  const rest = p.input ?? {};
  let input: Record<string, unknown> = rest;
  let itemsSource: PreviewRecord['itemsSource'];
  if (p.items !== undefined) {
    const built = await inputFromSource(deps, workspace, definition, rest, p.items);
    input = built.input;
    itemsSource = built.itemsSource;
  }
  const preview0 = await computePreview(deps, workspace, definition, input, certificateId, actor.id);
  const sample: PreviewRecord = itemsSource !== undefined ? { ...preview0, itemsSource } : preview0;
  if (sample.counts.not_exact > 0)
    refuse('not_exact', `${sample.counts.not_exact} item(s) cannot be shown exactly, so a standing approval cannot cover them`);
  if (sample.counts.sends === 0) refuse('nothing_to_do', 'the sample has no item that sends or changes anything');

  // What is pinned: every argument a write or irreversible step takes from an item or the input, unless it may vary.
  const derived = derivedArguments(component);
  const vary = new Set((p.mayVary ?? []).map((x) => `${x.step}\u0000${x.argument}`));
  for (const k of vary)
    if (!derived.some((d) => `${d.step}\u0000${d.argument}` === k))
      refuse('unknown_argument', 'mayVary names an argument no step derives from an item');
  const pinned: PinnedArgument[] = [];
  for (const d of derived) {
    if (vary.has(`${d.step}\u0000${d.argument}`)) continue;
    const values = [
      ...new Set(
        sample.items.flatMap((i) =>
          i.actions
            .filter((a) => a.step === d.step && a.sideEffect !== 'read')
            .map((a) => valueDigest(workspace.workspaceId, a.args[d.argument])),
        ),
      ),
    ].sort();
    if (values.length > 10_000)
      refuse('too_many_values', 'more than 10,000 different values would be pinned; let some of them vary or split the work');
    pinned.push({ step: d.step, argument: d.argument, values });
  }
  for (const step of new Set(derived.filter((d) => d.sideEffect === 'irreversible').map((d) => d.step)))
    if (!pinned.some((x) => x.step === step))
      refuse('nothing_pinned', `step "${step}" cannot be undone, so at least one of its values must stay fixed to what you saw`);
  const mayVary = derived.filter((d) => vary.has(`${d.step}\u0000${d.argument}`)).map((d) => ({ step: d.step, argument: d.argument }));

  // Steps the approval also decides: named, each one the sample reaches (as in a batch approval).
  const reachable = new Set(sample.items.flatMap((i) => i.approvals));
  const named = p.presignSteps ?? [];
  if (named.length > 64 || new Set(named).size !== named.length || !named.every((x) => typeof x === 'string' && reachable.has(x)))
    refuse('presign_unknown_step', 'presignSteps must name approval steps the sample reaches, each once');

  const effects = [
    ...new Map(
      sample.items
        .flatMap((i) => i.actions)
        .filter((a) => a.sideEffect !== 'read')
        .map((a) => [
          `${a.connector}\u0000${a.operation}\u0000${a.sideEffect}`,
          { connector: a.connector, operation: a.operation, sideEffect: a.sideEffect as 'write' | 'irreversible' },
        ]),
    ).values(),
  ];
  const identities = await bindingIdentities(deps, workspace, component);
  const cert = await workspaceCertificatesStore(workspace, deps.dataConfig).get(certificateId);
  const over = component.workflows[0]?.forEach?.over;
  const restForDigest = over !== undefined ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== over)) : input;
  const now = new Date();
  const standingApprovalId = newStandingId();
  const policy: StandingPolicy = {
    v: 1,
    standingApprovalId,
    workspaceId: workspace.workspaceId,
    definitionId: definition.definitionId,
    componentSha256: componentSha256(component),
    ...(p.workflow !== undefined ? { workflow: p.workflow } : {}),
    certificate: { certificateId, digest: String(cert.digest) },
    bindings: Object.fromEntries([...identities].map(([k, v]) => [k, v.digest])),
    items:
      p.items !== undefined && itemsSource !== undefined
        ? { kind: 'source', connectionId: p.items.connectionId, proposalId: p.items.proposalId, over: itemsSource.over }
        : { kind: 'input', inputDigest: digestOfJson(input) },
    restInputDigest: digestOfJson(restForDigest),
    effects,
    pinned,
    mayVary,
    presignSteps: [...named].sort(),
    limits,
    triggers: [...new Set(p.triggers)].sort(),
    startsAs: { id: startsAsId, kind: 'human' },
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
    sample: { previewId: sample.previewId, root: sample.root, items: sample.items.length },
  };
  const bs = new BatchStore(batchDir(runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId)));
  await bs.putPreview({ ...sample, standingSample: true });
  const proposal: StandingProposal = {
    policy,
    policyDigest: digestOfJson(policy),
    proposedBy: { id: actor.id, kind: actor.kind },
    proposedAt: now.toISOString(),
    ...(note !== undefined && note.length > 0 ? { note } : {}),
  };
  const store = new StandingStore(deps.dataConfig.dataRootDir, workspace.workspaceId);
  await store.propose(proposal);
  await deps.audit?.tryRecord({
    ...draft,
    type: 'standing-approval.proposed',
    outcome: 'completed',
    metadata: {
      standingApprovalId,
      items: sample.items.length,
      pinned: pinned.length,
      mayVary: mayVary.length,
      days,
    },
  });
  return standingView({ proposal }, store, now);
}

// ---------------------------------------------------------------------------------------------------------- approve

export interface ApproveStanding {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  /** `req.authentication`: an API key is never an approver. */
  readonly auth: Auth;
  readonly definition: WorkflowDefinitionRecord;
  readonly id: string;
  readonly policyDigest: unknown;
  readonly correlationId: string;
  readonly now?: Date;
}

/** The caller has already been checked for the review permission and a recent sign-in. */
export async function approveStanding(deps: RunnerDeps, a: ApproveStanding): Promise<Record<string, unknown>> {
  const { workspace, actor, definition } = a;
  const store = new StandingStore(deps.dataConfig.dataRootDir, workspace.workspaceId);
  const rec = await store.get(a.id);
  const draft: AuditDraft = {
    action: 'standing-approval.approve',
    actor: actorFromPrincipal(actor),
    correlationId: a.correlationId,
    target: target(workspace, definition),
  };
  const denied = async (reason: string, message: string): Promise<never> => {
    await deps.audit?.tryRecord({
      ...draft,
      type: 'standing-approval.refused',
      outcome: 'denied',
      reasonCode: reason,
      metadata: { standingApprovalId: a.id },
    });
    return refuse(reason, message);
  };
  const now = a.now ?? new Date();
  if (actor.kind !== 'human' || a.auth === undefined || a.auth.credential === 'api-key')
    return denied('standing_requires_person', 'a standing approval is approved by a person who signed in, not by a key or a service');
  if (store.status(rec, now) !== 'proposed') return denied('not_proposed', 'this standing approval is not waiting for a decision');
  if (a.policyDigest !== rec.proposal.policyDigest)
    return denied('policy_mismatch', 'this is not the standing approval you were shown (its digest differs); review the current one');
  const policy = rec.proposal.policy;
  const bs = new BatchStore(batchDir(runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId)));
  const sample = await bs.getPreview(policy.sample.previewId).catch(() => undefined);
  if (sample === undefined || Date.parse(sample.expiresAt) <= now.getTime())
    return denied('sample_expired', 'the sample this was proposed with has expired (24 hours); propose it again');
  // Separation of duties: not the proposer and not the person runs start as. Only when separation is off and nobody else may review
  // is a self-approval allowed, and then it is recorded and shown.
  let selfApproved = false;
  if (actor.id === rec.proposal.proposedBy.id || actor.id === policy.startsAs.id) {
    const others = reviewers(workspace).filter((id) => id !== rec.proposal.proposedBy.id && id !== policy.startsAs.id);
    if (deps.dataConfig.preExecution?.approvalSeparation === 'off' && others.length === 0) selfApproved = true;
    else
      return denied('separation_of_duties', 'someone other than the person who proposed this, and the person it runs as, must approve it');
  }
  const keys = await approvalKeyring(deps.dataConfig.dataRootDir, deps.env);
  const payload: StandingApprovalPayload = {
    v: 1,
    kind: 'standing',
    standingApprovalId: policy.standingApprovalId,
    policyDigest: rec.proposal.policyDigest,
    reviewerId: actor.id,
    selfApproved,
    at: now.toISOString(),
    expiresAt: policy.expiresAt,
  };
  const record: StandingApprovalRecord = {
    payload,
    signature: edSign(null, Buffer.from(canonicalJson(payload as never)), keys.active.privateKeyPem).toString('base64'),
    keyId: keys.active.keyId,
  };
  await store.approve(record);
  await deps.audit?.tryRecord({
    ...draft,
    type: 'standing-approval.approved',
    outcome: 'completed',
    metadata: { standingApprovalId: policy.standingApprovalId, selfApproved },
  });
  return standingView(await store.get(a.id), store, now);
}

// ---------------------------------------------------------------------------------------------------------- revoke, changes

export interface RevokeStanding {
  readonly workspace: WorkspaceRecord;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly definition?: WorkflowDefinitionRecord;
  readonly id: string;
  readonly reason: unknown;
  /** True when the caller holds the review permission. The proposer and the approver may revoke without it. */
  readonly canReview: boolean;
  readonly correlationId: string;
  readonly principal?: AuthenticatedPrincipal;
}

export async function revokeStanding(deps: RunnerDeps, r: RevokeStanding): Promise<Record<string, unknown>> {
  const store = new StandingStore(deps.dataConfig.dataRootDir, r.workspace.workspaceId);
  const rec = await store.get(r.id);
  const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason must be 1 to 500 characters');
  const mine = r.actor.id === rec.proposal.proposedBy.id || r.actor.id === rec.approval?.payload.reviewerId;
  if (!r.canReview && !mine)
    refuse('not_allowed', 'only a reviewer, the person who proposed it or the person who approved it can revoke it');
  const revoked = await store.revoke({
    standingApprovalId: r.id,
    by: { id: r.actor.id, kind: r.actor.kind },
    at: new Date().toISOString(),
    reason,
  });
  await deps.audit?.tryRecord({
    action: 'standing-approval.revoke',
    actor:
      r.principal !== undefined
        ? actorFromPrincipal(r.principal)
        : { identityId: r.actor.id, kind: r.actor.kind === 'operator' ? 'system' : (r.actor.kind as 'human') },
    correlationId: r.correlationId,
    target: { kind: 'standing-approval', id: 'standing-approval', workspaceId: r.workspace.workspaceId } as never,
    type: 'standing-approval.revoked',
    outcome: 'completed',
    metadata: { standingApprovalId: r.id },
  } as never);
  return standingView(await store.get(r.id), store, new Date(revoked.at));
}

export interface RequestStandingChanges {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly id: string;
  readonly comment: unknown;
  readonly correlationId: string;
}

export async function requestStandingChanges(deps: RunnerDeps, r: RequestStandingChanges): Promise<Record<string, unknown>> {
  const store = new StandingStore(deps.dataConfig.dataRootDir, r.workspace.workspaceId);
  const rec = await store.get(r.id);
  const comment = typeof r.comment === 'string' ? r.comment.trim() : '';
  if (comment.length < 1 || comment.length > 1000) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'comment must be 1 to 1000 characters');
  if (store.status(rec, new Date()) !== 'proposed') refuse('not_proposed', 'this standing approval is not waiting for a decision');
  await store.requestChanges(r.id, { by: { id: r.actor.id }, at: new Date().toISOString(), comment });
  await deps.audit?.tryRecord({
    action: 'standing-approval.request-changes',
    actor: actorFromPrincipal(r.actor),
    correlationId: r.correlationId,
    target: { kind: 'standing-approval', id: 'standing-approval', workspaceId: r.workspace.workspaceId } as never,
    type: 'standing-approval.changes-requested',
    outcome: 'completed',
    metadata: { standingApprovalId: r.id },
  } as never);
  return standingView(await store.get(r.id), store, new Date());
}

// ---------------------------------------------------------------------------------------------------------- use

export interface StartUnderStanding {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly id: string;
  readonly trigger: StandingTrigger;
  /** The input the run is given besides its items (a schedule's input, or the request's). */
  readonly input: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly correlationId: string;
  readonly now?: Date;
}

type Started = { readonly status: number; readonly body: Record<string, unknown> };

const STATUS_REASON: Record<Exclude<StandingStatus, 'active'>, StandingReason> = {
  proposed: 'not_approved',
  changes_requested: 'not_approved',
  expired: 'expired',
  revoked: 'revoked',
};

/**
 * A start under a standing approval. Refusals that mean the approval cannot be relied on at all (a bad signature, someone else
 * starting, a changed definition or certificate) prepare nothing. Everything else that is outside the bounds falls back to an ordinary
 * batch preview that waits in the Inbox: nothing is sent until a person approves it.
 */
export async function startUnderStanding(deps: RunnerDeps, s: StartUnderStanding): Promise<Started> {
  const { workspace, actor, definition } = s;
  const now = s.now ?? new Date();
  const store = new StandingStore(deps.dataConfig.dataRootDir, workspace.workspaceId);
  const rec = await store.get(s.id);
  const policy = rec.proposal.policy;
  const draft: AuditDraft = {
    action: 'standing-approval.use',
    actor: actorFromPrincipal(actor),
    correlationId: s.correlationId,
    target: target(workspace, definition),
  };
  const denied = async (reason: string, message: string): Promise<never> => {
    await deps.audit?.tryRecord({
      ...draft,
      type: 'standing-approval.refused',
      outcome: 'denied',
      reasonCode: reason,
      metadata: { standingApprovalId: s.id },
    });
    return refuse(reason, message);
  };
  if (policy.definitionId !== definition.definitionId) throw new NotFoundError(`standing approval "${s.id}"`);
  // 1. The approval verifies, and the policy is the one that was approved.
  if (rec.approval !== undefined) {
    const verified = verifyJournaledDecision(
      rec.approval.payload as unknown as Record<string, unknown>,
      rec.approval.signature,
      await currentPublicKeys(deps.dataConfig.dataRootDir),
    );
    if (
      verified === undefined ||
      digestOfJson(policy) !== rec.approval.payload.policyDigest ||
      rec.proposal.policyDigest !== rec.approval.payload.policyDigest
    )
      return denied('signature', 'the standing approval does not verify under the approval keyring');
  }
  // 2. Only the named starter, through an allowed trigger, while they can still author.
  if (actor.id !== policy.startsAs.id) return denied('starter_mismatch', 'this standing approval is for another person to start');
  if (!policy.triggers.includes(s.trigger))
    return denied('trigger_not_allowed', `this standing approval does not allow a start by ${s.trigger}`);
  const role = roleOf(workspace, actor.id);
  if (role === undefined || !roleAllows(role, 'author'))
    return denied('starter_not_author', 'the person this runs as can no longer author in this workspace');
  // 3. The definition and certificate are the ones that were approved. The certificate gate is the same as for any start.
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined || componentSha256(component) !== policy.componentSha256)
    return denied('definition_changed', 'the workflow changed since this was approved; propose a new standing approval');
  const certificateId = await requireStartable(
    deps,
    workspace,
    definition,
    policy.certificate.certificateId,
    draft,
    policy.workflow?.workflowId,
  );
  const cert = await workspaceCertificatesStore(workspace, deps.dataConfig).get(certificateId);
  if (String(cert.digest) !== policy.certificate.digest)
    return denied('certificate_changed', 'the readiness certificate changed since this was approved; propose a new standing approval');

  // 4/5. The items and the preview of this run.
  const status = store.status(rec, now);
  const reasons: StandingReason[] = [];
  if (status !== 'active') reasons.push(STATUS_REASON[status]);
  else if (Date.parse(policy.notBefore) > now.getTime()) reasons.push('not_yet_valid');
  let input: Record<string, unknown> = s.input;
  let itemsSource: PreviewRecord['itemsSource'];
  if (policy.items.kind === 'source') {
    try {
      const built = await inputFromSource(deps, workspace, definition, s.input, {
        connectionId: policy.items.connectionId,
        proposalId: policy.items.proposalId,
      });
      input = built.input;
      itemsSource = built.itemsSource;
    } catch (e) {
      if (!(e instanceof XoError)) throw e;
      return denied('source_unavailable', `the items cannot be built from the source this was approved for: ${e.message}`);
    }
  }
  const previewId = slotPreviewId(
    definition.definitionId,
    `standing\u0000${s.id}\u0000${s.idempotencyKey ?? randomBytes(8).toString('hex')}`,
  );
  const bs = new BatchStore(batchDir(runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId)));
  const computed = await computePreview(deps, workspace, definition, input, certificateId, policy.startsAs.id, previewId);
  const preview: PreviewRecord = itemsSource !== undefined ? { ...computed, itemsSource } : computed;
  const identities = await bindingIdentities(deps, workspace, component);
  reasons.push(
    ...checkBounds(policy, preview, workspace.workspaceId, new Map([...identities].map(([k, v]) => [k, v.digest])), s.input, input),
  );

  // 6/7. Count it (fail closed): reserve, then sum; over a limit, take the reservation back and fall back.
  const approvalId = `bap_${createHash('sha256').update(`${s.id}\u0000${previewId}`).digest('hex').slice(0, HEX24)}`;
  const runId = `run_${createHash('sha256').update(`batch\u0000${approvalId}`).digest('hex').slice(0, 32)}`;
  const key = periodKey(policy.limits.period, now);
  if (reasons.length === 0) {
    await store.reserve(s.id, { runId, approvalId, items: preview.items.length, periodKey: key, at: now.toISOString() });
    const used = await store.usesIn(s.id, key);
    if (used.items > policy.limits.maxItemsPerPeriod) reasons.push('period_items');
    if (used.runs > policy.limits.maxRunsPerPeriod) reasons.push('period_runs');
    if (reasons.length > 0) await store.release(s.id, runId);
  }
  // 8. Outside the bounds: an ordinary batch waits for a person.
  if (reasons.length > 0) {
    const nothing = reasons.length === 1 && reasons[0] === 'nothing_to_do';
    let fellBackTo: string | undefined;
    if (!nothing) {
      const stored: PreviewRecord = { ...preview, standingFallback: { standingApprovalId: s.id, reasons } };
      await bs.putPreviewOnce(stored);
      fellBackTo = previewId;
    }
    await store.fallback(s.id, {
      at: now.toISOString(),
      trigger: s.trigger,
      reasons,
      ...(fellBackTo !== undefined ? { previewId: fellBackTo } : {}),
    });
    await deps.audit?.tryRecord({
      ...draft,
      type: 'standing-approval.fallback',
      outcome: 'completed',
      metadata: {
        standingApprovalId: s.id,
        ...(fellBackTo !== undefined ? { previewId: fellBackTo } : {}),
        reasons: reasons.join(','),
        items: preview.items.length,
      },
    });
    return { status: 202, body: { fallback: true, reasons, ...(fellBackTo !== undefined ? { previewId: fellBackTo } : {}) } };
  }
  // 9. Inside the bounds: mint the batch approval for this preview and start with it; every UW-8 check runs again inside.
  const approval = rec.approval!;
  await bs.putPreviewOnce(preview);
  const keys = await approvalKeyring(deps.dataConfig.dataRootDir, deps.env);
  const payload: BatchApprovalPayload = {
    v: 3,
    kind: 'batch',
    approvalId,
    previewId: preview.previewId,
    root: preview.root,
    definitionId: definition.definitionId,
    certificateId,
    inputDigest: preview.inputDigest,
    items: preview.items.length,
    reviewerId: approval.payload.reviewerId,
    at: now.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(preview.expiresAt), Date.parse(policy.expiresAt))).toISOString(),
    presignSteps: [...policy.presignSteps].sort(),
    standing: { standingApprovalId: s.id, policyDigest: rec.proposal.policyDigest },
  };
  await bs.putApproval(signBatchApproval(payload, keys.active)).catch((e) => {
    if (!(e instanceof XoError && e.code === ErrorCode.ALREADY_EXISTS)) throw e; // the same start again: the first record stands
  });
  await bs.indexApproval(approvalId, preview.previewId).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
  await deps.audit?.tryRecord({
    ...draft,
    type: 'standing-approval.used',
    outcome: 'completed',
    metadata: { standingApprovalId: s.id, approvalId, items: preview.items.length },
  });
  return startGeneratedRun(deps, {
    workspace,
    actor,
    definition,
    input: {},
    certificateId,
    correlationId: s.correlationId,
    batchApprovalId: approvalId,
    ...(policy.workflow !== undefined ? { workflow: policy.workflow } : {}),
  });
}
