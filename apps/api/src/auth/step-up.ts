import { AuthError, ErrorCode } from '@xo/errors';
import type { ApiRequest } from '../http/types.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';

/**
 * UW-1 — step-up re-authentication. Approving an effect (a capability, a human task, a procedure, a workflow sign-off, a payload) and
 * changing who may do things in a workspace need a RECENT sign-in, not merely a live session: a session left open on a shared machine,
 * or a stolen refresh credential, must not be enough to approve. "Recent" is `XO_API_STEP_UP_MAX_AGE_MINUTES` (default 15; 0 turns
 * step-up off) since the person last proved who they are (the session's sign-in time, or the OIDC token's `auth_time`).
 *
 * API keys are not interactive: there is no sign-in to repeat, so step-up does not apply to them. Whether a service principal may
 * approve effectful work at all is a separate rule (plan B.9 / UW-7), not this one.
 */
export const DEFAULT_STEP_UP_MAX_AGE_MINUTES = 15;

/** Parses `XO_API_STEP_UP_MAX_AGE_MINUTES`: unset = 15; 0 = off; 1 to 1440 minutes. Anything else throws (startup must fail visibly). */
export function parseStepUpMaxAgeMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STEP_UP_MAX_AGE_MINUTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1440)
    throw new Error(`XO_API_STEP_UP_MAX_AGE_MINUTES must be 0 (off) or 1 to 1440 (got "${raw}")`);
  return n;
}

/**
 * Throws `XO_AUTH_STEP_UP_REQUIRED` (401) unless the caller's interactive sign-in is recent enough. The refusal is recorded in the
 * workspace audit log as `access.denied` with `deniedBy: 'step_up'`.
 */
export async function requireRecentAuthentication(
  req: ApiRequest,
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  action: string,
): Promise<void> {
  const auth = req.authentication;
  if (auth === undefined || auth.credential === 'api-key') return;
  const maxAgeMinutes = req.stepUpMaxAgeMinutes ?? DEFAULT_STEP_UP_MAX_AGE_MINUTES;
  if (maxAgeMinutes === 0) return;
  const at = auth.authenticatedAt !== undefined ? Date.parse(auth.authenticatedAt) : Number.NaN;
  const now = Date.now();
  if (Number.isFinite(at) && now - at <= maxAgeMinutes * 60_000 && at <= now + 60_000) return;
  const { recordAudit } = await import('../audit/record.js');
  await recordAudit(req, workspace, dataConfig, {
    event: 'access.denied',
    result: 'denied',
    detail: { deniedBy: 'step_up', attempted: action, maxAgeMinutes },
  });
  throw new AuthError(
    ErrorCode.AUTH_STEP_UP_REQUIRED,
    Number.isFinite(at)
      ? `sign in again to ${action}: this needs a sign-in from the last ${maxAgeMinutes} minutes`
      : `sign in again to ${action}: your sign-in time is not known, and this needs a sign-in from the last ${maxAgeMinutes} minutes`,
  );
}
