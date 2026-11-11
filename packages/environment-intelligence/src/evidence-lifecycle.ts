import { resourceScope } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuditReceipt } from './audit.js';
import { auditDenial, beginAudit } from './audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import type { ConnectorContext } from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import type { EvidenceLedger } from './evidence-ledger.js';
import { ConnectorId, type EvidenceId, type SourceId } from './ids.js';
import type { EnvironmentInventory } from './inventory.js';
import { requireOperationalState, trustFromContext } from './state-journal.js';

/**
 * Revocation and purge of released evidence (M2.2).
 *
 * Both are PROTECTED operations: authenticated principal, an authorization decision through the same enforcement
 * point as reads, a write-ahead audit attempt accepted before anything changes, and a terminal audit record
 * (`revoked` / `purged` / `failed`). Neither erases audit history: the audit trail only ever grows, and a purge
 * leaves a `purged` receipt that names the evidence ids (opaque hashes) it covered.
 *
 * Fail-safe ordering: revoking makes evidence INELIGIBLE immediately and before any holder is asked to delete
 * anything, so a failure part-way through a purge can leave evidence revoked-but-not-yet-deleted (still
 * ineligible), never deleted-but-still-selectable.
 *
 * AUTHORIZATION (PROVISIONAL, same status as `declare_sources`): `data.write` (revoke) / `data.delete` (purge) on the
 * resource `environment-intelligence/evidence-lifecycle` reuse the existing permission vocabulary; adding dedicated
 * ids is a P1.0 owner decision.
 *
 * RETRY: pass the same `operationId` to retry. The attempt and terminal events are idempotent, so a retry after an
 * unconfirmed completion write returns the original receipt instead of creating a contradictory second outcome.
 */
export const EVIDENCE_LIFECYCLE_RESOURCE = 'environment-intelligence/evidence-lifecycle';
export const REVOKE_EVIDENCE_PERMISSION = 'data.write';
export const PURGE_EVIDENCE_PERMISSION = 'data.delete';
const LIFECYCLE_CONNECTOR = ConnectorId('xo.environment-intelligence');

/** A holder of released evidence (a cache, a store, a downstream index) that can delete its copies by id. */
export interface EvidencePurgeTarget {
  /** Deletes the holder's copies of these evidence ids. Resolves only once they are gone; rejects otherwise. */
  purge(ids: readonly EvidenceId[]): Promise<void>;
}

export interface EvidenceLifecycleDeps {
  readonly inventory: EnvironmentInventory;
  readonly ledger: EvidenceLedger;
}

export interface EvidenceLifecycleRequest {
  readonly sourceId: SourceId;
  /** Supply the same id to retry an operation whose completion audit was not confirmed. */
  readonly operationId?: string;
}

export interface EvidenceLifecycleResult {
  readonly operationId: string;
  readonly outcome: 'revoked' | 'purged';
  readonly sourceId: SourceId;
  /** Evidence ids (opaque hashes) covered by this outcome. */
  readonly evidenceIds: readonly EvidenceId[];
  readonly receipt: AuditReceipt;
}

