import { AuditError, ErrorCode, XoError } from '@xo/errors';
import { FileAuditStore, actorFromPrincipal, type AuditAccessController, type AuditSink } from '@xo/audit';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requirePrincipal } from '../workspace/workspace-context.js';
import { newCorrelationId, type AuditService } from '../audit/audit-service.js';

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

/**
 * Audit records are restricted data. Access is default-deny and is decided at ACCESS TIME by
 * `AuditAccessController` (verified principal + currently-allowing policy for `audit.read` / `audit.purge`),
 * never by workspace ownership. Reading the audit log is itself audited (`audit.read`) BEFORE any record is returned.
 */
export function registerAuditRoutes(router: Router, audit: AuditService, sink: AuditSink, access: AuditAccessController): void {
  const store = sink instanceof FileAuditStore ? sink : undefined;

  function requireDurableStore(): FileAuditStore {
    if (store === undefined) {
      // The explicit non-production sink does not expose records; audit reading needs the durable store.
      throw new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'audit records are only readable from a durable audit store');
    }
    return store;
  }

  async function listEvents(req: ApiRequest): Promise<ApiResponse> {
    const principal = requirePrincipal(req);
    const correlationId = newCorrelationId();
    const grant = await access.authorize(principal, 'read');
    if (!grant.ok) {
      await audit.tryRecord({
        type: 'access.denied',
        action: 'read.audit-log',
        outcome: 'denied',
        actor: actorFromPrincipal(principal),
        target: { kind: 'audit-log', id: 'audit' },
        correlationId,
        reasonCode: ErrorCode.AUDIT_ACCESS_DENIED,
      });
      throw grant.error;
    }
    const s = requireDurableStore();
    await audit.requireDurable({
      type: 'audit.read',
      action: 'read.audit-log',
      outcome: 'attempted',
      actor: actorFromPrincipal(principal),
      target: { kind: 'audit-log', id: 'audit' },
      correlationId,
    });
    const afterSeq = req.query.get('afterSeq');
    const limit = req.query.get('limit');
    const correlation = req.query.get('correlationId');
    const execution = req.query.get('executionId');
    const n = (v: string | null, name: string): number | undefined => {
      if (v === null) return undefined;
      if (!/^\d{1,9}$/.test(v)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${name}" must be a non-negative integer`);
      return Number(v);
    };
    const result = await s.read(grant.value, {
      ...(correlation !== null ? { correlationId: correlation } : {}),
      ...(execution !== null ? { executionId: execution } : {}),
      ...(afterSeq !== null ? { afterSeq: n(afterSeq, 'afterSeq') as number } : {}),
      ...(limit !== null ? { limit: n(limit, 'limit') as number } : {}),
    });
    if (!result.ok) throw result.error;
    return json(200, { events: result.value.events, corruptLines: result.value.corruptLines });
  }

  async function purge(req: ApiRequest): Promise<ApiResponse> {
    const principal = requirePrincipal(req);
    const correlationId = newCorrelationId();
    const grant = await access.authorize(principal, 'purge');
    if (!grant.ok) {
      await audit.tryRecord({
        type: 'access.denied',
        action: 'purge.audit-log',
        outcome: 'denied',
        actor: actorFromPrincipal(principal),
        target: { kind: 'audit-log', id: 'audit' },
        correlationId,
        reasonCode: ErrorCode.AUDIT_ACCESS_DENIED,
      });
      throw grant.error;
    }
    const s = requireDurableStore();
    // Purge removes only records past retention (>= the configured minimum); it appends its own content-free marker.
    const result = await s.purge(grant.value);
    if (!result.ok) throw result.error;
    return json(200, { purged: result.value.purged, retained: result.value.retained });
  }

  router.get('/audit/events', guarded(listEvents));
  router.post('/audit/purge', guarded(purge));
}
