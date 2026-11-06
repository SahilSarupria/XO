import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { toRecordedAuthentication } from '../auth/recorded-authentication.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest, type ApiResponse } from '../http/types.js';
import { recordAudit } from '../audit/record.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import {
  contentHash,
  defaultDeployment,
  evaluateReadiness,
  isMode,
  MAX_SCHEDULE_INPUT_BYTES,
  parseDailyCap,
  parseEveryMinutes,
  summarizeShadow,
  transitionRefusal,
  type Deployment,
  type ShadowJudgement,
  type WorkflowMode,
} from '../workflow-controls/model.js';
import { enforceStart, startGated, viewOf } from '../workflow-controls/service.js';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKey } from '../workflows/workflow-idempotency.js';
import { TERMINAL_WORKFLOW_STATUSES } from '../workflows/workflow-execution.js';
import { listWorkflowExecutions, toWorkflowExecutionView } from '../workflows/workflow-runner.js';
import { loadWorkflowViews, makeRunnerContext } from '../workflows/workflow-views.js';
import type { WorkflowView } from '../workflows/workflow-catalog.js';
import {
  requireOwnedWorkspace,
  requirePermission,
  requirePrincipal,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';

/**
 * Workflow controls: the mode a workflow is in (draft, practising, live, paused), how it may be started, its daily
 * limit, who signed it off, how practice runs went, and the workspace-wide pause. See `workflow-controls/model.ts` for
 * the rules and for what these controls do NOT promise.
 *
 * Who may do what: `read` sees everything. `author` sets limits and triggers, starts and pauses a workflow, and moves it
 * to or from practice. `publish` takes it live. `review` signs a version off and judges practice runs. `manage` pauses
 * or resumes the whole workspace. Every change is written to the audit log.
 */
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REASON = 200;

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}
async function bodyOf(req: ApiRequest, allowed: readonly string[], endpoint: string, allowEmpty = false): Promise<Record<string, unknown>> {
  if (allowEmpty && (await req.rawBody()).length === 0) return {};
  const parsed = await req.json<unknown>();
  if (!parsed.ok) throw parsed.error;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
  const unknown = Object.keys(v).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      `unknown request field(s) for ${endpoint}: ${unknown.map((k) => `"${k}"`).join(', ')}. Allowed fields: ${allowed.join(', ')}.`,
    );
  return v as Record<string, unknown>;
}
const need = (b: Record<string, unknown>, k: string): string => {
  const v = b[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > 256)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${k}" (string) is required`);
  return v;
};
const displayNameOf = (w: WorkspaceRecord, id: string) => w.members?.find((m) => m.identityId === id)?.displayName;