async function runLifecycle(
  kind: 'revoke' | 'purge',
  deps: EvidenceLifecycleDeps,
  request: EvidenceLifecycleRequest & { readonly targets?: readonly EvidencePurgeTarget[] },
  ctx: ConnectorContext,
): Promise<Result<EvidenceLifecycleResult, DiscoveryError>> {
  const operation = kind === 'revoke' ? 'revoke_evidence' : 'purge_evidence';
  const permission = kind === 'revoke' ? REVOKE_EVIDENCE_PERMISSION : PURGE_EVIDENCE_PERMISSION;
  const scope = resourceScope(EVIDENCE_LIFECYCLE_RESOURCE);

  const who = requireAuthenticatedPrincipal(ctx.principal, permission);
  if (!who.ok) return who;
  const gate = await requireAuthorization(ctx.authorization, {
    connectorId: LIFECYCLE_CONNECTOR,
    operation,
    permission,
    scope,
    principal: ctx.principal as NonNullable<ConnectorContext['principal']>,
    reason: `${kind} released evidence of one source`,
  });
  if (!gate.ok) {
    await auditDenial(ctx, { operation, connectorId: LIFECYCLE_CONNECTOR, permission, scope, error: gate.error });
    return gate;
  }
  const record = deps.inventory.get(request.sourceId);
  if (record === undefined) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_TRANSITION, 'source is not in the inventory', { operation }));
  }
  // C0.4: a non-operational durable store refuses the operation before any audit attempt (no memory-only fallback).
  const stateGuard = requireOperationalState(ctx);
  if (!stateGuard.ok) return stateGuard;

  // Write-ahead: nothing changes until the attempt is accepted.
  const session = await beginAudit(
    ctx,
    {
      operation,
      connectorId: LIFECYCLE_CONNECTOR,
      connectorVersion: '1',
      permission,
      scope,
      allow: gate.value,
      sourceId: request.sourceId,
    },
    request.operationId,
  );
  if (!session.ok) return session;
  const operationId = session.value.operationId;
  const at = ctx.clock.now().toISOString();

  let covered: readonly EvidenceId[];
  const state = ctx.state;
  const trust = trustFromContext(ctx);
  // C0.4. A failure of the STATE JOURNAL is returned (never thrown) and leaves the audit attempt OPEN with NO terminal event: the
  // outcome of the journal write may be unknown (it may have landed), so recording `failed` could contradict the durable state.
  // A retry with the same operationId completes it (intent, revoke and terminal are all idempotent), before or after a restart.
  // A definite failure of a purge HOLDER is different: the state is known (revoked, not purged), and it is audited as `failed`
  // exactly as without a durable store.
  const stateFailure = (e: DiscoveryError): Result<EvidenceLifecycleResult, DiscoveryError> =>
    err(discoveryError(e.code, e.message, { ...e.context, operationId, attemptOpen: true, completionAudited: false }));
  try {
    if (state !== undefined) {
      // Durable ordering (docs/environment-intelligence/c0-4-state-journal.md): write-ahead INTENT, then revoke (memory first, then
      // the journaled transition), then - only for purge, only after every holder deleted - the purged transition.
      if (trust === undefined)
        return stateFailure(
          discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'no trusted principal for the state journal', {
            phase: 'intent',
            outcome: 'rejected',
          }),
        );
      const begun = await state.beginLifecycle(trust, {
        kind,
        operationId,
        sourceId: request.sourceId,
        at,
        auditEventId: session.value.attemptEventId,
      });
      if (!begun.ok) return stateFailure(begun.error);
      const revoked = await state.applyRevoke(trust, { operationId, sourceId: request.sourceId, at });
      if (!revoked.ok) return stateFailure(revoked.error);
    } else {
      deps.inventory.apply(request.sourceId, 'authorization_revoked', at);
      deps.ledger.revokeSource(request.sourceId, operationId);
    }
    if (kind === 'revoke') {
      covered = deps.ledger.idsOf(request.sourceId, ['revoked', 'purged']);
    } else {
      // Already ineligible (revoked above). Ask every holder to delete; only then mark purged.
      const toPurge = deps.ledger.idsOf(request.sourceId, ['revoked']);
      for (const target of request.targets ?? []) await target.purge(toPurge);
      if (state !== undefined) {
        // With a durable store configured there is NO in-memory fallback, even structurally: a missing trusted principal is a failure.
        if (trust === undefined)
          return stateFailure(
            discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'no trusted principal for the state journal', {
              phase: 'purge',
              outcome: 'rejected',
            }),
          );
        const purged = await state.applyPurge(trust, { operationId, sourceId: request.sourceId, at });
        if (!purged.ok) return stateFailure(purged.error);
      } else {
        deps.ledger.purgeSource(request.sourceId, operationId);
        deps.inventory.markPurged(request.sourceId, at);
      }
      covered = deps.ledger.idsOf(request.sourceId, ['purged']);
    }
  } catch (e) {
    const failure = internalError(e, `${kind} evidence`);
    const receipt = await session.value.complete('failed', { errorCode: failure.code });
    // The failure is the answer either way; whether it was recorded is reported, never hidden.
    return err(discoveryError(failure.code, failure.message, { ...failure.context, operationId, failureAudited: receipt !== undefined }));
  }

  const outcome = kind === 'revoke' ? 'revoked' : 'purged';
  const receipt = await session.value.complete(outcome, { evidenceIds: covered });
  if (receipt === undefined) {
    // The change IS applied (and is the safe direction), but it is not reported as completed-and-audited.
    return err(
      discoveryError(
        DiscoveryErrorCode.AUDIT_UNAVAILABLE,
        'the completion audit was not accepted; the change was applied but is not reported as audited (retry with the same operationId)',
        { phase: 'completion', operationId, applied: true, completionAudited: false },
      ),
    );
  }
  return ok({ operationId, outcome, sourceId: request.sourceId, evidenceIds: covered, receipt });
}

/** Withdraws authorization for a source and makes its released evidence ineligible. Audited; never erases audit history. */
export function revokeSourceEvidence(
  deps: EvidenceLifecycleDeps,
  request: EvidenceLifecycleRequest,
  ctx: ConnectorContext,
): Promise<Result<EvidenceLifecycleResult, DiscoveryError>> {
  return runLifecycle('revoke', deps, request, ctx);
}

/** Revokes, asks every holder to delete its copies, then marks the evidence purged. Audited; leaves a `purged` receipt. */
export function purgeSourceEvidence(
  deps: EvidenceLifecycleDeps,
  request: EvidenceLifecycleRequest & { readonly targets?: readonly EvidencePurgeTarget[] },
  ctx: ConnectorContext,
): Promise<Result<EvidenceLifecycleResult, DiscoveryError>> {
  return runLifecycle('purge', deps, request, ctx);
}
