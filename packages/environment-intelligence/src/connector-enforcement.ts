import { isAuthenticatedPrincipal, principalsEqual, toPrincipalSnapshot, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import {
  isReceiptFor,
  type AuditOperation,
  type AuditRecordRequest,
  type AuditRecorder,
  type AuditReceipt,
  type AuditError,
  type AuditTrust,
} from './audit.js';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { requireAuthenticatedPrincipal } from './authorization-gate.js';
import type { Connector, ConnectorContext, ConnectorOperation, DiscoveryScopeBase } from './connector.js';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from './errors.js';
import type { Evidence } from './evidence.js';
import { stableDigest, type SourceId } from './ids.js';
import { trustFromContext } from './state-journal.js';
import { wasHonoured } from './trusted-decision.js';

/**
 * C1 / D6(A) - framework-verified authorization and audit.
 *
 * Before C1 the orchestrator marked a source authorized and connected whenever a connector's `validateConnection` returned `ok`,
 * and nothing outside the connector checked that an authorization decision or an audit record had actually happened. A connector
 * that skipped them (a mock, a future third-party connector) was indistinguishable from one that did not.
 *
 * Now the orchestrator hands every connector call a context whose `authorization` and `audit` are TRACKING wrappers, runs the
 * call, and only accepts an `ok` result if the framework itself observed:
 *   - every authorization request made during the call was for the expected connector, operation, permission and the
 *     authenticated principal, AND was honoured by `requireAuthorization` (the single enforcement point), and at least one was; and
 *   - for audited operations (discover, acquire_content, incremental_sync), an ACCEPTED write-ahead attempt followed by an
 *     ACCEPTED terminal record for the same operation id, naming the expected source and permission.
 * Nothing about the `Connector` interface changes: a conforming connector already does all of this, so it cannot tell.
 *
 * "Honoured" is derived from a module-private registry that only `requireAuthorization` writes (`trusted-decision.ts`), never
 * from a field of the decision, so a connector cannot fake it. A connector that bypasses the gate (never asks, asks for a
 * different permission - e.g. list instead of read - asks as a different principal, or calls the port directly and ignores the
 * outcome) fails with `EI_AUTHORIZATION_UNVERIFIED`. Limitation, as with the rest of the trust model: this is an in-process
 * guarantee against a connector that is wrong or careless, not a sandbox against code that can import internal modules.
 */

interface SpentRequest {
  readonly connectorId: string;
  readonly operation: string;
  readonly permission: string;
  readonly principal: Principal | undefined;
  decision: AuthorizationDecision | undefined;
}

export interface ExpectedAuthorization {
  readonly connectorId: string;
  readonly operation: ConnectorOperation;
  readonly permission: string;
  readonly principal: Principal;
}

const unverified = (expected: ExpectedAuthorization, reason: string): DiscoveryError =>
  discoveryError(
    DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED,
    'the connector result is not backed by an authorization decision the framework observed being honoured',
    { operation: expected.operation, permission: expected.permission, reason },
  );

/** An `AuthorizationPort` that forwards to the real one and remembers what was asked and answered, for one connector call. */
export class TrackingAuthorization implements AuthorizationPort {
  private readonly spent: SpentRequest[] = [];

  constructor(private readonly inner: AuthorizationPort) {}

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const entry: SpentRequest = {
      connectorId: request.connectorId,
      operation: request.operation,
      permission: request.permission,
      principal: isAuthenticatedPrincipal(request.principal) ? toPrincipalSnapshot(request.principal) : undefined,
      decision: undefined,
    };
    this.spent.push(entry);
    const decision = await this.inner.decide(request);
    entry.decision = decision;
    return decision;
  }

  /** `ok` only if at least one request was made and EVERY request made during the call matches `expected` and was honoured. */
  verify(expected: ExpectedAuthorization): Result<void, DiscoveryError> {
    if (this.spent.length === 0) return err(unverified(expected, 'no_authorization_requested'));
    for (const s of this.spent) {
      if (s.connectorId !== expected.connectorId || s.operation !== expected.operation)
        return err(unverified(expected, 'other_operation_authorized'));
      if (s.permission !== expected.permission) return err(unverified(expected, 'other_permission_authorized'));
      if (s.principal === undefined || !principalsEqual(s.principal, expected.principal))
        return err(unverified(expected, 'other_principal'));
      if (!wasHonoured(s.decision)) return err(unverified(expected, 'decision_not_honoured'));
    }
    return ok(undefined);
  }
}

