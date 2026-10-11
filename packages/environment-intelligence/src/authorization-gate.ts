import { err, ok, type Result } from '@xo/types';
import type { AuthorityKind, AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from './authorization.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import { authorityOf } from './trusted-decision.js';

export interface TrustedAllow {
  readonly decision: AuthorizationDecision;
  /** Derived from how the decision was minted. Never `none`, never copied from a port-supplied field. */
  readonly authority: Exclude<AuthorityKind, 'none'>;
}

/**
 * The single enforcement point for every authorization decision in this
 * package. An `allow` is honoured only when the exact decision object carries
 * a trusted authority; every other outcome (deny, prompt, a forged or cloned
 * `allow`, a throwing port) is an error. Public error text and context are
 * fixed strings plus the permission and DERIVED authority, so a denial does
 * not depend on, or reveal, what the requested path is.
 */
export async function requireAuthorization(
  port: AuthorizationPort,
  request: AuthorizationRequest,
): Promise<Result<TrustedAllow, DiscoveryError>> {
  let decision: AuthorizationDecision;
  try {
    decision = await port.decide(request);
  } catch (e) {
    return err(internalError(e, 'authorization gate'));
  }
  const authority = authorityOf(decision);
  if (decision !== null && typeof decision === 'object' && decision.effect === 'allow' && authority !== 'none') {
    return ok({ decision, authority });
  }
  if (decision !== null && typeof decision === 'object' && decision.effect === 'deny') {
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_DENIED, 'authorization was denied', { permission: request.permission, authority }),
    );
  }
  return err(
    discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'authorization is required before this source can be read', {
      permission: request.permission,
      authority,
    }),
  );
}