export function registerWorkflowControlsRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const controlsOf = (w: WorkspaceRecord) => new FsControlsStore(workspaceStateStore(w, dataConfig), w.workspaceId);

  async function findView(w: WorkspaceRecord, req: ApiRequest, compilationId: string, workflowId: string): Promise<WorkflowView> {
    const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig);
    const { workflows } = await loadWorkflowViews(ctx, compilationId);
    const found = workflows.find((v) => v.workflowId === workflowId);
    if (found === undefined) throw new NotFoundError(`workflow "${workflowId}"`);
    return found;
  }

  async function snapshot(w: WorkspaceRecord, req: ApiRequest) {
    const store = controlsOf(w);
    const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig);
    const [controls, stored, loaded, runs] = await Promise.all([
      store.getControls(),
      store.listDeployments(),
      loadWorkflowViews(ctx),
      listWorkflowExecutions(ctx),
    ]);
    const byKey = new Map(stored.map((d) => [`${d.compilationId}\n${d.workflowId}`, d]));
    const now = new Date();
    return {
      controls,
      deployments: loaded.workflows.map((v) => viewOf(v, byKey.get(`${v.compilationId}\n${v.workflowId}`), runs, now)),
    };
  }
  async function viewFor(w: WorkspaceRecord, req: ApiRequest, compilationId: string, workflowId: string) {
    const store = controlsOf(w);
    const v = await findView(w, req, compilationId, workflowId);
    const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig);
    return viewOf(v, await store.getDeployment(compilationId, workflowId), await listWorkflowExecutions(ctx), new Date());
  }

  // GET /workspaces/:workspaceId/workflow-controls
  async function getAll(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig, { action: 'read workflow controls' });
    const { controls, deployments } = await snapshot(w, req);
    return json(200, {
      paused: controls.paused,
      ...(controls.pausedAt !== undefined ? { pausedAt: controls.pausedAt } : {}),
      ...(controls.pausedBy !== undefined ? { pausedBy: controls.pausedBy } : {}),
      ...(controls.reason !== undefined ? { reason: controls.reason } : {}),
      deployments,
    });
  }

  // POST .../workflow-controls/pause | resume   (the workspace-wide switch)
  const setPaused = (paused: boolean) =>
    guarded(async (req) => {
      const w = await requireOwnedWorkspace(req, workspaceStore);
      await requirePermission(req, w, 'manage', dataConfig, { action: paused ? 'pause all workflows' : 'resume all workflows' });
      const b = await bodyOf(req, paused ? ['reason'] : [], `POST .../workflow-controls/${paused ? 'pause' : 'resume'}`, true);
      let reason: string | undefined;
      if (b['reason'] !== undefined) {
        if (typeof b['reason'] !== 'string' || b['reason'].length > MAX_REASON)
          throw new XoError(ErrorCode.INVALID_ARGUMENT, `"reason" must be text of at most ${MAX_REASON} characters`);
        reason = b['reason'].trim() === '' ? undefined : b['reason'].trim();
      }
      const by = req.identity?.identityId ?? 'unknown';
      const next = await controlsOf(w).setPaused(paused, by, reason, new Date().toISOString());
      await recordAudit(req, w, dataConfig, {
        event: paused ? 'workflows.paused' : 'workflows.resumed',
        result: 'succeeded',
        ...(reason !== undefined ? { detail: { reason } } : {}),
      });
      return json(200, {
        paused: next.paused,
        ...(next.pausedAt !== undefined ? { pausedAt: next.pausedAt } : {}),
        ...(next.pausedBy !== undefined ? { pausedBy: next.pausedBy } : {}),
        ...(next.reason !== undefined ? { reason: next.reason } : {}),
      });
    });

  const base = '/workspaces/:workspaceId/workflow-controls/workflows/:workflowId';
  /** Shared shape of the per-workflow actions: workspace, permission, body with `compilationId`, then the change. */
  function action(
    permission: 'author' | 'publish' | 'review',
    name: string,
    allowed: readonly string[],
    run: (a: {
      w: WorkspaceRecord;
      req: ApiRequest;
      b: Record<string, unknown>;
      compilationId: string;
      workflowId: string;
      view: WorkflowView;
      store: FsControlsStore;
      by: string;
    }) => Promise<void>,
    dynamicPermission?: (b: Record<string, unknown>) => 'author' | 'publish' | 'review',
  ) {
    return guarded(async (req) => {
      const w = await requireOwnedWorkspace(req, workspaceStore);
      const b = await bodyOf(req, ['compilationId', ...allowed], name);
      const workflowId = req.params['workflowId'] ?? '';
      await requirePermission(req, w, dynamicPermission?.(b) ?? permission, dataConfig, {
        action: name,
        target: { kind: 'workflow', id: workflowId },
      });
      const compilationId = need(b, 'compilationId');
      const view = await findView(w, req, compilationId, workflowId);
      const store = controlsOf(w);
      await run({ w, req, b, compilationId, workflowId, view, store, by: req.identity?.identityId ?? 'unknown' });
      return json(200, await viewFor(w, req, compilationId, workflowId));
    });
  }

  /** The numbers readiness needs, for the workflow as it is right now. */
  async function readinessNow(w: WorkspaceRecord, req: ApiRequest, view: WorkflowView, d: Deployment) {
    const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig);
    const runs = (await listWorkflowExecutions(ctx)).filter(
      (r) =>
        r.workflowId === view.workflowId &&
        r.compilationId === view.compilationId &&
        r.shadow !== undefined &&
        TERMINAL_WORKFLOW_STATUSES.has(r.status),
    );
    const shadow = summarizeShadow(runs, d.shadowReviews);
    return evaluateReadiness({
      executable: view.executable,
      steps: view.steps,
      deployment: d,
      currentHash: contentHash(view),
      shadowRuns: shadow.runs,
    });
  }

  const setMode = action(
    'author',
    'POST .../workflow-controls/workflows/:workflowId/mode',
    ['mode'],
    async ({ w, req, b, compilationId, workflowId, view, store, by }) => {
      if (!isMode(b['mode'])) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"mode" must be one of: draft, shadow, live, paused');
      const to: WorkflowMode = b['mode'];
      const current =
        (await store.getDeployment(compilationId, workflowId)) ?? defaultDeployment(compilationId, workflowId, new Date().toISOString());
      if (current.mode === to) return;
      const refusal = transitionRefusal(to, await readinessNow(w, req, view, current));
      if (refusal !== undefined)
        throw new XoError(ErrorCode.PRECONDITION_FAILED, `It cannot move to ${to} yet: ${refusal.message}.`, {
          context: { reason: refusal.reason },
        });
      await store.mutate(compilationId, workflowId, by, new Date().toISOString(), (d) => {
        const { modeBeforePause: _drop, ...rest } = d;
        return to === 'paused'
          ? {
              ...rest,
              mode: 'paused',
              ...(d.mode !== 'paused'
                ? { modeBeforePause: d.mode }
                : d.modeBeforePause !== undefined
                  ? { modeBeforePause: d.modeBeforePause }
                  : {}),
            }
          : { ...rest, mode: to };
      });
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.mode_changed',
        result: 'succeeded',
        target: { kind: 'workflow', id: workflowId, label: view.name },
        detail: { compilationId, from: current.mode, to },
      });
    },
    (b) => (b['mode'] === 'live' ? 'publish' : 'author'),
  );

  const setLimits = action(
    'author',
    'PUT .../workflow-controls/workflows/:workflowId/limits',
    ['dailyRunCap'],
    async ({ w, req, b, compilationId, workflowId, view, store, by }) => {
      const cap = parseDailyCap(b['dailyRunCap']);
      if (cap === 'invalid' || !('dailyRunCap' in b))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"dailyRunCap" must be a whole number from 1 to 100000, or null to remove the limit');
      await store.mutate(compilationId, workflowId, by, new Date().toISOString(), (d) => ({
        ...d,
        limits: cap === undefined ? {} : { dailyRunCap: cap },
      }));
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.limits_changed',
        result: 'succeeded',
        target: { kind: 'workflow', id: workflowId, label: view.name },
        detail: { compilationId, dailyRunCap: cap ?? null },
      });
    },
  );

  const setTriggers = action(
    'author',
    'PUT .../workflow-controls/workflows/:workflowId/triggers',
    ['webhook', 'schedule'],
    async ({ w, req, b, compilationId, workflowId, view, store, by }) => {
      if (b['webhook'] !== undefined && typeof b['webhook'] !== 'boolean')
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"webhook" must be true or false');
      let every: number | null | undefined;
      let schedInput: Record<string, unknown> | undefined;
      if (b['schedule'] !== undefined) {
        if (b['schedule'] === null) every = null;
        else {
          const sc = b['schedule'];
          if (typeof sc !== 'object' || Array.isArray(sc) || Object.keys(sc as object).some((k) => k !== 'everyMinutes' && k !== 'input'))
            throw new XoError(ErrorCode.INVALID_ARGUMENT, '"schedule" must be null or { everyMinutes, input? }');
          const rec = sc as Record<string, unknown>;
          const m = parseEveryMinutes(rec['everyMinutes']);
          if (m === 'invalid')
            throw new XoError(ErrorCode.INVALID_ARGUMENT, '"everyMinutes" must be a whole number from 5 to 10080 (one week)');
          every = m;
          if (rec['input'] !== undefined) {
            const inp = rec['input'];
            if (typeof inp !== 'object' || inp === null || Array.isArray(inp) || JSON.stringify(inp).length > MAX_SCHEDULE_INPUT_BYTES)
              throw new XoError(ErrorCode.INVALID_ARGUMENT, `"input" must be a JSON object of at most ${MAX_SCHEDULE_INPUT_BYTES} bytes`);
            schedInput = inp as Record<string, unknown>;
          }
        }
      }
      const now = new Date().toISOString();
      await store.mutate(compilationId, workflowId, by, now, (d) => ({
        ...d,
        triggers: {
          webhook: typeof b['webhook'] === 'boolean' ? b['webhook'] : d.triggers.webhook,
          ...(every === null
            ? {}
            : every !== undefined
              ? {
                  schedule: {
                    everyMinutes: every,
                    lastFiredAt: d.triggers.schedule?.lastFiredAt ?? now,
                    ...(d.triggers.schedule?.lastOutcome !== undefined ? { lastOutcome: d.triggers.schedule.lastOutcome } : {}),
                    ...(schedInput !== undefined ? { input: schedInput } : {}),
                  },
                }
              : d.triggers.schedule !== undefined
                ? { schedule: d.triggers.schedule }
                : {}),
        },
      }));
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.triggers_changed',
        result: 'succeeded',
        target: { kind: 'workflow', id: workflowId, label: view.name },
        detail: {
          compilationId,
          ...(typeof b['webhook'] === 'boolean' ? { webhook: b['webhook'] } : {}),
          ...(every !== undefined ? { scheduleEveryMinutes: every } : {}),
        },
      });
    },
  );

  const signOff = action(
    'review',
    'POST .../workflow-controls/workflows/:workflowId/sign-off',
    [],
    async ({ w, req, compilationId, workflowId, view, store, by }) => {
      const current =
        (await store.getDeployment(compilationId, workflowId)) ?? defaultDeployment(compilationId, workflowId, new Date().toISOString());
      const items = await readinessNow(w, req, view, current);
      const blocked = items.filter((i) => (i.id === 'rules' || i.id === 'runnable') && !i.ok);
      if (blocked.length > 0)
        throw new XoError(ErrorCode.PRECONDITION_FAILED, `It cannot be signed off yet: ${blocked.map((b) => b.message).join('; ')}.`, {
          context: { reason: 'not_ready' },
        });
      const name = displayNameOf(w, by);
      const hash = contentHash(view);
      const at = new Date().toISOString();
      await store.mutate(compilationId, workflowId, by, at, (d) => ({
        ...d,
        signOff: { identityId: by, ...(name !== undefined ? { displayName: name } : {}), at, contentHash: hash },
      }));
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.signed_off',
        result: 'approved',
        target: { kind: 'workflow', id: workflowId, label: view.name },
        detail: { compilationId, contentHash: hash },
      });
    },
  );

  const reviewShadow = action(
    'review',
    'POST .../workflow-controls/workflows/:workflowId/shadow-reviews',
    ['workflowExecutionId', 'judgement'],
    async ({ w, req, b, compilationId, workflowId, view, store, by }) => {
      const runId = need(b, 'workflowExecutionId');
      if (b['judgement'] !== 'automatic' && b['judgement'] !== 'person')
        throw new XoError(
          ErrorCode.INVALID_ARGUMENT,
          '"judgement" must be "automatic" (it could be done without a person) or "person" (a person would have handled it)',
        );
      const judgement: ShadowJudgement = b['judgement'];
      const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig);
      const run = (await listWorkflowExecutions(ctx)).find((r) => r.workflowExecutionId === runId);
      if (
        run === undefined ||
        run.workflowId !== workflowId ||
        run.compilationId !== compilationId ||
        run.shadow === undefined ||
        !TERMINAL_WORKFLOW_STATUSES.has(run.status)
      )
        throw new NotFoundError(`practice run "${runId}"`);
      await store.mutate(compilationId, workflowId, by, new Date().toISOString(), (d) => ({
        ...d,
        shadowReviews: { ...d.shadowReviews, [runId]: judgement },
      }));
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.shadow_reviewed',
        result: 'succeeded',
        target: { kind: 'workflow_run', id: runId, label: view.name },
        detail: { compilationId, judgement },
      });
    },
  );

  // POST /workspaces/:workspaceId/workflows/:workflowId/webhook — start a run from outside. Uses the ordinary API-key
  // authentication (the caller is a member of the workspace with the `author` role); there is no second secret scheme.
  async function webhook(req: ApiRequest): Promise<ApiResponse> {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const workflowId = req.params['workflowId'] ?? '';
    await requirePermission(req, w, 'author', dataConfig, {
      action: 'start workflow by webhook',
      target: { kind: 'workflow', id: workflowId },
    });
    const b = await bodyOf(req, ['compilationId', 'input'], 'POST .../workflows/:workflowId/webhook');
    const compilationId = need(b, 'compilationId');
    let input: Record<string, unknown> = {};
    if (b['input'] !== undefined) {
      const i = b['input'];
      if (typeof i !== 'object' || i === null || Array.isArray(i) || JSON.stringify(i).length > MAX_INPUT_BYTES)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `"input" must be a JSON object of at most ${MAX_INPUT_BYTES} bytes`);
      input = i as Record<string, unknown>;
    }
    const ctx = makeRunnerContext(w, requirePrincipal(req), dataConfig, toRecordedAuthentication(req.authentication));
    const key = parseIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
    const { record, replayed } = await startGated(
      controlsOf(w),
      ctx,
      { compilationId, workflowId, input, ...(key !== undefined ? { idempotencyKey: key } : {}) },
      'webhook',
      new Date(),
    );
    if (!replayed)
      await recordAudit(req, w, dataConfig, {
        event: 'workflow.triggered',
        result: record.status === 'failed' ? 'failed' : record.status === 'waiting_for_human' ? 'escalated' : 'succeeded',
        target: { kind: 'workflow_run', id: record.workflowExecutionId, label: record.workflowName },
        detail: { compilationId, trigger: 'webhook', status: record.status, ...(record.shadow !== undefined ? { practice: true } : {}) },
      });
    return json(
      replayed ? 200 : record.status === 'failed' ? 200 : 201,
      await toWorkflowExecutionView(ctx, record),
      replayed ? { 'idempotent-replayed': 'true' } : undefined,
    );
  }

  router.get('/workspaces/:workspaceId/workflow-controls', guarded(getAll));
  router.post('/workspaces/:workspaceId/workflow-controls/pause', setPaused(true));
  router.post('/workspaces/:workspaceId/workflow-controls/resume', setPaused(false));
  router.post(`${base}/mode`, setMode);
  router.put(`${base}/limits`, setLimits);
  router.put(`${base}/triggers`, setTriggers);
  router.post(`${base}/sign-off`, signOff);
  router.post(`${base}/shadow-reviews`, reviewShadow);
  router.post('/workspaces/:workspaceId/workflows/:workflowId/webhook', guarded(webhook));
}

export { enforceStart };
