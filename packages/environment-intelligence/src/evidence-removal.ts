import { resourceScope } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuditReceipt } from './audit.js';
import { auditDenial, beginAudit } from './audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import type { ConnectorContext } from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import { EVIDENCE_LIFECYCLE_RESOURCE, PURGE_EVIDENCE_PERMISSION, type EvidencePurgeTarget } from './evidence-lifecycle.js';
import { ConnectorId, type EvidenceId, type SourceId } from './ids.js';
import type { EnvironmentInventory } from './inventory.js';
import { resourceDigestOf } from './ingestion.js';
import { requireOperationalState, trustFromContext } from './state-journal.js';

const CONNECTOR = ConnectorId('xo.environment-intelligence');
/** The most resources one removal may name, so a single request cannot become an unbounded journal write. */
export const MAX_REMOVAL_RESOURCES = 200;

export interface ResourceRemovalRequest {
  readonly sourceId: SourceId;
  /** The evidence kind the resources were ingested as (for the local filesystem: `document_content`). */
  readonly kind: string;
  /** Source-relative resource keys whose retained evidence should be retired. */
  readonly resourceKeys: readonly string[];
  readonly operationId?: string;
  /** Holders of copies (the knowledge model, staged payloads). They delete AFTER the ledger has made the evidence ineligible. */
  readonly targets?: readonly EvidencePurgeTarget[];
}

export interface ResourceRemovalResult {
  readonly operationId: string;
  readonly sourceId: SourceId;
  /** Evidence ids retired. Resources that held no retained evidence are simply absent (idempotent). */
  readonly evidenceIds: readonly EvidenceId[];
  readonly receipt: AuditReceipt;
}

/**
 * C7 - "remove what XO learned" for CHOSEN ITEMS, separate from excluding them and from removing the source.
 *
 * Authorization is the same `data.delete` decision a source purge needs, and the operation is audited write-ahead. Ordering follows the
 * ingestion retirements: the ledger purge is applied first (the evidence is ineligible from that instant), then the retirement is
 * journaled with reason `removed` (a restart cannot bring it back), then the holders delete their copies. The source's authorization,
 * its checkpoint and every other item are untouched. Requires the durable state store: the resource index lives there.
 *
 * CALLER CONTRACT: a later authorized read that returns an item releases its evidence again (the ledger deliberately lets a NEW authorized,
 * audited release make an id eligible). Removing what was learned does not by itself stop reading: a caller must also take the items out of
 * scope (for the local filesystem, out of `includeKeys`), or the next read learns them again.
 */
export async function removeResourceEvidence(
  deps: { readonly inventory: EnvironmentInventory },
  request: ResourceRemovalRequest,
  ctx: ConnectorContext,
): Promise<Result<ResourceRemovalResult, DiscoveryError>> {
  const operation = 'purge_evidence' as const;
  const permission = PURGE_EVIDENCE_PERMISSION;
  const scope = resourceScope(EVIDENCE_LIFECYCLE_RESOURCE);

  const who = requireAuthenticatedPrincipal(ctx.principal, permission);
  if (!who.ok) return who;
  // ENFORCE:resource-removal-authorized
  const gate = await requireAuthorization(ctx.authorization, {
    connectorId: CONNECTOR,
    operation,
    permission,
    scope,
    principal: ctx.principal as NonNullable<ConnectorContext['principal']>,
    reason: 'retire the retained evidence of chosen items',
  });
  if (!gate.ok) {
    await auditDenial(ctx, { operation, connectorId: CONNECTOR, permission, scope, error: gate.error });
    return gate;
  }
  if (request.resourceKeys.length === 0 || request.resourceKeys.length > MAX_REMOVAL_RESOURCES)
    return err(
      discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, `name between 1 and ${MAX_REMOVAL_RESOURCES} resources`, { field: 'resourceKeys' }),
    );
  if (deps.inventory.get(request.sourceId) === undefined)
    return err(discoveryError(DiscoveryErrorCode.INVALID_TRANSITION, 'source is not in the inventory', { operation }));
  const state = ctx.state;
  const trust = trustFromContext(ctx);
  if (state === undefined || trust === undefined)
    return err(
      discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'removing the evidence of chosen items requires the durable state store', {
        phase: 'removal',
        outcome: 'config',
      }),
    );
  const guard = requireOperationalState(ctx);
  if (!guard.ok) return guard;

  const session = await beginAudit(
    ctx,
    { operation, connectorId: CONNECTOR, connectorVersion: '1', permission, scope, allow: gate.value, sourceId: request.sourceId },
    request.operationId,
  );
  if (!session.ok) return session;
  const operationId = session.value.operationId;

  try {
    const index = state.ingestedResources(request.sourceId);
    const items: { rd: string; evidenceId: string }[] = [];
    for (const key of new Set(request.resourceKeys)) {
      const rd = resourceDigestOf(request.sourceId, request.kind, key);
      for (const evidenceId of index.get(rd) ?? []) items.push({ rd, evidenceId });
    }
    const retired = await state.retireEvidence(trust, { operationId, sourceId: request.sourceId, items });
    // A journal failure is returned (never thrown) and leaves the audit attempt OPEN with no terminal event: whether the write landed is
    // unknown, and recording `failed` could contradict the durable state. A retry with the same operationId completes it.
    if (!retired.ok)
      return err(
        discoveryError(retired.error.code, retired.error.message, {
          ...retired.error.context,
          operationId,
          attemptOpen: true,
          completionAudited: false,
        }),
      );
    const ids = retired.value.retired as readonly EvidenceId[];
    for (const target of request.targets ?? []) await target.purge(ids);
    const receipt = await session.value.complete('purged', { evidenceIds: ids });
    if (receipt === undefined)
      return err(
        discoveryError(
          DiscoveryErrorCode.AUDIT_UNAVAILABLE,
          'the completion audit was not accepted; the change was applied but is not reported as audited (retry with the same operationId)',
          { phase: 'completion', operationId, applied: true, completionAudited: false },
        ),
      );
    return ok({ operationId, sourceId: request.sourceId, evidenceIds: ids, receipt });
  } catch (e) {
    const failure = internalError(e, 'remove resource evidence');
    const receipt = await session.value.complete('failed', { errorCode: failure.code });
    return err(discoveryError(failure.code, failure.message, { ...failure.context, operationId, failureAudited: receipt !== undefined }));
  }
}
