import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import { ConnectorError, ConnectorHost, MapVault, type Connector, type Json } from '@xo/connectors';
import {
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  ApprovalError,
  RunInputError,
  generateReviewerKeys,
  signDecision,
  type RunResult,
} from '@xo/workflow-runtime';
import type { ExternalToolAdapter } from '@xo/adapters';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { join } from 'node:path';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId, safeId } from '../audit/audit-service.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';
import { verifyCertificateNow, workspaceCertificatesStore } from './readiness-routes.js';
import { readConnectorBindings, writeConnectorBindings, parseConnectorBindings } from '../pre-execution/connector-bindings.js';

/**
 * ADR 0030 — generated workflows run as Workflow IR, interpreted by `@xo/workflow-runtime`: the definition the readiness
 * certificate binds is the definition that runs. Every start presents a current READY certificate for that exact generated
 * workflow (re-verified now, whatever the workspace setting). Human steps wait for a person; the platform signs each
 * decision on behalf of the authenticated reviewer (review role, recent sign-in), so the run's journal records who decided.
 * Connector steps go through `ConnectorHost` to the adapters the host installed for the workspace's bindings; an unknown
 * outcome is never retried silently, it escalates.
 *
 * Runs are journaled per generated workflow under `<data>/<workspace>/generated-runs/<definitionId>/` (hash-chained,
 * restart-safe). Due timers and approval timeouts are advanced by `tick`, which reads run on every status read and on a
 * background interval.
 */

/** One signing key per server process: decisions are verified when made and journaled; the key need not outlive the process. */
const PLATFORM_KEY = generateReviewerKeys();

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      if (cause instanceof RunInputError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { problems: [...cause.problems] } }));
      if (cause instanceof ApprovalError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { reason: cause.code } }));
      return errorToResponse(cause);
    }
  };
}

function bridge(
  adapter: ExternalToolAdapter,
  connectorId: string,
  operations: Readonly<Record<string, 'read' | 'write' | 'irreversible'>>,
): Connector {
  const ops: Record<string, Connector['operations'][string]> = {};
  for (const [name, sideEffect] of Object.entries(operations))
    ops[name] = {
      sideEffect,
      execute: async (args, ctx) => {
        const r = await adapter.invoke({
          capabilityId: `${connectorId}.${name}`,
          dispatchKey: ctx.idempotencyKey ?? `${ctx.runId}:${ctx.stepId}`,
          input: args,
        });
        if (r.kind === 'confirmed_success') return (r.output ?? null) as Json;
        if (r.kind === 'confirmed_failure_no_effect') throw new ConnectorError('FAILED', `${r.code}: ${r.message}`, 'none');
        throw new ConnectorError('FAILED', `outcome unknown: ${r.reason}`);
      },
    };
  return { kind: 'http', operations: ops };
}

/** The runner for one generated workflow, with its connectors and (for a decision) the deciding reviewer. */
async function runnerFor(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  definition: WorkflowDefinitionRecord,
  reviewer?: { readonly id: string },
): Promise<WorkflowRunner> {
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `generated workflow ${definition.definitionId} has no definition to run`);
  const bindings = (await readConnectorBindings(workspace, dataConfig)).bindings;
  const adapters = dataConfig.preExecution?.connectorAdapters ?? new Map<string, ExternalToolAdapter>();
  const implementations: Record<string, Connector> = {};
  const grants: Record<string, { grant: string[] }> = {};
  for (const decl of component.connectors) {
    const b = bindings.find((x) => x.connector === decl.id);
    const adapter = b !== undefined ? adapters.get(b.adapter) : undefined;
    if (adapter === undefined) continue; // undeclared implementation: the host refuses the call (NO_IMPLEMENTATION), it never guesses
    const ops = Object.fromEntries(decl.operations.map((o) => [o.name, o.sideEffect]));
    implementations[decl.id] = { ...bridge(adapter, decl.id, ops), kind: decl.kind };
    grants[decl.id] = { grant: decl.operations.map((o) => o.name) };
  }
  return new WorkflowRunner({
    component,
    workflowId: component.workflows[0]!.id,
    store: new RunStore(join(dataConfig.dataRootDir, workspace.workspaceId, 'generated-runs', definition.definitionId)),
    connectors: new ConnectorHost({ component, policy: { connectors: grants }, implementations, vault: new MapVault({}) }),
    approvals: {
      reviewers: new StaticReviewerRegistry(
        reviewer !== undefined ? [{ id: reviewer.id, roles: ['reviewer'], publicKeyPem: PLATFORM_KEY.publicKeyPem }] : [],
      ),
    },
  });
}

