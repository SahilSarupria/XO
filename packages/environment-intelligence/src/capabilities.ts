import { resourceScope } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import { auditDenial, beginAudit } from './audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import type { ConnectorContext } from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import { ConnectorId } from './ids.js';

/**
 * C7 - the effective-capabilities query: "what may this caller do?", answered by the SAME authorization gate that enforces the actions.
 *
 * It is ADVISORY by construction: it tells an interface which actions to offer. Every real action is decided again when it runs, with
 * its own (usually narrower, per-resource) decision, so a stale or wrong answer here can never grant anything.
 *
 * `reviewKnowledge` additionally requires a human principal: C6 refuses review decisions from anything else, so offering it would be a lie.
 *
 * Roles do not exist. A capability is a (permission, resource) pair the gate was asked about; nothing else.
 *
 * AUDIT: each probe is audited like any protected operation. An allowed probe is a write-ahead `attempt` accepted BEFORE it counts, then
 * a `completed` record; if the attempt cannot be accepted the whole query fails closed (`EI_AUDIT_UNAVAILABLE`) and returns nothing. A
 * denied probe is recorded as a standalone `denied` event (best-effort, like every denial: it already blocks the capability).
 */
const CONNECTOR = ConnectorId('xo.environment-intelligence');
const AUDIT_SUBJECT = 'ei-capabilities';

export const CAPABILITY_PROBES = Object.freeze([
  { name: 'viewSources', permission: 'data.read', resource: 'environment-intelligence/inventory' },
  { name: 'manageSources', permission: 'data.write', resource: 'environment-intelligence/inventory' },
  { name: 'readKnowledge', permission: 'data.read', resource: 'environment-intelligence/knowledge' },
  { name: 'reviewKnowledge', permission: 'data.write', resource: 'environment-intelligence/knowledge/review' },
] as const);

export type CapabilityName = (typeof CAPABILITY_PROBES)[number]['name'];
export type CapabilitySet = Readonly<Record<CapabilityName, boolean>>;

export async function queryCapabilities(ctx: ConnectorContext): Promise<Result<CapabilitySet, DiscoveryError>> {
  // ENFORCE:capabilities-authenticated (before any port is consulted)
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const result: Record<string, boolean> = {};
  for (const probe of CAPABILITY_PROBES) {
    const scope = resourceScope(probe.resource);
    const gate = await requireAuthorization(ctx.authorization, {
      connectorId: CONNECTOR,
      operation: 'query_capabilities',
      permission: probe.permission,
      scope,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: 'capability query for an interface',
    });
    if (!gate.ok) {
      await auditDenial(ctx, {
        operation: 'query_capabilities',
        connectorId: CONNECTOR,
        permission: probe.permission,
        scope,
        error: gate.error,
      });
      result[probe.name] = false;
      continue;
    }
    const session = await beginAudit(ctx, {
      operation: 'query_capabilities',
      connectorId: CONNECTOR,
      connectorVersion: '1',
      permission: probe.permission,
      scope,
      allow: gate.value,
      sourceId: AUDIT_SUBJECT,
    });
    // ENFORCE:capabilities-write-ahead-audit
    if (!session.ok) return err(session.error);
    let closed: boolean;
    try {
      closed = await session.value.closeWithoutRelease('completed', { counts: {} });
    } catch (e) {
      return err(internalError(e, 'capability query'));
    }
    // ENFORCE:capabilities-terminal-audit
    if (!closed) return err(terminalNotAccepted());
    // C6 only lets a HUMAN principal record a review decision, whatever the gate says, so a non-human is never told it can review.
    result[probe.name] = probe.name !== 'reviewKnowledge' || ctx.principal?.kind === 'human';
  }
  return ok(Object.freeze({ ...result }) as CapabilitySet);
}

function terminalNotAccepted(): DiscoveryError {
  return discoveryError(DiscoveryErrorCode.AUDIT_UNAVAILABLE, 'the completion audit was not accepted; the capability answer is withheld', {
    phase: 'completion',
  });
}