interface AcceptedAudit {
  readonly seq: number;
  readonly operationId: string;
  readonly phase: AuditRecordRequest['phase'];
  readonly outcome: AuditRecordRequest['outcome'];
  readonly operation: AuditOperation;
  readonly connectorId: string;
  readonly permission: string;
  readonly sourceId: string | undefined;
}

export interface ExpectedAudit {
  readonly operation: AuditOperation;
  readonly connectorId: string;
  readonly permission: string;
  readonly sourceId: SourceId;
}

/** An `AuditRecorder` that forwards to the real one and remembers which events it ACCEPTED (an `ok` receipt naming the event). */
export class TrackingAuditRecorder implements AuditRecorder {
  private readonly accepted: AcceptedAudit[] = [];

  constructor(private readonly inner: AuditRecorder) {}

  async record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    const result = await this.inner.record(event, trust);
    if (result.ok && isReceiptFor(result.value, event)) {
      this.accepted.push({
        seq: this.accepted.length,
        operationId: event.operationId,
        phase: event.phase,
        outcome: event.outcome,
        operation: event.operation,
        connectorId: event.connectorId,
        permission: event.permission,
        sourceId: event.sourceId,
      });
    }
    return result;
  }

  /** `ok` only if an accepted attempt for the expected operation/source/permission is followed by an accepted completed/cancelled terminal record of the same operation. */
  verify(expected: ExpectedAudit): Result<void, DiscoveryError> {
    const fail = (reason: string): Result<void, DiscoveryError> =>
      err(
        discoveryError(
          DiscoveryErrorCode.AUDIT_UNAVAILABLE,
          'the framework did not observe an accepted attempt and terminal audit record for this operation',
          { phase: 'enforcement', operation: expected.operation, reason },
        ),
      );
    const matches = (a: AcceptedAudit): boolean =>
      a.operation === expected.operation &&
      a.connectorId === expected.connectorId &&
      a.permission === expected.permission &&
      a.sourceId === expected.sourceId;
    const attempts = this.accepted.filter((a) => a.phase === 'attempt' && a.outcome === 'attempted' && matches(a));
    if (attempts.length === 0) return fail('attempt_missing');
    const closed = attempts.some((attempt) =>
      this.accepted.some(
        (t) =>
          t.phase === 'terminal' &&
          t.operationId === attempt.operationId &&
          t.seq > attempt.seq &&
          matches(t) &&
          (t.outcome === 'completed' || t.outcome === 'cancelled'),
      ),
    );
    return closed ? ok(undefined) : fail('terminal_missing');
  }
}

export interface EnforcedOptions {
  /** Operations that read protected content (discover, acquire_content, incremental_sync) need an accepted attempt + terminal audit. */
  readonly audited: boolean;
  /** The source the audit records must name. Required when `audited`. */
  readonly sourceId?: SourceId;
  /**
   * Operations that return evidence. A connector's own completion audit has already RELEASED that evidence in the ledger (and the
   * durable journal, when configured) by the time verification runs, so a result rejected here has its evidence QUARANTINED
   * (ineligible) rather than merely not returned. Uses the existing C0.4 `quarantine` APIs; adds no state or schema.
   */
  readonly evidenceOf?: (value: never) => readonly Evidence[];
  /** Source ids the returned evidence may name. Evidence naming anything else (or another connector/principal) is rejected and quarantined. */
  readonly expectedSourceIds?: readonly SourceId[];
}

