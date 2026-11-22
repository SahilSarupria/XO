import { actorFromPrincipal } from '@xo/audit';
import { ErrorCode, XoError } from '@xo/errors';
import { guessProvider } from '@xo/connectors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { parseRecipientRules, readRecipientRules, writeRecipientRules } from '../email/recipient-rules.js';
import { parseJsonBody } from '../http/body.js';

/**
 * UW-10c (ADR 0042) — email set-up over HTTP:
 *   GET /workspaces/:ws/email/recipient-rules   the explicit rules (read)
 *   PUT /workspaces/:ws/email/recipient-rules   replace them (manage role, recent sign-in, revision-guarded, audited)
 *   GET /workspaces/:ws/email/provider-guess?address=   which tier an address would get, in plain words (read)
 * People in confirmed contact lists need no rule; everything else is denied by default.
 */
export function registerEmailRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  router.get('/workspaces/:workspaceId/email/recipient-rules', async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      const workspace = await auditedOwnedWorkspace(req, auditCtx, {
        action: 'email.recipient-rules.read',
        correlationId: newCorrelationId(),
      });
      await requirePermission(req, workspace, 'read', dataConfig, { action: 'read recipient rules' });
      return json(200, await readRecipientRules(workspace, dataConfig));
    } catch (cause) {
      return errorToResponse(cause);
    }
  });

  router.put('/workspaces/:workspaceId/email/recipient-rules', async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      const correlationId = newCorrelationId();
      const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'email.recipient-rules.update', correlationId });
      await requirePermission(req, workspace, 'manage', dataConfig, { action: 'change who XO may email' });
      await requireRecentAuthentication(req, workspace, dataConfig, 'change who XO may email');
      const parsed = parseJsonBody(await req.rawBody());
      if (!parsed.ok) throw parsed.error;
      const rules = parseRecipientRules(parsed.value);
      const expected = (parsed.value as { expectedRevision?: unknown }).expectedRevision;
      const current = await readRecipientRules(workspace, dataConfig);
      if (expected !== undefined && expected !== current.revision)
        throw new XoError(
          ErrorCode.PRECONDITION_FAILED,
          `the recipient rules changed (revision ${current.revision}); reload and try again`,
        );
      const actor = requirePrincipal(req);
      const next = { revision: current.revision + 1, ...rules, updatedAt: new Date().toISOString(), updatedBy: actor.id };
      await writeRecipientRules(workspace, dataConfig, next);
      // Counts only: addresses and domains are business data and stay out of the audit trail.
      await audit.tryRecord({
        action: 'email.recipient-rules.update',
        actor: actorFromPrincipal(actor),
        correlationId,
        target: { kind: 'workspace', id: workspace.workspaceId },
        type: 'email.recipient-rules.updated',
        outcome: 'completed',
        metadata: { revision: next.revision, addresses: rules.addresses.length, domains: rules.domains.length },
      });
      return json(200, next);
    } catch (cause) {
      return errorToResponse(cause);
    }
  });

  router.get('/workspaces/:workspaceId/email/provider-guess', async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'email.provider-guess', correlationId: newCorrelationId() });
      await requirePermission(req, workspace, 'read', dataConfig, { action: 'guess the mail provider' });
      const address = req.query.get('address') ?? '';
      if (!/^[^@\s]{1,64}@[^@\s]{1,253}$/.test(address)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'address must be an email address');
      return json(200, await guessProvider(address));
    } catch (cause) {
      return errorToResponse(cause);
    }
  });
}