async function view(runner: WorkflowRunner, runId: string): Promise<Record<string, unknown>> {
  await runner.tick().catch(() => undefined);
  const status = await runner.status(runId);
  const pending = (await runner.listApprovals()).filter((a) => a.runId === runId);
  return { ...status, pendingApprovals: pending };
}

export function registerGeneratedRunRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  async function getBindings(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const stored = await readConnectorBindings(workspace, dataConfig);
    const available = new Set(dataConfig.preExecution?.connectorAdapters.keys() ?? []);
    return json(200, { ...stored, bindings: stored.bindings.map((b) => ({ ...b, adapterInstalled: available.has(b.adapter) })) });
  }

  /** Replaces the workspace's connector bindings (manage role, recent sign-in, revision-guarded, audited). */
  async function putBindings(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'connector-bindings.update', correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'bind connectors' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'bind connectors');
    const body = await req.json<{ bindings?: unknown; expectedRevision?: unknown }>();
    if (!body.ok) throw body.error;
    const bindings = parseConnectorBindings(body.value.bindings);
    const current = await readConnectorBindings(workspace, dataConfig);
    if (body.value.expectedRevision !== undefined && body.value.expectedRevision !== current.revision)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the bindings changed (revision ${current.revision}); reload and try again`);
    const actor = requirePrincipal(req);
    const next = { revision: current.revision + 1, bindings, updatedAt: new Date().toISOString(), updatedBy: actor.id };
    await writeConnectorBindings(workspace, dataConfig, next);
    await audit.tryRecord({
      action: 'connector-bindings.update',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workspace', id: workspace.workspaceId },
      type: 'connector-bindings.updated',
      outcome: 'completed',
      metadata: { revision: next.revision, bindings: bindings.length },
    });
    return json(200, next);
  }

  /** Starts a generated workflow as Workflow IR. A current READY (or READY_WITH_CONDITIONS) certificate is always required. */
  async function start(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.run', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'run a generated workflow' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ input?: unknown; certificateId?: unknown }>();
    if (!body.ok) throw body.error;
    const unknown = Object.keys(body.value).filter((k) => k !== 'input' && k !== 'certificateId');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const input = body.value.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const actor = requirePrincipal(req);
    const draft = {
      action: 'generated-workflow.run',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow' as const, id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    };
    const certificateId = body.value.certificateId;
    if (typeof certificateId !== 'string') {
      await audit.tryRecord({ ...draft, type: 'readiness.start.refused', outcome: 'denied', reasonCode: 'certificate_required' });
      throw new XoError(
        ErrorCode.READINESS_CERTIFICATE_REQUIRED,
        'a generated workflow runs only with a current readiness certificate: request one and pass its certificateId',
      );
    }
    const cert = await workspaceCertificatesStore(workspace, dataConfig).get(certificateId);
    const reasons: string[] = [];
    if (cert.scope.definitionId !== definition.definitionId) reasons.push(`certificate ${certificateId} is for another generated workflow`);
    else {
      const v = await verifyCertificateNow(workspace, dataConfig, cert);
      if (!v.ok) reasons.push(...v.reasons);
    }
    if (reasons.length > 0) {
      await audit.tryRecord({
        ...draft,
        type: 'readiness.start.refused',
        outcome: 'denied',
        reasonCode: 'certificate_refused',
        metadata: { certificateId },
      });
      throw new XoError(
        ErrorCode.READINESS_CERTIFICATE_REFUSED,
        `the readiness certificate does not allow this start: ${reasons.join('; ')}`,
        { context: { certificateId, reasons } },
      );
    }
    const idem = req.headers['idempotency-key'];
    const runner = await runnerFor(workspace, dataConfig, definition);
    const result: RunResult = await runner.start({
      inputs: input as Record<string, unknown>,
      ...(typeof idem === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(idem) ? { dedupeKey: `${actor.id}:${idem}` } : {}),
    });
    await audit.tryRecord({
      ...draft,
      type: 'generated-workflow.run.started',
      outcome: 'completed',
      metadata: { runId: result.runId, certificateId, state: result.state },
    });
    return json(result.accepted ? 201 : 200, { ...(await view(runner, result.runId)), certificateId });
  }

  async function status(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(workspace, dataConfig, definition);
    const runId = req.params['runId'] ?? '';
    try {
      return json(200, await view(runner, runId));
    } catch {
      throw new NotFoundError(`run "${runId}"`);
    }
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(workspace, dataConfig, definition);
    const store = new RunStore(join(dataConfig.dataRootDir, workspace.workspaceId, 'generated-runs', definition.definitionId));
    const runs = [];
    for (const id of await store.list().catch(() => [] as string[])) runs.push(await runner.status(id).catch(() => undefined));
    return json(200, { runs: runs.filter((r) => r !== undefined) });
  }

  /** A person decides a human step: review role, recent sign-in; the platform signs the decision as theirs. */
  async function decide(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.decide', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'decide a human step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'decide a human step');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ action?: unknown; comment?: unknown }>();
    if (!body.ok) throw body.error;
    const action = body.value.action;
    if (action !== 'approve' && action !== 'reject')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'action must be "approve" (done as instructed) or "reject"');
    const comment = typeof body.value.comment === 'string' ? body.value.comment.slice(0, 2000) : undefined;
    const actor = requirePrincipal(req);
    const runner = await runnerFor(workspace, dataConfig, definition, { id: actor.id });
    const runId = req.params['runId'] ?? '';
    const approvalId = req.params['approvalId'] ?? '';
    const request = (await runner.listApprovals()).find((a) => a.runId === runId && a.approvalId === approvalId);
    if (request === undefined) throw new NotFoundError(`pending approval "${approvalId}" on run "${runId}"`);
    const signed = signDecision(PLATFORM_KEY.privateKeyPem, {
      v: 1,
      approvalId,
      runId,
      step: request.step,
      action,
      edits: {},
      reviewerId: actor.id,
      at: new Date().toISOString(),
      ...(comment !== undefined ? { comment } : {}),
    });
    const result = await runner.decideApproval(runId, signed);
    await audit.tryRecord({
      action: 'generated-workflow.decide',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
      type: 'generated-workflow.approval.decided',
      outcome: 'completed',
      metadata: { runId, step: request.step, action, state: result.state },
    });
    return json(200, await view(runner, runId));
  }

  // Due timers and approval deadlines advance even when nobody reads the run: every minute, each generated workflow with
  // runs is ticked (the interval never keeps the process alive).
  const tickAll = async (): Promise<void> => {
    const { readdir } = await import('node:fs/promises');
    for (const ws of await readdir(dataConfig.dataRootDir).catch(() => [] as string[])) {
      const runsDir = join(dataConfig.dataRootDir, ws, 'generated-runs');
      for (const definitionId of await readdir(runsDir).catch(() => [] as string[])) {
        try {
          const workspace = await workspaceStore.get(ws);
          if (!workspace.ok) continue;
          const definition = await workspaceDefinitionsStore(workspace.value, dataConfig).get(definitionId);
          await (await runnerFor(workspace.value, dataConfig, definition)).tick();
        } catch {
          // one unreadable workflow never stops the others; its own status read reports the problem
        }
      }
    }
  };
  setInterval(() => void tickAll(), 60_000).unref();

  router.get('/workspaces/:workspaceId/connector-bindings', guarded(getBindings));
  router.put('/workspaces/:workspaceId/connector-bindings', guarded(putBindings));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(start));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(list));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId', guarded(status));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/approvals/:approvalId', guarded(decide));
}