async function containUnverified(ctx: ConnectorContext, evidence: readonly Evidence[]): Promise<void> {
  if (evidence.length === 0) return;
  const operationId = `unverified_${stableDigest(evidence.map((e) => e.id as string).sort()).slice(0, 24)}`;
  try {
    const trust = trustFromContext(ctx);
    if (ctx.state !== undefined && trust !== undefined) await ctx.state.quarantine(trust, operationId, evidence);
    else ctx.ledger?.quarantine(operationId, evidence);
  } catch {
    // Containment is best effort on top of a rejection that already withholds the result; it never turns a rejection into success.
  }
}

/**
 * Runs one connector operation under tracking and verifies the result. A failure result from the connector is returned as is
 * (nothing succeeded, so there is nothing to verify). An `ok` result is returned only if it is backed by what the framework observed.
 */
export async function runEnforced<T, TScope extends DiscoveryScopeBase>(
  connector: Connector<TScope>,
  operation: ConnectorOperation,
  ctx: ConnectorContext,
  call: (ctx: ConnectorContext) => Promise<Result<T, DiscoveryError>>,
  options: EnforcedOptions,
): Promise<Result<T, DiscoveryError>> {
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const d = connector.descriptor;
  if (d.operations[operation] !== 'supported') {
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'connector does not support this operation', { connector: d.id, operation }),
    );
  }
  const permission = d.requiredPermissions[operation];
  const expected: ExpectedAuthorization | undefined =
    permission === undefined ? undefined : { connectorId: d.id, operation, permission, principal: who.value };
  const authorization = new TrackingAuthorization(ctx.authorization);
  const audit = ctx.audit === undefined ? undefined : new TrackingAuditRecorder(ctx.audit);
  const tracked: ConnectorContext = { ...ctx, authorization, ...(audit !== undefined ? { audit } : {}) };

  const result = await call(tracked);
  if (!result.ok) return result;
  const evidence = options.evidenceOf === undefined ? [] : options.evidenceOf(result.value as never);
  const reject = async (error: DiscoveryError): Promise<Result<T, DiscoveryError>> => {
    await containUnverified(ctx, evidence);
    return err(error);
  };

  if (expected === undefined) {
    return reject(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED, 'the connector does not declare the permission this operation requires', {
        operation,
        reason: 'permission_undeclared',
      }),
    );
  }
  const authorized = authorization.verify(expected);
  if (!authorized.ok) return reject(authorized.error);
  if (options.audited) {
    if (audit === undefined || options.sourceId === undefined) {
      return reject(
        discoveryError(DiscoveryErrorCode.AUDIT_UNAVAILABLE, 'no audit recorder is configured; protected evidence access is refused', {
          phase: 'enforcement',
          operation,
        }),
      );
    }
    const audited = audit.verify({ operation, connectorId: d.id, permission: expected.permission, sourceId: options.sourceId });
    if (!audited.ok) return reject(audited.error);
  }
  if (options.expectedSourceIds !== undefined) {
    const foreign = evidenceIdentityProblem(evidence, { connectorId: d.id, principal: who.value, sourceIds: options.expectedSourceIds });
    if (foreign !== undefined) return reject(foreign);
  }
  return result;
}

/** What the framework knows to be true, against which a connector's returned identity claims are compared. The connector's claims never win. */
export interface ExpectedIdentity {
  readonly connectorId: string;
  readonly principal: Principal;
  readonly sourceIds: readonly SourceId[];
}

export const identityMismatch = (what: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the connector result does not match the identity the framework established', {
    what,
  });

/**
 * Evidence a connector returns must name the source the framework is operating on, the connector that was invoked and - when it
 * carries one - the authenticated principal. A connector cannot widen, redirect or re-attribute its own results.
 */
export function evidenceIdentityProblem(evidence: readonly Evidence[], expected: ExpectedIdentity): DiscoveryError | undefined {
  for (const e of evidence) {
    if (!expected.sourceIds.includes(e.sourceId) || !expected.sourceIds.includes(e.provenance.sourceId))
      return identityMismatch('evidence_source');
    if (e.provenance.connectorId !== expected.connectorId) return identityMismatch('evidence_connector');
    const p = e.provenance.access.principal;
    if (p !== undefined && !principalsEqual(p, expected.principal)) return identityMismatch('evidence_principal');
  }
  return undefined;
}
