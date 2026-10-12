import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import type { XoError } from '@xo/errors';
import { evaluateApproval, type ApprovalStore, type ApprovalVerdict, type CurrentApprovalState, type ExpectedApprovalTarget } from './approval.js';

/**
 * P1.0 M3 — the one enforcement entry point. Every place that is about to act on an approval (execution route, workflow runner,
 * human-task resume, capability projections) calls this with the capability state it DERIVED from the graph it is about to use,
 * never a state handed to it by a client or recalled from an earlier request. `current` is a `Result` so a capability whose state
 * cannot be derived is reported as `state_unavailable` (a denial), not silently skipped.
 *
 * A storage failure while reading the record is `err` (callers surface it as before); every other non-approval is a verdict value.
 */
export async function verifyApproval(
  approvals: ApprovalStore,
  expected: ExpectedApprovalTarget,
  current: Result<CurrentApprovalState, XoError>,
): Promise<Result<ApprovalVerdict, XoError>> {
  const lookup = await approvals.lookup(expected.compilationId, expected.capabilityId);
  if (!lookup.ok) return err(lookup.error);
  return ok(evaluateApproval(lookup.value, expected, current.ok ? current.value : undefined));
}
