import { resolveDataReads } from '../drift/data-drift.js';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { eraseTokenVault } from '../protection/data-protection.js';
import { ApprovalError, RunInputError, RunStore } from '@xo/workflow-runtime';
import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import type { WorkflowReadinessCertificate } from '@xo/pre-execution';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  requirePrincipal,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import { FsConversationStore, CONVERSATION_ID_PATTERN, type Conversation } from '../intelligence/conversation-store.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { StartRefusedError } from '../workflow-controls/service.js';
import { generateDefinition, parseGoal, workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';
import { issueCertificate, workspaceCertificatesStore } from './readiness-routes.js';
import {
  cancelGeneratedRun,
  decideGeneratedApproval,
  readMeta,
  reconcileGeneratedEffect,
  runsDir,
  startGeneratedRun,
  type RunnerDeps,
} from './generated-run-routes.js';
import { delegateStep } from '../control/outcomes.js';
import { runEvidence, runOutputs } from '../control/run-views.js';
import { observationsOf } from '../learning/observations.js';
import { proposeFromObservations, recordCorrection } from '../learning/service.js';
import { workspaceWorkflowEntitiesStore, type FsWorkflowEntityStore } from '../workflow-entities/entity-store.js';
import { generatedRunPort, type WorkflowRunPort, type WorkflowRunView } from '../workflow-entities/run-port.js';
import {
  MAX_VERSIONS,
  WORKFLOW_ID,
  WORKFLOW_LIFECYCLE,
  currentVersion,
  deriveLifecycle,
  onlyFields,
  parseName,
  parseNote,
  type Actor,
  type ConversationRef,
  type GeneratedDefinitionRef,
  type WorkflowEntity,
  type WorkflowLifecycle,
  type WorkflowVersion,
} from '../workflow-entities/entity.js';

/**
 * UW-2 (ADR 0032) — the Workflow entity API, the control surface thin clients (Studio on desktop and phone, a messaging
 * channel later) use to create, find, follow and act on a piece of work.
 *
 * Every action delegates to the same functions the generated-workflow routes use (generation, readiness, start, decision), so
 * a workflow started here passes exactly the same certificate gate, pause check, run-time effect authorization (ADR 0031) and
 * audit as one started there. Reading needs `read`; changing a workflow, issuing a certificate and starting a run need
 * `author`; deciding an approval needs `review` and a recent sign-in.
 *
 * Privacy (ADR 0013): conversations are private to the person who started them. Anyone who may read the workspace may read
 * its workflows (an approver must be able to see what they approve), but only the conversation's owner sees which
 * conversation and message a workflow came from; others see only that it came from one. Listing a conversation's workflows
 * needs ownership of the conversation (404 otherwise, the same as for an unknown conversation).
 */

const BASE = '/workspaces/:workspaceId/workflow-entities';
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const MAX_RUNS_IN_VIEW = 50;
const MAX_WAIT_SECONDS = 25;

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      // The same mapping as the generated-workflow routes: the engine's refusals are the caller's to fix, not server errors.
      if (cause instanceof RunInputError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { problems: [...cause.problems] } }));
      if (cause instanceof ApprovalError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { reason: cause.code } }));
      return errorToResponse(cause);
    }
  };
}

const actorOf = (p: AuthenticatedPrincipal): Actor => ({ id: p.id, kind: p.kind });

function versionFrom(definition: WorkflowDefinitionRecord, version: number, by: Actor, at: Date, note?: string): WorkflowVersion {
  const ref: GeneratedDefinitionRef = {
    kind: 'generated',
    definitionId: definition.definitionId,
    definitionDigest: definition.lowered.definitionDigest,
    compilationId: definition.compilationId,
    candidateWorkflowId: definition.candidateWorkflowId,
    ...(definition.intentTraceDigest !== undefined ? { intentTraceDigest: definition.intentTraceDigest } : {}),
  };
  return {
    version,
    definition: ref,
    goalText: definition.goal.text,
    createdAt: at.toISOString(),
    createdBy: by,
    ...(note !== undefined ? { note } : {}),
  };
}

