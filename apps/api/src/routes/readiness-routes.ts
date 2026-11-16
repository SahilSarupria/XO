import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import {
  assessReadiness,
  lowerCandidateWorkflow,
  readinessBindings,
  selectWorkflowScope,
  verifyReadinessCertificate,
  type CertificateBindings,
  type CertificateVerification,
  type WorkflowReadinessCertificate,
} from '@xo/pre-execution';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId, safeId } from '../audit/audit-service.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import { loadPreExecutionContext, type PreExecutionContext } from '../pre-execution/context.js';
import { JsonRecordStore } from '../pre-execution/record-store.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';

/**
 * PX-7 — readiness certificates and the start gate (ADR 0029 decisions 14 and 15; gaps PX-G24, PX-G25).
 *
 * A certificate is issued for one generated workflow: the server recomputes everything (inventory, source quality,
 * completeness, knowledge, scope, the lowering) and binds the digests. It is verified again, from scratch, whenever a
 * start presents it: a certificate whose bindings no longer match the current state is stale and the start is refused.
 */

const CERT_ID = /^wrc_[0-9a-f]{24}$/;

export function workspaceCertificatesStore(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
): JsonRecordStore<WorkflowReadinessCertificate> {
  return new JsonRecordStore(
    new LocalFsBlobStore(join(config.dataRootDir, workspace.workspaceId, 'readiness-certificates')),
    CERT_ID,
    'readiness certificate',
  );
}

/** Everything a certificate binds, as it is NOW for this generated workflow. */
export async function currentReadiness(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  definition: WorkflowDefinitionRecord,
): Promise<{
  ctx: PreExecutionContext;
  bindings: CertificateBindings;
  lowered: ReturnType<typeof lowerCandidateWorkflow>;
  scope?: ReturnType<typeof selectWorkflowScope>;
}> {
  const ctx = await loadPreExecutionContext(workspace, dataConfig, definition.compilationId, definition.goal.needs ?? []);
  const candidate = ctx.workflows.find((w) => w.id === definition.candidateWorkflowId);
  if (candidate === undefined)
    throw new NotFoundError(`workflow "${definition.candidateWorkflowId}" no longer exists in compilation "${definition.compilationId}"`);
  const lowered = lowerCandidateWorkflow(ctx.graph, candidate, ctx.inventory);
  const scope = definition.selection.status === 'explicit' ? undefined : selectWorkflowScope(ctx.workflows, definition.goal);
  const bindings = readinessBindings({
    artifact: ctx.artifact,
    inventory: ctx.inventory,
    candidate,
    lowered,
    goal: definition.goal,
    ...(ctx.knowledge !== undefined ? { knowledge: ctx.knowledge } : {}),
    decisionDigests: ctx.decisionDigests,
  });
  return { ctx, bindings, lowered, ...(scope !== undefined ? { scope } : {}) };
}

/** Verifies a certificate against the current state of its generated workflow. */
export async function verifyCertificateNow(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  certificate: WorkflowReadinessCertificate,
): Promise<CertificateVerification> {
  const definitionId = certificate.scope.definitionId;
  if (definitionId === undefined) return { ok: false, reasons: ['the certificate names no generated workflow'] };
  const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(definitionId);
  const now = await currentReadiness(workspace, dataConfig, definition);
  return verifyReadinessCertificate(certificate, now.bindings);
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerReadinessRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  /**
   * Issues a certificate for a generated workflow. Anyone who may author may ask; accepting an unstated step order (the
   * one declared condition) is the owner's call, so it needs the review role and a recent sign-in.
   */
  async function issue(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'readiness.certify', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'request a readiness certificate' });
    const body = await req.json<{ acceptUnstatedStepOrder?: unknown }>();
    if (!body.ok) throw body.error;
    const accept = body.value.acceptUnstatedStepOrder;
    if (accept !== undefined && typeof accept !== 'boolean')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'acceptUnstatedStepOrder must be a boolean');
    if (accept === true) {
      await requirePermission(req, workspace, 'review', dataConfig, { action: 'accept an unstated step order' });
      await requireRecentAuthentication(req, workspace, dataConfig, 'accept an unstated step order');
    }
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const now = await currentReadiness(workspace, dataConfig, definition);
    const candidate = now.ctx.workflows.find((w) => w.id === definition.candidateWorkflowId)!;
    const actor = requirePrincipal(req);
    const certificate = assessReadiness({
      artifact: now.ctx.artifact,
      sourceQuality: now.ctx.sourceQuality,
      completeness: now.ctx.completeness,
      inventory: now.ctx.inventory,
      candidate,
      lowered: now.lowered,
      goal: definition.goal,
      ...(now.scope !== undefined ? { scope: now.scope } : {}),
      ...(now.ctx.knowledge !== undefined ? { knowledge: now.ctx.knowledge } : {}),
      ...(accept === true ? { accepted: { ambiguousStepOrder: true } } : {}),
      decisionDigests: now.ctx.decisionDigests,
      compilationId: definition.compilationId,
      definitionId: definition.definitionId,
      issuedBy: { id: actor.id, kind: actor.kind },
      issuedAt: new Date().toISOString(),
    });
    if (now.lowered.definitionDigest !== definition.lowered.definitionDigest)
      throw new XoError(
        ErrorCode.READINESS_CERTIFICATE_REFUSED,
        `generated workflow ${definition.definitionId} no longer matches what its compilation lowers to today; generate it again`,
      );
    await workspaceCertificatesStore(workspace, dataConfig).put(certificate.certificateId, certificate);
    await audit.tryRecord({
      action: 'readiness.certify',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
      type: 'readiness.certificate.issued',
      outcome: 'completed',
      metadata: { certificateId: certificate.certificateId, status: certificate.status, definitionId: definition.definitionId },
    });
    return json(201, certificate);
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    return json(200, { certificates: await workspaceCertificatesStore(workspace, dataConfig).list() });
  }

  async function get(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    return json(200, await workspaceCertificatesStore(workspace, dataConfig).get(req.params['certificateId'] ?? ''));
  }

  /** Verifies a certificate against the state as it is now: intact, a status that allows a start, nothing stale. */
  async function verify(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const certificate = await workspaceCertificatesStore(workspace, dataConfig).get(req.params['certificateId'] ?? '');
    const v = await verifyCertificateNow(workspace, dataConfig, certificate);
    return json(200, {
      certificateId: certificate.certificateId,
      status: certificate.status,
      startAllowed: v.ok,
      ...(v.ok ? {} : { reasons: v.reasons }),
    });
  }

  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/readiness', guarded(issue));
  router.get('/workspaces/:workspaceId/readiness-certificates', guarded(list));
  router.get('/workspaces/:workspaceId/readiness-certificates/:certificateId', guarded(get));
  router.get('/workspaces/:workspaceId/readiness-certificates/:certificateId/verify', guarded(verify));
}
