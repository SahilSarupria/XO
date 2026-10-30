import type { Result } from '@xo/types';
import type { ConnectorContext } from '../connector.js';
import type { DiscoveryError } from '../errors.js';
import type { TrustedAllow } from '../authorization-gate.js';
import type { ProviderConfig } from './provider.js';
import type { Secret } from './secret.js';

/** What a connector (or status call) may learn about a connection. No credential, no account identifier, no personal data. */
export interface ConnectionStatus {
  readonly connectionId: string;
  readonly providerId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly state: 'active' | 'revoked' | 'expired';
  readonly grantedScopes: readonly string[];
  readonly connectedAt: string;
  readonly connectedBy: { readonly kind: 'human' | 'service'; readonly id: string; readonly orgId?: string };
  readonly credentialExpiresAt?: string;
  readonly reconnectCount: number;
  readonly endedAt?: string;
  readonly endedReason?: 'revoked_locally' | 'revoked_by_provider' | 'refresh_failed';
}

/** What a connector's protected operation is allowed to see of a connection (still no secret). */
export interface ConnectionBinding {
  readonly status: ConnectionStatus;
  readonly config: ProviderConfig;
  /** Digest of the verified account identity. Lets a probe confirm continuity without the account id ever leaving the manager. */
  readonly accountRef: string;
}

export interface CredentialUse<T> {
  readonly connectionId: string;
  /** The honoured decision this use is authorized by. Proof is checked against the framework's registry, not the object's fields. */
  readonly allow: TrustedAllow;
  readonly ctx: ConnectorContext;
  /** Receives the live access token. The token must not be stored, returned, logged or put in an error by `fn`. */
  readonly fn: (accessToken: Secret, binding: ConnectionBinding) => Promise<Result<T, DiscoveryError>>;
}

/**
 * The only way a connector reaches a credential. Narrow by design:
 *  - no `get`: a token is only ever handed to a callback, for one call;
 *  - the caller must present a decision the enforcement point HONOURED for this principal and a scope containing this
 *    connection's resource, so discovering or registering a connection grants nothing;
 *  - an ended (revoked / expired) connection yields nothing, and a result computed with a credential that was revoked while the call
 *    was in flight is discarded.
 */
export interface CredentialBroker {
  describe(connectionId: string): ConnectionBinding | undefined;
  use<T>(request: CredentialUse<T>): Promise<Result<T, DiscoveryError>>;
}