function encodeCursor(e: WorkflowEntity): string {
  return Buffer.from(JSON.stringify([e.updatedAt, e.workflowId]), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): readonly [string, string] {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new XoError(ErrorCode.INVALID_ARGUMENT, 'cursor must come from an earlier page');
}

function intParam(raw: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function registerWorkflowEntityRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  permissionManager: PermissionManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const auditCtx = { audit, workspaceStore };
  const deps: RunnerDeps = { workspaceStore, dataConfig, permissionManager, env, audit };
  const entities = (w: WorkspaceRecord): FsWorkflowEntityStore => workspaceWorkflowEntitiesStore(dataConfig.dataRootDir, w.workspaceId);
  const conversations = (w: WorkspaceRecord) => new FsConversationStore(workspaceStateStore(w, dataConfig), w.workspaceId);
  const port = (w: WorkspaceRecord): WorkflowRunPort => generatedRunPort(deps, w);

  /** The caller's own conversation, or 404 (an unknown id and someone else's look the same). */
  async function ownConversation(req: ApiRequest, w: WorkspaceRecord, id: unknown): Promise<Conversation> {
    if (typeof id !== 'string' || !CONVERSATION_ID_PATTERN.test(id)) {
      // ADR 0013: a workflow may originate only from a `cnv_` conversation; a `cht_` thread is refused explicitly.
      if (typeof id === 'string' && id.startsWith('cht_'))
        throw new XoError(
          ErrorCode.INVALID_ARGUMENT,
          'workflows link only to conversations (cnv_…); Studio chat threads (cht_…) are deprecated',
        );
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'conversationId must be a conversation id (cnv_…)');
    }
    const c = await conversations(w).get(id);
    if (c === undefined || c.ownerIdentityId !== callerIdentityId(req)) throw new NotFoundError(`conversation "${id}"`);
    return c;
  }

  /** Per request: the facts every lifecycle derivation needs, read once. */
  async function lifecycleContext(w: WorkspaceRecord) {
    const [certificates, controls] = await Promise.all([
      workspaceCertificatesStore(w, dataConfig).list(),
      new FsControlsStore(workspaceStateStore(w, dataConfig), w.workspaceId).getControls(),
    ]);
    const latestCertificate = new Map<string, WorkflowReadinessCertificate>();
    for (const c of certificates) {
      const id = c.scope.definitionId;
      if (id === undefined) continue;
      const prev = latestCertificate.get(id);
      if (prev === undefined || prev.issuedAt < c.issuedAt) latestCertificate.set(id, c);
    }
    return { latestCertificate, workspacePaused: controls.paused };
  }
  type LifecycleContext = Awaited<ReturnType<typeof lifecycleContext>>;

  function lifecycleOf(entity: WorkflowEntity, runs: readonly WorkflowRunView[], lc: LifecycleContext): WorkflowLifecycle {
    const cert = lc.latestCertificate.get(currentVersion(entity).definition.definitionId);
    return deriveLifecycle({
      entity,
      runs,
      workspacePaused: lc.workspacePaused,
      ...(cert !== undefined ? { currentCertificateStatus: cert.status } : {}),
    });
  }

  /** Who may see the conversation link: its owner. Everyone else sees only that one exists. */
  async function originFor(req: ApiRequest, w: WorkspaceRecord, e: WorkflowEntity) {
    const c = e.origin.conversation;
    if (c === undefined) return { via: e.origin.via, createdBy: e.origin.createdBy, createdAt: e.origin.createdAt };
    const conv = await conversations(w).get(c.conversationId);
    const owner = conv?.ownerIdentityId ?? e.origin.createdBy.id;
    const conversation =
      owner === callerIdentityId(req) ? { ...c, available: conv !== undefined } : { store: c.store, linked: true as const };
    return { via: e.origin.via, conversation, createdBy: e.origin.createdBy, createdAt: e.origin.createdAt };
  }

  function summaryOf(req: ApiRequest, e: WorkflowEntity, runs: readonly WorkflowRunView[], lc: LifecycleContext) {
    const latest = runs[0];
    const ownsOrigin = e.origin.conversation !== undefined && e.origin.createdBy.id === callerIdentityId(req);
    return {
      workflowId: e.workflowId,
      name: e.name,
      lifecycle: lifecycleOf(e, runs, lc),
      revision: e.revision,
      currentVersion: currentVersion(e).version,
      pendingApprovals: runs.reduce((n, r) => n + r.pendingApprovals, 0),
      ...(latest !== undefined ? { latestRun: { runId: latest.runId, state: latest.state, startedAt: latest.startedAt } } : {}),
      ...(ownsOrigin ? { conversationId: e.origin.conversation!.conversationId } : {}),
      paused: e.paused,
      archived: e.archived,
      updatedAt: e.updatedAt,
    };
  }

  async function detailOf(req: ApiRequest, w: WorkspaceRecord, e: WorkflowEntity) {
    const [runs, lc, history] = await Promise.all([port(w).runsOf(e), lifecycleContext(w), entities(w).history(e.workflowId)]);
    const cur = currentVersion(e);
    const cert = lc.latestCertificate.get(cur.definition.definitionId);
    return {
      workflowId: e.workflowId,
      name: e.name,
      revision: e.revision,
      lifecycle: lifecycleOf(e, runs, lc),
      paused: e.paused,
      archived: e.archived,
      workspacePaused: lc.workspacePaused,
      origin: await originFor(req, w, e),
      currentVersion: {
        ...cur,
        ...(cert !== undefined ? { certificate: { certificateId: cert.certificateId, status: cert.status, issuedAt: cert.issuedAt } } : {}),
      },
      versions: e.versions,
      pendingApprovals: runs.flatMap((r) =>
        r.approvals.map((a) => ({ runId: r.runId, version: r.version, approvalId: a.approvalId, step: a.step, summary: a.summary })),
      ),
      runs: runs.slice(0, MAX_RUNS_IN_VIEW),
      runsTotal: runs.length,
      history: history.map((h) => ({ revision: h.revision, ...h.event })),
      updatedAt: e.updatedAt,
      updatedBy: e.updatedBy,
    };
  }

  async function record(
    actor: AuthenticatedPrincipal,
    w: WorkspaceRecord,
    correlationId: string,
    type: AuditEventDraft['type'],
    e: WorkflowEntity,
    metadata: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    await audit.tryRecord({
      action: type,
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow-entity', id: e.workflowId, workspaceId: w.workspaceId },
      type,
      outcome: 'completed',
      metadata: { revision: e.revision, version: currentVersion(e).version, ...metadata },
    });
  }

  /** The definition a create or new-version request names: an existing generated one, or one generated now from a goal. */
  async function definitionFor(
    req: ApiRequest,
    w: WorkspaceRecord,
    body: Record<string, unknown>,
    defaults: {
      readonly compilationId?: string;
      readonly goalText?: string;
      readonly goal?: Omit<WorkflowDefinitionRecord['goal'], 'schema' | 'statedBy'>;
    },
  ): Promise<{ readonly definition: WorkflowDefinitionRecord | null; readonly selection?: unknown; readonly gaps?: readonly unknown[] }> {
    const actor = requirePrincipal(req);
    if (body['definitionId'] !== undefined) {
      if (body['goal'] !== undefined || body['compilationId'] !== undefined || body['workflowId'] !== undefined)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'give either definitionId, or compilationId with a goal');
      if (typeof body['definitionId'] !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'definitionId must be a string');
      return { definition: await workspaceDefinitionsStore(w, dataConfig).get(body['definitionId']) };
    }
    const compilationId = body['compilationId'] ?? defaults.compilationId;
    if (typeof compilationId !== 'string' || compilationId.length === 0)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'compilationId (the compiled sources to build the workflow from) is required');
    const rawGoal = body['goal'] ?? defaults.goal ?? (defaults.goalText !== undefined ? { text: defaults.goalText } : undefined);
    if (rawGoal === undefined)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'goal is required (or messageId, to use that message of the conversation as the goal)');
    const goal = parseGoal(rawGoal, actor.id);
    if (body['workflowId'] !== undefined && typeof body['workflowId'] !== 'string')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'workflowId must be a string');
    return generateDefinition(
      w,
      dataConfig,
      actor,
      compilationId,
      goal,
      body['workflowId'] as string | undefined,
      'structured',
      [],
      await resolveDataReads(w, dataConfig, body['reads']),
    );
  }

  async function readBody(req: ApiRequest): Promise<Record<string, unknown>> {
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const v = body.value ?? {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'body must be an object');
    return v;
  }

  function expectedRevision(body: Record<string, unknown>): number | undefined {
    const v = body['expectedRevision'];
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || (v as number) < 1)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'expectedRevision must be a whole number from 1');
    return v as number;
  }

  // ---- create, list, read ----

  async function create(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'workflow-entity.create', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'create a workflow' });
    const body = await readBody(req);
    onlyFields(body, ['name', 'conversationId', 'messageId', 'compilationId', 'goal', 'workflowId', 'definitionId', 'note']);
    const actor = requirePrincipal(req);

    let conversation: ConversationRef | undefined;
    let prompt: string | undefined;
    if (body['conversationId'] !== undefined) {
      const c = await ownConversation(req, workspace, body['conversationId']);
      const messageId = body['messageId'];
      if (messageId !== undefined) {
        const m = typeof messageId === 'string' ? c.messages.find((x) => x.messageId === messageId) : undefined;
        if (m === undefined) throw new NotFoundError(`message "${String(messageId)}" in conversation "${c.conversationId}"`);
        if (m.role !== 'user')
          throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a workflow is created from a message the person wrote, not a reply');
        prompt = m.content;
      }
      conversation = {
        store: 'cnv',
        conversationId: c.conversationId,
        ...(typeof messageId === 'string' ? { messageId } : {}),
      };
    } else if (body['messageId'] !== undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'messageId needs its conversationId');

    const note = parseNote(body['note']);
    const generated = await definitionFor(req, workspace, body, prompt !== undefined ? { goalText: prompt } : {});
    // A goal that fits no workflow, or two equally, creates nothing: the response asks the one question instead (PX-6).
    if (generated.definition === null)
      return json(200, {
        workflow: null,
        selection: generated.selection,
        ...(generated.gaps !== undefined ? { gaps: generated.gaps } : {}),
      });
    const now = new Date();
    const by = actorOf(actor);
    const name = parseName(body['name'], generated.definition.workflowName || generated.definition.goal.text);
    const entity = await entities(workspace).create(
      {
        name,
        origin: {
          via: conversation !== undefined ? 'conversation' : 'api',
          ...(conversation !== undefined ? { conversation } : {}),
          createdBy: by,
          createdAt: now.toISOString(),
        },
        versions: [versionFrom(generated.definition, 1, by, now, note)],
      },
      now,
    );
    await record(actor, workspace, correlationId, 'workflow-entity.created', entity, {
      via: entity.origin.via,
      definitionId: generated.definition.definitionId,
    });
    return json(201, { workflow: await detailOf(req, workspace, entity) });
  }

  async function listFor(req: ApiRequest, workspace: WorkspaceRecord, only?: (e: WorkflowEntity) => boolean): Promise<ApiResponse> {
    const q = req.query;
    const limit = intParam(q.get('limit') ?? undefined, 'limit', 1, MAX_PAGE, DEFAULT_PAGE);
    const lifecycle = q.get('lifecycle') ?? undefined;
    if (lifecycle !== undefined && !(WORKFLOW_LIFECYCLE as readonly string[]).includes(lifecycle))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `lifecycle must be one of: ${WORKFLOW_LIFECYCLE.join(', ')}`);
    const includeArchived = q.get('archived') === 'true' || lifecycle === 'archived';
    let all = (await entities(workspace).list()).filter((e) => (only === undefined || only(e)) && (includeArchived || !e.archived));
    const pageCursor = q.get('cursor');
    if (pageCursor !== null) {
      const [u, id] = decodeCursor(pageCursor);
      all = all.filter((e) => e.updatedAt < u || (e.updatedAt === u && e.workflowId < id));
    }
    const lc = await lifecycleContext(workspace);
    const p = port(workspace);
    const page: ReturnType<typeof summaryOf>[] = [];
    let last: WorkflowEntity | undefined;
    for (const e of all) {
      if (page.length === limit) break;
      last = e;
      const s = summaryOf(req, e, await p.runsOf(e), lc);
      if (lifecycle === undefined || s.lifecycle === lifecycle) page.push(s);
    }
    const more = last !== undefined && all.indexOf(last) < all.length - 1;
    return json(200, {
      workflows: page,
      ...(more ? { nextCursor: encodeCursor(last!) } : {}),
      // Start following changes from here (GET …/workflow-entities/changes?cursor=…).
      changesCursor: await entities(workspace).feedEnd(),
    });
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const conversationId = req.query.get('conversationId') ?? undefined;
    if (conversationId === undefined) return listFor(req, workspace);
    const c = await ownConversation(req, workspace, conversationId);
    return listFor(req, workspace, (e) => e.origin.conversation?.conversationId === c.conversationId);
  }

  async function listOfConversation(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const c = await ownConversation(req, workspace, req.params['conversationId']);
    return listFor(req, workspace, (e) => e.origin.conversation?.conversationId === c.conversationId);
  }

  async function get(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    return json(200, await detailOf(req, workspace, e));
  }

  /**
   * The workspace change feed, for thin clients: `{ changes, cursor }` after `cursor` (absent = the current end, so a client
   * starts by asking once). With `wait` (seconds, at most 25) the call returns as soon as there is a change, or empty at the end.
   */
  async function changes(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const store = entities(workspace);
    const waitSeconds = intParam(req.query.get('wait') ?? undefined, 'wait', 0, MAX_WAIT_SECONDS, 0);
    const cursor = req.query.get('cursor') ?? (await store.feedEnd());
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const page = await store.changesSince(cursor);
      if (page.changes.length > 0 || Date.now() >= deadline) return json(200, page);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---- change the workflow ----

  async function change(
    req: ApiRequest,
    action: string,
    apply: (e: WorkflowEntity, body: Record<string, unknown>) => ReturnType<Parameters<FsWorkflowEntityStore['update']>[4]>,
    allowed: readonly string[] = ['expectedRevision'],
  ): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'change a workflow' });
    const body = await readBody(req);
    onlyFields(body, allowed);
    const actor = requirePrincipal(req);
    const id = req.params['workflowId'] ?? '';
    await entities(workspace).require(id);
    const next = await entities(workspace).update(id, expectedRevision(body), actorOf(actor), new Date(), (e) => apply(e, body));
    // UW-14d: archiving a workflow erases its token vault (placeholders from its runs can no longer be turned back into values).
    const vaultErased = next.event.kind === 'archived' ? await eraseTokenVault(dataConfig.dataRootDir, workspace.workspaceId, id) : false;
    await record(actor, workspace, correlationId, 'workflow-entity.updated', next, {
      event: next.event.kind,
      ...(vaultErased ? { vaultErased: true } : {}),
    });
    return json(200, { workflow: await detailOf(req, workspace, next) });
  }

  const rename = (req: ApiRequest) =>
    change(
      req,
      'workflow-entity.rename',
      (e, body) => {
        const name = parseName(body['name'], '');
        if (body['name'] === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'name is required');
        return { next: { name }, kind: 'renamed', detail: { from: e.name.slice(0, 120) } };
      },
      ['name', 'expectedRevision'],
    );
  const flag = (field: 'paused' | 'archived', to: boolean, kind: 'paused' | 'resumed' | 'archived' | 'restored') => (req: ApiRequest) =>
    change(req, `workflow-entity.${kind}`, (e) => {
      if (e[field] === to) throw new XoError(ErrorCode.PRECONDITION_FAILED, `the workflow is already ${kind}`);
      return { next: { [field]: to }, kind };
    });

  async function addVersion(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'workflow-entity.version', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'change a workflow' });
    const body = await readBody(req);
    onlyFields(body, ['compilationId', 'goal', 'workflowId', 'definitionId', 'note', 'expectedRevision']);
    const actor = requirePrincipal(req);
    const store = entities(workspace);
    const current = await store.require(req.params['workflowId'] ?? '');
    if (current.archived) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'restore the workflow before changing it');
    const cur = currentVersion(current);
    // Unstated parts carry over from the current version: the same goal (every field of it) over the same compilation, so a
    // new version differs only in what the request changes (for example a recompiled source set).
    const currentDefinition = await workspaceDefinitionsStore(workspace, dataConfig).get(cur.definition.definitionId);
    const { schema: _schema, statedBy: _statedBy, ...goal } = currentDefinition.goal;
    const generated = await definitionFor(req, workspace, body, { compilationId: cur.definition.compilationId, goal });
    if (generated.definition === null)
      return json(200, {
        workflow: null,
        selection: generated.selection,
        ...(generated.gaps !== undefined ? { gaps: generated.gaps } : {}),
      });
    const definition = generated.definition;
    const note = parseNote(body['note']);
    const now = new Date();
    const next = await store.update(current.workflowId, expectedRevision(body), actorOf(actor), now, (e) => {
      const latest = currentVersion(e);
      if (latest.definition.definitionId === definition.definitionId)
        throw new XoError(ErrorCode.PRECONDITION_FAILED, `nothing changed: version ${latest.version} already runs this exact definition`);
      if (e.versions.length >= MAX_VERSIONS)
        throw new XoError(ErrorCode.PRECONDITION_FAILED, `a workflow keeps at most ${MAX_VERSIONS} versions`);
      const v = versionFrom(definition, latest.version + 1, actorOf(actor), now, note);
      return { next: { versions: [...e.versions, v] }, kind: 'version_added', detail: { version: v.version } };
    });
    await record(actor, workspace, correlationId, 'workflow-entity.version.added', next, { definitionId: definition.definitionId });
    return json(201, { workflow: await detailOf(req, workspace, next) });
  }

  // ---- certify, run, decide ----

  async function certify(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'readiness.certify', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'request a readiness certificate' });
    const body = await readBody(req);
    onlyFields(body, ['acceptUnstatedStepOrder']);
    const accept = body['acceptUnstatedStepOrder'];
    if (accept !== undefined && typeof accept !== 'boolean')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'acceptUnstatedStepOrder must be a boolean');
    if (accept === true) {
      await requirePermission(req, workspace, 'review', dataConfig, { action: 'accept an unstated step order' });
      await requireRecentAuthentication(req, workspace, dataConfig, 'accept an unstated step order');
    }
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(currentVersion(e).definition.definitionId);
    const certificate = await issueCertificate(
      { workspace, dataConfig, audit },
      requirePrincipal(req),
      definition,
      accept === true,
      correlationId,
    );
    return json(201, { certificate, version: currentVersion(e).version });
  }

  async function start(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.run', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'run a workflow' });
    const body = await readBody(req);
    onlyFields(body, ['input', 'certificateId', 'batchApprovalId']);
    const input = body['input'] ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    if (e.archived) throw new StartRefusedError('workflow_archived', 'This workflow is archived. Restore it before starting it.');
    if (e.paused) throw new StartRefusedError('workflow_paused', 'This workflow is paused, so it cannot start. Resume it first.');
    const cur = currentVersion(e);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(cur.definition.definitionId);
    // Without an explicit certificate, the latest one issued for this version is presented; it is verified from scratch either way.
    const certificateId =
      body['certificateId'] ?? (await lifecycleContext(workspace)).latestCertificate.get(definition.definitionId)?.certificateId;
    const started = await startGeneratedRun(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition,
      input: input as Record<string, unknown>,
      certificateId,
      idempotencyKey: req.headers['idempotency-key'],
      correlationId,
      workflow: { workflowId: e.workflowId, version: cur.version },
      // UW-8: a batch approval over this version's definition (required in production for a run that can send or change things).
      ...(body['batchApprovalId'] !== undefined ? { batchApprovalId: body['batchApprovalId'] } : {}),
    });
    return json(started.status, { ...started.body, workflowId: e.workflowId, version: cur.version });
  }

  async function runs(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    return json(200, { runs: await port(workspace).runsOf(e) });
  }

  async function run(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    return json(200, await port(workspace).run(e, req.params['runId'] ?? ''));
  }

  /** The definition a run of this workflow belongs to, from the run's own record (an item of a batch names its batch). */
  async function definitionOfRun(w: WorkspaceRecord, e: WorkflowEntity, runId: string): Promise<WorkflowDefinitionRecord> {
    for (const v of e.versions) {
      const dir = runsDir(dataConfig, w.workspaceId, v.definition.definitionId);
      let id = runId;
      if (id.startsWith('fe_')) {
        const first = (await new RunStore(dir).read(id).catch(() => []))[0];
        const parent = first?.type === 'run_started' ? (first.data as { parent?: unknown }).parent : undefined;
        if (typeof parent !== 'string') continue;
        id = parent;
      }
      const meta = await readMeta(dir, id);
      if (meta?.workflow?.workflowId === e.workflowId) return workspaceDefinitionsStore(w, dataConfig).get(v.definition.definitionId);
    }
    throw new NotFoundError(`run "${runId}" of workflow "${e.workflowId}"`);
  }

  async function cancelRun(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.cancel', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'cancel a workflow run' });
    const body = await readBody(req);
    onlyFields(body, ['reason']);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const runId = req.params['runId'] ?? '';
    const view = await cancelGeneratedRun(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition: await definitionOfRun(workspace, e, runId),
      runId,
      reason: body['reason'],
      correlationId,
      workflowId: e.workflowId,
    });
    return json(200, { ...view, workflowId: e.workflowId });
  }

  async function learningContext(req: ApiRequest, action: string, permission: 'read' | 'author') {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, permission, dataConfig, { action: 'use what a run taught' });
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const runId = req.params['runId'] ?? '';
    return { correlationId, workspace, e, runId, definition: await definitionOfRun(workspace, e, runId) };
  }

  async function evidence(req: ApiRequest): Promise<ApiResponse> {
    const c = await learningContext(req, 'run-evidence.read', 'read');
    return json(200, {
      ...(await runEvidence(deps, c.workspace, c.definition, c.runId, req.query.get('item') ?? undefined)),
      workflowId: c.e.workflowId,
    });
  }

  async function outputs(req: ApiRequest): Promise<ApiResponse> {
    const c = await learningContext(req, 'run-outputs.read', 'read');
    return json(200, { ...(await runOutputs(deps, c.workspace, c.definition, c.runId)), workflowId: c.e.workflowId });
  }

  async function delegate(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.delegate', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'delegate a waiting step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'delegate a waiting step');
    const body = await readBody(req);
    onlyFields(body, ['to', 'reason', 'revision']);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const runId = req.params['runId'] ?? '';
    const out = await delegateStep(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition: await definitionOfRun(workspace, e, runId),
      runId,
      approvalId: req.params['approvalId'] ?? '',
      to: body['to'],
      reason: body['reason'],
      revision: body['revision'],
      correlationId,
      workflowId: e.workflowId,
    });
    return json(200, { ...out, workflowId: e.workflowId });
  }

  async function observations(req: ApiRequest): Promise<ApiResponse> {
    const c = await learningContext(req, 'run-learning.read', 'read');
    return json(200, {
      runId: c.runId,
      workflowId: c.e.workflowId,
      observations: await observationsOf(deps, c.workspace, c.definition, c.runId),
    });
  }

  async function correct(req: ApiRequest): Promise<ApiResponse> {
    const c = await learningContext(req, 'run-learning.correction', 'author');
    const body = await readBody(req);
    onlyFields(body, ['item', 'field', 'value', 'reason']);
    const out = await recordCorrection(deps, {
      workspace: c.workspace,
      actor: requirePrincipal(req),
      definition: c.definition,
      runId: c.runId,
      item: body['item'],
      field: body['field'],
      value: body['value'],
      reason: body['reason'],
      correlationId: c.correlationId,
    });
    return json(201, { ...out, workflowId: c.e.workflowId });
  }

  async function proposeLearning(req: ApiRequest): Promise<ApiResponse> {
    const c = await learningContext(req, 'run-learning.propose', 'author');
    const body = await readBody(req);
    onlyFields(body, ['observationIds', 'note']);
    const out = await proposeFromObservations(deps, {
      workspace: c.workspace,
      actor: requirePrincipal(req),
      definition: c.definition,
      runId: c.runId,
      observationIds: body['observationIds'],
      ...(body['note'] !== undefined ? { note: body['note'] } : {}),
      correlationId: c.correlationId,
    });
    return json(201, { ...out, workflowId: c.e.workflowId });
  }

  async function reconcile(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.reconcile', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'record the outcome of an external call' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'record the outcome of an external call');
    const body = await readBody(req);
    onlyFields(body, ['decision', 'reason', 'evidenceExamined']);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const runId = req.params['runId'] ?? '';
    const out = await reconcileGeneratedEffect(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition: await definitionOfRun(workspace, e, runId),
      runId,
      step: req.params['step'] ?? '',
      decision: body['decision'],
      reason: body['reason'],
      evidenceExamined: body['evidenceExamined'],
      correlationId,
      workflowId: e.workflowId,
    });
    return json(200, { ...out, workflowId: e.workflowId });
  }

  async function decide(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.decide', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'decide a human step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'decide a human step');
    const body = await readBody(req);
    onlyFields(body, ['action', 'comment']);
    const e = await entities(workspace).require(req.params['workflowId'] ?? '');
    const runId = req.params['runId'] ?? '';
    // The run's own record says which version (and so which definition) it belongs to.
    let definitionId: string | undefined;
    for (const v of e.versions) {
      const meta = await readMeta(runsDir(dataConfig, workspace.workspaceId, v.definition.definitionId), runId);
      if (meta?.workflow?.workflowId === e.workflowId) definitionId = v.definition.definitionId;
    }
    if (definitionId === undefined) throw new NotFoundError(`run "${runId}" of workflow "${e.workflowId}"`);
    const view = await decideGeneratedApproval(deps, {
      workspace,
      actor: requirePrincipal(req),
      definition: await workspaceDefinitionsStore(workspace, dataConfig).get(definitionId),
      runId,
      approvalId: req.params['approvalId'] ?? '',
      action: body['action'],
      comment: body['comment'],
      correlationId,
      workflowId: e.workflowId,
    });
    return json(200, { ...view, workflowId: e.workflowId });
  }

  // `changes` is registered before `:workflowId`, so the literal segment is never read as an id.
  router.get(`${BASE}/changes`, guarded(changes));
  router.post(BASE, guarded(create));
  router.get(BASE, guarded(list));
  router.get(`${BASE}/:workflowId`, guarded(get));
  router.patch(`${BASE}/:workflowId`, guarded(rename));
  router.post(`${BASE}/:workflowId/versions`, guarded(addVersion));
  router.post(`${BASE}/:workflowId/pause`, guarded(flag('paused', true, 'paused')));
  router.post(`${BASE}/:workflowId/resume`, guarded(flag('paused', false, 'resumed')));
  router.post(`${BASE}/:workflowId/archive`, guarded(flag('archived', true, 'archived')));
  router.post(`${BASE}/:workflowId/restore`, guarded(flag('archived', false, 'restored')));
  router.post(`${BASE}/:workflowId/readiness`, guarded(certify));
  router.post(`${BASE}/:workflowId/runs`, guarded(start));
  router.get(`${BASE}/:workflowId/runs`, guarded(runs));
  router.get(`${BASE}/:workflowId/runs/:runId`, guarded(run));
  router.post(`${BASE}/:workflowId/runs/:runId/approvals/:approvalId`, guarded(decide));
  router.post(`${BASE}/:workflowId/runs/:runId/cancel`, guarded(cancelRun));
  router.get(`${BASE}/:workflowId/runs/:runId/evidence`, guarded(evidence));
  router.get(`${BASE}/:workflowId/runs/:runId/outputs`, guarded(outputs));
  router.post(`${BASE}/:workflowId/runs/:runId/approvals/:approvalId/delegate`, guarded(delegate));
  router.get(`${BASE}/:workflowId/runs/:runId/observations`, guarded(observations));
  router.post(`${BASE}/:workflowId/runs/:runId/corrections`, guarded(correct));
  router.post(`${BASE}/:workflowId/runs/:runId/learning-proposals`, guarded(proposeLearning));
  router.post(`${BASE}/:workflowId/runs/:runId/effects/:step/reconciliation`, guarded(reconcile));
  router.get('/workspaces/:workspaceId/intelligence/conversations/:conversationId/workflows', guarded(listOfConversation));
}

export { WORKFLOW_ID };
