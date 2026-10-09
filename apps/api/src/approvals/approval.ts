import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';

/**
 * A minimal, workspace-scoped approval fact: has a specific identity, in
 * this specific workspace, approved this specific capability from this
 * specific compilation. Deliberately not a review workflow — no
 * comments, no multiple reviewers/quorum, no version branching (per the
 * milestone brief). One capability either has an approval record or it
 * doesn't; there is no revocation/un-approve endpoint in this milestone
 * either (not requested, and adding one would be exactly the kind of
 * complex review-workflow feature the brief says to defer).
 */
export interface ApprovalRecord {
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly status: 'approved';
  readonly approvedAt: string;
  /** The identity that performed the approval — always `req.identity.identityId` at the time of the `approve` call, never client-supplied (same as `identityId` above; kept as a separate, explicitly-named field so a future multi-approver extension has an obvious place to add more entries without renaming this one). */
  readonly approverIdentityId: string;
}

/**
 * Scoped to exactly one workspace by construction (same design as every
 * other P0.2-P0.4 store) — built from `workspaceApprovalsStore`
 * (`workspace/workspace-context.ts`).
 */
export interface ApprovalStore {
  approve(compilationId: string, capabilityId: string, workspaceId: string, identityId: string): Promise<Result<ApprovalRecord, XoError>>;
  /** `ok(undefined)` (not an error) when no approval exists yet — "not approved" is a normal state, not a failure to look one up. */
  get(compilationId: string, capabilityId: string): Promise<Result<ApprovalRecord | undefined, XoError>>;
}

export function isApproved(record: ApprovalRecord | undefined): record is ApprovalRecord {
  return record !== undefined && record.status === 'approved';
}
