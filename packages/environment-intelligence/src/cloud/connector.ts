import { resourceScope } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import { auditDenial } from '../audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization, type TrustedAllow } from '../authorization-gate.js';
import type {
  AcquisitionOutcome,
  AcquisitionRequest,
  Connector,
  ConnectionValidation,
  ConnectorContext,
  ConnectorDescriptor,
  DetectedSource,
  DiscoveryOutcome,
  DiscoveryRequest,
  DiscoveryScopeBase,
  HealthReport,
  HealthRequest,
  SyncOutcome,
  SyncRequest,
} from '../connector.js';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';
import { ConnectorId, SourceId, stableDigest } from '../ids.js';
import type { ConnectionBinding, CredentialBroker } from './broker.js';
import type { CloudProvider } from './provider.js';

/**
 * The scope of every operation of the cloud connector. It names a connection and the boundary the caller believes it is in. It
 * carries NO identity, token, principal or account data, and nothing in it is trusted: the tenant is re-checked against what the
 * connection was verified for.
 */
export interface CloudAccountScope extends DiscoveryScopeBase {
  readonly kind: 'cloud_account';
  readonly providerId: string;
  readonly tenantId: string;
  readonly connectionId: string;
}

export function cloudScope(providerId: string, tenantId: string, connectionId: string): CloudAccountScope {
  return Object.freeze({ kind: 'cloud_account' as const, providerId, tenantId, connectionId });
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const NETWORK_CONNECT = 'network.connect';

const unsupported = (operation: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'this connector does not support this operation', { operation });

/**
 * C3: the C1 connector for an administrator-consented cloud account. Reuses the C1 contract UNCHANGED.
 *
 * Declared = implemented = authorized:
 *   detect               supported  existence of a verified connection; NO network, NO credential
 *   validate_connection  supported  one authenticated read ("who does this credential belong to") against the provider
 *   health               supported  the same probe, reported as a status; changes nothing
 *   discover / acquire_content / incremental_sync   UNSUPPORTED. The connection holds identity-only, read-only scopes; reading
 *     content would need a content scope and a separately authorized, audited operation (C4). Nothing here widens into it.
 *
 * Every supported operation first asks the platform gate (`network.connect`, resource scope `cloud/<provider>/<tenant>`) and only
 * a decision the enforcement point honoured lets the broker release a credential to the call. A connection existing, or an account
 * being known, authorizes nothing by itself.
 */
export class CloudAccountConnector implements Connector<CloudAccountScope> {
  readonly descriptor: ConnectorDescriptor = Object.freeze({
    id: ConnectorId('xo.cloud.account'),
    version: '1.0.0',
    displayName: 'Cloud account (read-only identity connection)',
    sourceTypes: Object.freeze(['saas_application' as const]),
    authMethods: Object.freeze(['oauth2' as const]),
    configFields: Object.freeze([
      Object.freeze({
        name: 'providerId',
        description: 'Which supported provider the connection belongs to.',
        required: true,
        secret: false,
      }),
      Object.freeze({
        name: 'connectionId',
        description: 'Id of an administrator-consented connection. Not a credential.',
        required: true,
        secret: false,
      }),
    ]),
    requiredPermissions: Object.freeze({
      detect: NETWORK_CONNECT,
      validate_connection: NETWORK_CONNECT,
      health: NETWORK_CONNECT,
    }),
    operations: Object.freeze({
      detect: 'supported' as const,
      validate_connection: 'supported' as const,
      discover: 'unsupported' as const,
      acquire_content: 'unsupported' as const,
      incremental_sync: 'unsupported' as const,
      health: 'supported' as const,
    }),
    evidenceKinds: Object.freeze([]),
    sideEffects: 'none' as const,
    documentation: Object.freeze({
      scope: 'One administrator-consented, tenant-pinned, read-only identity connection to a cloud provider account.',
      detects: Object.freeze(['that a verified connection exists and has not been revoked or expired']),
      cannotDetermine: Object.freeze([
        'any content, file, message or setting in the account',
        'what the account is permitted to do beyond the granted scopes',
      ]),
      limitations: Object.freeze([
        'No content discovery or acquisition (declared unsupported).',
        'Credentials are held in process memory only; a restart requires reconnection.',
        'Provider-side token revocation is not performed for public-client device-code connections.',
      ]),
    }),
  });

  constructor(
    private readonly broker: CredentialBroker,
    private readonly providers: ReadonlyMap<string, CloudProvider>,
  ) {}

  /** Validates the caller-supplied scope shape and authorizes it BEFORE any lookup, so a refusal does not reveal whether a connection exists. */
  private async authorize(
    request: { readonly sourceType: string; readonly scope: CloudAccountScope },
    operation: 'detect' | 'validate_connection' | 'health',
    ctx: ConnectorContext,
  ): Promise<Result<{ readonly allow: TrustedAllow; readonly binding: ConnectionBinding }, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const scope = request.scope as Partial<CloudAccountScope> | undefined;
    // ENFORCE:conn-scope-shape
    if (
      request.sourceType !== 'saas_application' ||
      scope === undefined ||
      scope.kind !== 'cloud_account' ||
      typeof scope.providerId !== 'string' ||
      typeof scope.tenantId !== 'string' ||
      typeof scope.connectionId !== 'string' ||
      !ID.test(scope.providerId) ||
      !ID.test(scope.tenantId) ||
      !ID.test(scope.connectionId)
    )
      return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'the cloud account scope is not valid', {}));
    const resource = resourceScope(`cloud/${scope.providerId}/${scope.tenantId}`);
    const gate = await requireAuthorization(ctx.authorization, {
      connectorId: this.descriptor.id,
      operation,
      permission: NETWORK_CONNECT,
      scope: resource,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: `${operation} on an administrator-consented cloud account connection`,
    });
    // ENFORCE:conn-authz-before-lookup
    if (!gate.ok) {
      await auditDenial(ctx, {
        operation,
        connectorId: this.descriptor.id,
        permission: NETWORK_CONNECT,
        scope: resource,
        error: gate.error,
      });
      return gate;
    }
    const binding = this.broker.describe(scope.connectionId);
    // ENFORCE:conn-unknown-connection
    if (binding === undefined || binding.status.providerId !== scope.providerId)
      return err(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'this connection is not authorized for use', {
          reason: 'unknown_connection',
        }),
      );
    // The boundary is what the connection was VERIFIED for, never what the request says.
    // ENFORCE:conn-tenant-boundary
    if (binding.status.tenantId !== scope.tenantId)
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the request names a different resource boundary than the connection', {
          reason: 'tenant_mismatch',
        }),
      );
    // ENFORCE:conn-state-active
    if (binding.status.state !== 'active')
      return err(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'this connection is not authorized for use', {
          reason: binding.status.state === 'revoked' ? 'credential_revoked' : 'credential_expired',
        }),
      );
    return ok({ allow: gate.value, binding });
  }

  async detectSource(request: DiscoveryRequest<CloudAccountScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>> {
    const a = await this.authorize(request, 'detect', ctx);
    if (!a.ok) return a;
    const s = a.value.binding.status;
    return ok({
      sourceId: SourceId(s.sourceId),
      sourceType: 'saas_application',
      displayName: 'Cloud account',
      locator: `cloud:${s.providerId}/${s.tenantId}`,
      detectedBy: this.descriptor.id,
      detectedAt: ctx.clock.now().toISOString(),
      fingerprint: stableDigest(['cloud-account-identity', s.sourceId]),
    });
  }

  async validateConnection(
    request: DiscoveryRequest<CloudAccountScope>,
    ctx: ConnectorContext,
  ): Promise<Result<ConnectionValidation, DiscoveryError>> {
    const a = await this.authorize(request, 'validate_connection', ctx);
    if (!a.ok) return a;
    const probed = await this.probe(a.value.allow, a.value.binding, ctx);
    if (!probed.ok) return probed;
    return ok({
      sourceId: SourceId(a.value.binding.status.sourceId),
      validatedAt: ctx.clock.now().toISOString(),
      details: { identityMatches: true, scopeCount: a.value.binding.status.grantedScopes.length, contentAccess: false },
    });
  }

  async health(request: HealthRequest<CloudAccountScope>, ctx: ConnectorContext): Promise<Result<HealthReport, DiscoveryError>> {
    const a = await this.authorize({ sourceType: 'saas_application', scope: request.scope }, 'health', ctx);
    if (!a.ok) return a;
    const probed = await this.probe(a.value.allow, a.value.binding, ctx);
    const base = { sourceId: SourceId(a.value.binding.status.sourceId), checkedAt: ctx.clock.now().toISOString() };
    if (probed.ok) return ok({ ...base, status: 'healthy', details: { identityMatches: true } });
    // An unreachable provider is a health fact, not an authorization fact; every credential/authorization failure stays an error.
    if (probed.error.code === DiscoveryErrorCode.CONNECTION_FAILED)
      return ok({ ...base, status: 'unavailable', details: { reason: String(probed.error.context['reason'] ?? 'unreachable') } });
    return probed;
  }

  /** One authenticated read through the broker; the identity the provider reports must be the one the connection was verified for. */
  private async probe(allow: TrustedAllow, binding: ConnectionBinding, ctx: ConnectorContext): Promise<Result<true, DiscoveryError>> {
    const provider = this.providers.get(binding.status.providerId);
    if (provider === undefined)
      return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_SOURCE, 'the provider for this connection is not available', {}));
    return this.broker.use<true>({
      connectionId: binding.status.connectionId,
      allow,
      ctx,
      fn: async (token, b) => {
        const r = await provider.probe(b.config, token, ctx.signal !== undefined ? { signal: ctx.signal } : {});
        if (!r.ok) {
          if (r.error.code === 'invalid_grant')
            return err(
              discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'this connection is not authorized for use', {
                reason: 'credential_rejected',
              }),
            );
          return err(
            discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'the provider could not be reached or answered unexpectedly', {
              stage: 'probe',
              reason: r.error.code,
            }),
          );
        }
        // identity continuity: the credential must still belong to the account that was verified at consent.
        return stableDigest([b.config.providerId, b.config.tenantId, r.value.accountId]) === this.accountRefOf(b)
          ? ok(true as const)
          : err(
              discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the credential no longer belongs to the verified account', {
                reason: 'account_mismatch',
              }),
            );
      },
    });
  }

  private accountRefOf(binding: ConnectionBinding): string {
    return binding.accountRef;
  }

  async discover(_request: DiscoveryRequest<CloudAccountScope>, _ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    return err(unsupported('discover'));
  }

  async acquireContent(
    _request: AcquisitionRequest & { readonly scope: CloudAccountScope },
    _ctx: ConnectorContext,
  ): Promise<Result<AcquisitionOutcome, DiscoveryError>> {
    return err(unsupported('acquire_content'));
  }

  // `incrementalSync` is deliberately ABSENT: the descriptor declares it unsupported and the registry rejects a method that is not declared.
  declare readonly incrementalSync?: (
    request: SyncRequest<CloudAccountScope>,
    ctx: ConnectorContext,
  ) => Promise<Result<SyncOutcome, DiscoveryError>>;
}
