import { isAuthenticatedPrincipal, toPrincipalSnapshot } from '@xo/permissions';
import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest } from '../../src/index.js';
import { mintBoundDevelopmentDecision, mintDevelopmentDecision } from '../../src/trusted-decision.js';

/**
 * TEST-ONLY authorization port. Unlike `DevelopmentOperatorAuthorization` it is not limited to path scopes and can allow by
 * permission and/or operation, so the same grants work for the real filesystem connector and for the mock connector. It mints
 * decisions through the same internal bound constructor the real adapters use, so `requireAuthorization` treats them identically.
 */
export class ScriptedAuthorization implements AuthorizationPort {
  readonly requests: AuthorizationRequest[] = [];

  constructor(private readonly allows: (request: AuthorizationRequest) => boolean) {}

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    this.requests.push(request);
    if (!isAuthenticatedPrincipal(request.principal)) return mintDevelopmentDecision('deny', 'an authenticated principal is required');
    if (!this.allows(request)) return { effect: 'prompt', reason: 'not granted by the scripted test policy' };
    return mintBoundDevelopmentDecision('allow', 'scripted test grant (development only)', {
      principal: toPrincipalSnapshot(request.principal),
      connectorId: request.connectorId,
      operation: request.operation,
      permission: request.permission,
      requestedScope: request.scope,
      grantedScope: request.scope,
    });
  }
}

/** Allow exactly these permissions, except for the named operations. */
export const allowing = (permissions: readonly string[], exceptOperations: readonly string[] = []): ScriptedAuthorization =>
  new ScriptedAuthorization((r) => permissions.includes(r.permission) && !exceptOperations.includes(r.operation));
