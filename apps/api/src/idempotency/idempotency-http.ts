import { ErrorCode, XoError } from '@xo/errors';
import type { AuditEventDraft } from '@xo/audit';
import type { AuditService } from '../audit/audit-service.js';
import {
  IdempotencyGate,
  type BeginInput,
  type IdempotencyClaim,
  type IdempotentResource,
  type ResourceProbe,
} from './idempotency.js';

/** What a route needs to proceed after the gate: either it owns a claim and runs the operation, or it replays a recorded resource. */
export type GatedOutcome =
  | { readonly kind: 'proceed'; readonly claim: IdempotencyClaim; readonly keyRef: string; readonly takeover: boolean }
  | { readonly kind: 'replay'; readonly resource: IdempotentResource; readonly keyRef: string; readonly recovered: boolean };

type BaseDraft = Omit<AuditEventDraft, 'type' | 'outcome'>;

export const REPLAY_HEADER: Readonly<Record<string, string>> = Object.freeze({ 'idempotent-replayed': 'true' });

/**
 * Consults the gate and turns every non-proceed outcome into the audited, explicit response the contract requires. Audit evidence
 * distinguishes the five situations (original attempt = the route's own `*.started`/`*.attempted` events; duplicate =
 * `idempotency.replayed`; recovered result = `idempotency.recovered`; conflict = `idempotency.conflict`; in flight =
 * `idempotency.in_progress`; unprovable = `idempotency.indeterminate`). Metadata carries only a 16-hex `keyRef` — never the key.
 *
 * Disclosure rule (M4): a replay RETURNS a stored result, so its audit record is a durable precondition (`requireDurable`): if it
 * cannot be written, nothing is disclosed (503). Refusals disclose nothing and are best-effort audited like every other denial.
 */
export async function gateIdempotent(
  gate: IdempotencyGate,
  audit: AuditService,
  base: BaseDraft,
  input: BeginInput,
): Promise<GatedOutcome> {
  const outcome = await gate.begin(input);
  const meta = (extra: Record<string, string | number | boolean> = {}) => ({
    ...(base.metadata ?? {}),
    keyRef: outcome.keyRef,
    ...extra,
  });
  const refuse = async (type: AuditEventDraft['type'], reasonCode: string, error: XoError): Promise<never> => {
    await audit.tryRecord({ ...base, type, outcome: 'denied', reasonCode, metadata: meta() });
    throw error;
  };

  switch (outcome.kind) {
    case 'proceed':
      return outcome;
    case 'replay':
      await audit.requireDurable({
        ...base,
        type: outcome.recovered ? 'idempotency.recovered' : 'idempotency.replayed',
        outcome: 'allowed',
        metadata: meta({ resourceKind: outcome.resource.kind }),
      });
      return outcome;
    case 'conflict':
      return refuse(
        'idempotency.conflict',
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        new XoError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'this Idempotency-Key was already used for a different request; nothing was executed'),
      );
    case 'in_progress':
      return refuse(
        'idempotency.in_progress',
        ErrorCode.IDEMPOTENCY_IN_PROGRESS,
        new XoError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'the operation for this Idempotency-Key is still running; retry later with the same key'),
      );
    case 'outcome_unknown':
      return refuse(
        'idempotency.indeterminate',
        ErrorCode.IDEMPOTENCY_OUTCOME_UNKNOWN,
        new XoError(
          ErrorCode.IDEMPOTENCY_OUTCOME_UNKNOWN,
          'the earlier attempt for this Idempotency-Key was interrupted and its outcome cannot be established; it was NOT re-run. Inspect the named resource, then use a new key to run it again',
          { context: { resourceKind: outcome.resource.kind, resourceId: outcome.resource.id } },
        ),
      );
    case 'invalid_record':
      return refuse(
        'idempotency.indeterminate',
        ErrorCode.IDEMPOTENCY_RECORD_INVALID,
        new XoError(ErrorCode.IDEMPOTENCY_RECORD_INVALID, 'the stored idempotency record for this key is invalid; nothing was executed'),
      );
    case 'unavailable':
      // Storage could not establish the claim: fail closed, nothing executed.
      throw outcome.error;
  }
}

/** The fields a replayed resource must match before it is disclosed: it must be THIS workspace's, THIS principal's, THIS request's. */
export function resourceMatchesRequest(
  record: { readonly workspaceId: string; readonly identityId: string } & Readonly<Record<string, unknown>>,
  expected: { readonly workspaceId: string; readonly identityId: string } & Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(([k, v]) => record[k] === v);
}

export const recordInvalid = (): XoError =>
  new XoError(ErrorCode.IDEMPOTENCY_RECORD_INVALID, 'the stored result for this idempotency key is not available; nothing was executed');

export type { ResourceProbe };
