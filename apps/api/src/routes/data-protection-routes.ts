/**
 * UW-14c–e (ADR 0037) — a workspace's data protection over HTTP.
 *
 *   GET  /workspaces/:ws/data-protection         what is protected: the settings, and which spreadsheet columns feed the dictionary
 *                                                (headers and counts; values only for those an administrator typed in). Manage role.
 *   PUT  /workspaces/:ws/data-protection         change the settings (manage role, recent sign-in). Audited with counts only.
 *   POST /workspaces/:ws/data-protection/scan    what the leak guard would find in a text, and the text as a hosted model would be
 *                                                allowed to see it (each value replaced by its kind). Read role.
 */
import { actorFromPrincipal } from '@xo/audit';
import { ErrorCode, XoError } from '@xo/errors';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest } from '../http/types.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { parseSettings, readSettings, writeSettings, type DataProtection } from '../protection/data-protection.js';

const MAX_SCAN_CHARS = 100_000;

export function registerDataProtectionRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  protection: DataProtection,
): void {
  const auditCtx = { audit, workspaceStore };
  const body = async (req: ApiRequest, allowed: readonly string[]): Promise<Record<string, unknown>> => {
    const b = await req.json<Record<string, unknown>>();
    if (!b.ok) throw b.error;
    if (typeof b.value !== 'object' || b.value === null || Array.isArray(b.value))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the body is a JSON object');
    const unknown = Object.keys(b.value).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ').slice(0, 200)}`);
    return b.value;
  };

  router.get('/workspaces/:workspaceId/data-protection', async (req) => {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'see data protection' });
    const settings = await readSettings(workspace, dataConfig);
    const built = await protection.dictionary(workspace);
    return json(200, {
      settings,
      dictionary: {
        knownValues: built.knownValues,
        truncated: built.truncated,
        columns: built.columns,
        unreadableSources: built.unreadable,
      },
    });
  });

  router.put('/workspaces/:workspaceId/data-protection', async (req) => {
    const correlationId = newCorrelationId();
    const action = 'data-protection.update';
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action });
    await requireRecentAuthentication(req, workspace, dataConfig, action);
    const principal = requirePrincipal(req);
    const b = await body(req, ['values', 'protectColumns', 'ignoreColumns', 'expectedRevision']);
    const current = await readSettings(workspace, dataConfig);
    if (b['expectedRevision'] !== undefined && b['expectedRevision'] !== current.revision)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the settings changed (revision ${current.revision}); reload and try again`);
    const next = {
      schema: 'xo.data-protection/1' as const,
      ...parseSettings(b, current),
      updatedAt: new Date().toISOString(),
      updatedBy: principal.id,
    };
    await writeSettings(workspace, dataConfig, next);
    await audit.tryRecord({
      action,
      actor: actorFromPrincipal(principal),
      correlationId,
      target: { kind: 'workspace', id: workspace.workspaceId, workspaceId: workspace.workspaceId },
      type: 'data-protection.updated',
      outcome: 'completed',
      metadata: {
        revision: next.revision,
        values: next.values.length,
        protectColumns: next.protectColumns.length,
        ignoreColumns: next.ignoreColumns.length,
      },
    });
    return json(200, { settings: next });
  });

  router.post('/workspaces/:workspaceId/data-protection/scan', async (req) => {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'check a text for protected values' });
    const b = await body(req, ['text']);
    const text = b['text'];
    if (typeof text !== 'string' || text.length > MAX_SCAN_CHARS)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `"text" is a string of at most ${MAX_SCAN_CHARS} characters`);
    const { scanner } = await protection.dictionary(workspace);
    const masked = scanner.mask(text);
    return json(200, {
      blocked: masked.hits.length > 0,
      // Where and what kind, by position in the caller's own text; never the value, never which dictionary entry it was.
      hits: masked.hits.map((h) => ({
        entity: h.entity,
        detector: h.detector,
        start: h.start,
        end: h.end,
        hash: h.hash,
        ...(h.encoded !== undefined ? { encoded: h.encoded } : {}),
      })),
      masked: masked.text,
    });
  });
}
