import { randomBytes, randomUUID } from 'node:crypto';
import {
  isAuthenticatedPrincipal,
  principalsEqual,
  resourceScope,
  scopeContains,
  toPrincipalSnapshot,
  type PermissionScope,
  type Principal,
} from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import { scopeRef, safeIdentifier, type AuditOperation, type AuditRecordRequest } from '../audit.js';
import { acceptAuditEvent, auditDenial } from '../audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization, type TrustedAllow } from '../authorization-gate.js';
import { runEnforced, identityMismatch } from '../connector-enforcement.js';
import type { ConnectorContext } from '../connector.js';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';
import { ConnectorId, SourceId, stableDigest, stableId } from '../ids.js';
import type { EnvironmentInventory } from '../inventory.js';
import type { ConnectorRegistry } from '../registry.js';
import { requireOperationalState, trustFromContext } from '../state-journal.js';
import { wasHonoured } from '../trusted-decision.js';
import type { ConnectionBinding, ConnectionStatus, CredentialBroker, CredentialUse } from './broker.js';
import { CloudAccountConnector, cloudScope } from './connector.js';
import {
  checkGrantedScopes,
  type CloudProvider,
  type ProviderConfig,
  type ProviderFailure,
  type ProviderInfo,
  type TokenGrant,
} from './provider.js';
import type { Secret } from './secret.js';

/**
 * C3 connection lifecycle: list providers -> explicit administrator authorization -> device-code consent -> validate identity,
 * granted scopes and resource boundary -> register through the C1 contract -> status / revoke / safe reconnect.
 *
 * AUTHORITY BOUNDARIES (kept separate on purpose; none implies another):
 *   discovery   `detect`               existence-level, no network, no credential.
 *   connection  begin/complete/revoke  administrator-consented (`network.connect`, `secrets.write`), audited, never inferred.
 *   use         `validate`/`health`    a credential is released to a callback only against a decision the enforcement point HONOURED.
 *   content/action                     NOT IMPLEMENTED in C3 (declared `unsupported`); a connection grants no read of content.
 *
 * Credentials live only in this object's memory (a `Secret` per token). Nothing is persisted: a restart loses every connection and
 * every operation then fails closed until an administrator reconnects. The durable `EiStateStore` schema is closed (C0.4) and carries
 * no connection records; extending it is deferred, not faked.
 */
export const CLOUD_CONNECTOR_ID = ConnectorId('xo.cloud.account');
export const NETWORK_CONNECT = 'network.connect';
export const SECRETS_WRITE = 'secrets.write';
export const MAX_PENDING_CONNECTIONS = 16;
const REFRESH_SKEW_MS = 60_000;
const MAX_POLL_ITERATIONS = 2_000;
const MAX_TRANSIENT_POLL_FAILURES = 3;
const SLOW_DOWN_MS = 5_000;
const CONNECTOR_VERSION = '1.0.0';

export const cloudResource = (providerId: string, tenantId: string): string => `cloud/${providerId}/${tenantId}`;

export interface PendingConnection {
  readonly pendingId: string;
  readonly providerId: string;
  readonly tenantId: string;
  /** Shown to the human, who enters it on `verificationUri`. Not a secret. */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalSec: number;
  readonly reconnectOf?: string;
}

export type ConnectionOutcome = 'connected' | 'reconnected' | 'already_connected';
export interface ConnectionResult {
  readonly connection: ConnectionStatus;
  readonly outcome: ConnectionOutcome;
}
export interface RevocationResult {
  readonly connection: ConnectionStatus;
  readonly credentialsDestroyed: true;
  /** Honest: this provider has no revocation endpoint for a public client, so consent must also be withdrawn at the provider. */
  readonly providerRevocation: 'performed' | 'not_performed';
  /** Whether the terminal audit record was accepted. Revocation only ever REDUCES authority, so it proceeds either way. */
  readonly audited: boolean;
}

export interface CloudManagerOptions {
  readonly providers: readonly CloudProvider[];
  readonly registry: ConnectorRegistry;
  readonly inventory: EnvironmentInventory;
  /** Injected so tests never wait in real time. Must resolve early when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly maxPending?: number;
}

interface Credential {
  readonly access: Secret;
  readonly refresh?: Secret;
  readonly accessExpiresAtMs: number;
}

interface Entry {
  status: ConnectionStatus;
  readonly config: ProviderConfig;
  readonly accountRef: string;
  credential: Credential | undefined;
  /** Bumped on every revoke / replace / rollback so a call that started under a different credential is discarded. */
  epoch: number;
}

interface OperationAudit {
  readonly operationId: string;
  readonly permission: string;
  readonly scope: PermissionScope;
  readonly allow: TrustedAllow;
}

interface Pending {
  readonly principal: Principal;
  readonly provider: CloudProvider;
  readonly config: ProviderConfig;
  readonly deviceCode: Secret;
  readonly expiresAtMs: number;
  readonly initialIntervalSec: number;
  readonly audit: OperationAudit;
  readonly reconnectOf?: string;
  completing: boolean;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

const refused = (reason: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the request is not acceptable', { reason });
const connectionFailed = (stage: string, reason: string, retryable = false): DiscoveryError => {
  const e = discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'the cloud connection could not be established', { stage, reason });
  return retryable ? e : Object.freeze({ ...e, retryable: false });
};
const ended = (reason: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'this connection is not authorized for use', { reason });

function sanitizeFailure(stage: string, f: ProviderFailure): DiscoveryError {
  return connectionFailed(stage, f.code, f.code === 'unreachable' || f.code === 'timeout');
}

function httpsHostAllowed(uri: string, hosts: readonly string[]): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.port === '' && hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class CloudConnectionManager implements CredentialBroker {
  private readonly providers: ReadonlyMap<string, CloudProvider>;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<Result<void, DiscoveryError>>>();
  private readonly usedAllows = new WeakSet<object>();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxPending: number;
  private commitChain: Promise<unknown> = Promise.resolve();
  readonly connector: CloudAccountConnector;

  constructor(private readonly options: CloudManagerOptions) {
    this.providers = new Map(options.providers.map((p) => [p.info.id, p]));
    this.sleep = options.sleep ?? defaultSleep;
    this.maxPending = options.maxPending ?? MAX_PENDING_CONNECTIONS;
    this.connector = new CloudAccountConnector(this, this.providers);
    // The registrar (this trusted host code) vouches that a credential mechanism backs `oauth2`; the connector cannot claim it itself.
    options.registry.register(this.connector, { enabledAuthMethods: ['oauth2'] });
  }

  /** Static catalog: what can be connected, with what configuration and scopes. Reveals nothing about any connection. */
  listProviders(): readonly ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // ── begin ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async beginConnect(
    ctx: ConnectorContext,
    input: { readonly providerId: string; readonly config: unknown },
  ): Promise<Result<PendingConnection, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const provider = typeof input?.providerId === 'string' ? this.providers.get(input.providerId) : undefined;
    if (provider === undefined) return err(refused('unsupported_provider'));
    const config = provider.parseConfig(input.config);
    if (!config.ok) return err(refused('invalid_provider_config'));
    return this.begin(ctx, who.value, provider, config.value, undefined);
  }

  /** Re-consent for an existing connection (any state). The account identity must come back identical or nothing changes. */
  async beginReconnect(ctx: ConnectorContext, connectionId: string): Promise<Result<PendingConnection, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const entry = typeof connectionId === 'string' ? this.entries.get(connectionId) : undefined;
    const provider = entry === undefined ? undefined : this.providers.get(entry.config.providerId);
    if (entry === undefined || provider === undefined) return err(refused('unknown_connection'));
    return this.begin(ctx, who.value, provider, entry.config, connectionId);
  }

  private async begin(
    ctx: ConnectorContext,
    principal: Principal,
    provider: CloudProvider,
    config: ProviderConfig,
    reconnectOf: string | undefined,
  ): Promise<Result<PendingConnection, DiscoveryError>> {
    const guard = requireOperationalState(ctx);
    if (!guard.ok) return guard;
    this.purgeExpired(ctx.clock.now().getTime());
    // ENFORCE:begin-pending-bound
    if (this.pending.size >= this.maxPending)
      return err(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many connections are awaiting consent', { limit: this.maxPending }),
      );

    const scope = resourceScope(cloudResource(config.providerId, config.tenantId));
    const gate = await requireAuthorization(ctx.authorization, {
      connectorId: CLOUD_CONNECTOR_ID,
      operation: 'connect_account',
      permission: NETWORK_CONNECT,
      scope,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: 'start an administrator-consented cloud account connection',
    });
    // ENFORCE:begin-authz
    if (!gate.ok) {
      await auditDenial(ctx, {
        operation: 'connect_account',
        connectorId: CLOUD_CONNECTOR_ID,
        permission: NETWORK_CONNECT,
        scope,
        error: gate.error,
      });
      return gate;
    }
    const audit: OperationAudit = { operationId: this.newOperationId(ctx), permission: NETWORK_CONNECT, scope, allow: gate.value };
    // Write-ahead: nothing leaves the process (no provider call) until the attempt record was ACCEPTED.
    const attempted = await this.record(ctx, audit, 'attempt', 'attempted', 'connect_account');
    // ENFORCE:begin-attempt-audit
    if (!attempted) return err(auditUnavailable('attempt'));

    const started = await provider.startDeviceFlow(config, signalOf(ctx));
    if (!started.ok) {
      await this.record(ctx, audit, 'terminal', 'failed', 'connect_account', { errorCode: DiscoveryErrorCode.CONNECTION_FAILED });
      return err(sanitizeFailure('start', started.error));
    }
    const d = started.value;
    // ENFORCE:verification-uri
    if (!httpsHostAllowed(d.verificationUri, provider.info.verificationHosts) || d.expiresInSec < 60 || d.intervalSec < 1) {
      await this.record(ctx, audit, 'terminal', 'failed', 'connect_account', { errorCode: DiscoveryErrorCode.CONNECTION_FAILED });
      return err(connectionFailed('start', 'malformed'));
    }
    const pendingId = `pend_${randomBytes(16).toString('hex')}`;
    const expiresAtMs = ctx.clock.now().getTime() + d.expiresInSec * 1000;
    this.pending.set(pendingId, {
      principal,
      provider,
      config,
      deviceCode: d.deviceCode,
      expiresAtMs,
      initialIntervalSec: d.intervalSec,
      audit,
      ...(reconnectOf !== undefined ? { reconnectOf } : {}),
      completing: false,
    });
    return ok({
      pendingId,
      providerId: config.providerId,
      tenantId: config.tenantId,
      userCode: d.userCode,
      verificationUri: d.verificationUri,
      expiresAt: new Date(expiresAtMs).toISOString(),
      intervalSec: d.intervalSec,
      ...(reconnectOf !== undefined ? { reconnectOf } : {}),
    });
  }

  // ── complete ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Waits (bounded, cancellable) for the human to finish consent, then verifies and commits. A timeout, cancellation, refusal,
   * provider fault or any verification failure leaves NO connection, NO credential, NO inventory change, and ends the operation with
   * a terminal audit record. Only the principal that began the consent may complete it.
   */
  async completeConnect(
    ctx: ConnectorContext,
    pendingId: string,
    options: { readonly maxWaitMs?: number } = {},
  ): Promise<Result<ConnectionResult, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const guard = requireOperationalState(ctx);
    if (!guard.ok) return guard;
    const pending = typeof pendingId === 'string' ? this.pending.get(pendingId) : undefined;
    if (pending === undefined) return err(refused('unknown_or_expired_consent'));
    // ENFORCE:complete-principal-match
    if (!principalsEqual(pending.principal, who.value))
      return err(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_DENIED, 'only the principal that started this consent can complete it', {
          reason: 'principal_mismatch',
        }),
      );
    // ENFORCE:complete-not-reentrant
    if (pending.completing) return err(refused('consent_already_completing'));
    pending.completing = true;
    try {
      return await this.completeInner(ctx, pendingId, pending, options.maxWaitMs);
    } finally {
      pending.completing = false;
    }
  }

  private async completeInner(
    ctx: ConnectorContext,
    pendingId: string,
    pending: Pending,
    maxWaitMs: number | undefined,
  ): Promise<Result<ConnectionResult, DiscoveryError>> {
    const { provider, config, audit } = pending;
    const end = async (outcome: 'failed' | 'cancelled', error: DiscoveryError): Promise<Result<never, DiscoveryError>> => {
      this.pending.delete(pendingId);
      await this.record(ctx, audit, 'terminal', outcome, 'connect_account', { errorCode: error.code });
      return err(error);
    };

    const polled = await this.pollUntilGranted(ctx, pending, maxWaitMs);
    if (!polled.ok) return end(polled.error.code === DiscoveryErrorCode.CANCELLED ? 'cancelled' : 'failed', polled.error);
    const grant = polled.value;
    // The device code is spent either way; nothing below can reuse it.
    this.pending.delete(pendingId);

    const scopes = checkGrantedScopes(provider.info, grant.scopes);
    // ENFORCE:scopes-least-privilege
    if (!scopes.ok)
      return end(
        'failed',
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the granted scopes are not acceptable', { reason: scopes.error }),
      );
    const identity = await provider.verifyIdentity(config, grant, ctx.clock.now().getTime(), signalOf(ctx));
    if (!identity.ok) return end('failed', sanitizeFailure('identity', identity.error));
    // ENFORCE:tenant-pin
    if (identity.value.tenantId !== config.tenantId) return end('failed', connectionFailed('identity', 'tenant_mismatch'));

    const accountRef = stableDigest([config.providerId, config.tenantId, identity.value.accountId]);
    const connectionId = stableId('conn', [config.providerId, config.tenantId, accountRef]);
    const sourceId = SourceId(stableId('src', ['cloud', config.providerId, config.tenantId, accountRef]));
    // ENFORCE:reconnect-same-account
    if (pending.reconnectOf !== undefined && pending.reconnectOf !== connectionId)
      return end('failed', connectionFailed('identity', 'account_changed'));

    // Serialize the commit section (per manager): decisions, credential install, C1 registration and audit close as one unit.
    return this.serialize<Result<ConnectionResult, DiscoveryError>>(async () => {
      const existing = this.entries.get(connectionId);
      // ENFORCE:duplicate-idempotent
      if (existing !== undefined && existing.status.state === 'active' && pending.reconnectOf === undefined) {
        // Repeated connect for the same account: idempotent. The freshly issued tokens are dropped (never stored), nothing is duplicated.
        await this.record(ctx, audit, 'terminal', 'completed', 'connect_account', { sourceId });
        return ok({ connection: publicStatus(existing), outcome: 'already_connected' as const });
      }
      const scope = audit.scope;
      const store = await requireAuthorization(ctx.authorization, {
        connectorId: CLOUD_CONNECTOR_ID,
        operation: 'connect_account',
        permission: SECRETS_WRITE,
        scope,
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
        reason: 'hold the granted credential for this administrator-consented connection',
      });
      // ENFORCE:store-authz
      if (!store.ok) {
        await auditDenial(ctx, {
          operation: 'connect_account',
          connectorId: CLOUD_CONNECTOR_ID,
          permission: SECRETS_WRITE,
          scope,
          error: store.error,
        });
        return end('failed', store.error);
      }

      const previous = existing === undefined ? undefined : cloneEntry(existing);
      const nowIso = ctx.clock.now().toISOString();
      const reconnectCount = existing === undefined ? 0 : existing.status.reconnectCount + 1;
      const entry: Entry = {
        status: Object.freeze({
          connectionId,
          providerId: config.providerId,
          tenantId: config.tenantId,
          sourceId: sourceId as string,
          state: 'active' as const,
          grantedScopes: Object.freeze([...scopes.value]),
          connectedAt: nowIso,
          connectedBy: snapshotOf(who(ctx)),
          credentialExpiresAt: new Date(ctx.clock.now().getTime() + grant.expiresInSec * 1000).toISOString(),
          reconnectCount,
        }),
        config,
        accountRef,
        credential: credentialOf(grant, ctx.clock.now().getTime(), undefined),
        epoch: (existing?.epoch ?? 0) + 1,
      };
      this.entries.set(connectionId, entry);
      const rollback = (): void => {
        entry.epoch += 1;
        entry.credential = undefined;
        if (previous === undefined) this.entries.delete(connectionId);
        else this.entries.set(connectionId, { ...previous, epoch: entry.epoch + 1 });
      };

      const registered = await this.registerSource(ctx, entry);
      // ENFORCE:register-rollback
      if (!registered.ok) {
        rollback();
        return end('failed', registered.error);
      }
      const closed = await this.record(ctx, audit, 'terminal', 'completed', 'connect_account', { sourceId });
      // ENFORCE:completion-audit
      if (!closed) {
        // No false success: an unrecorded connection is not a connection.
        rollback();
        this.revokeInInventory(entry.status.sourceId, ctx);
        return err(auditUnavailable('completion'));
      }
      return ok({ connection: publicStatus(entry), outcome: previous === undefined ? ('connected' as const) : ('reconnected' as const) });
    });
  }

  private async pollUntilGranted(
    ctx: ConnectorContext,
    pending: Pending,
    maxWaitMs: number | undefined,
  ): Promise<Result<TokenGrant, DiscoveryError>> {
    let intervalMs = pending.initialIntervalSec * 1000;
    let transient = 0;
    const startedMs = ctx.clock.now().getTime();
    const softDeadline = maxWaitMs === undefined ? Number.POSITIVE_INFINITY : startedMs + Math.max(0, maxWaitMs);
    for (let i = 0; i < MAX_POLL_ITERATIONS; i += 1) {
      if (ctx.signal?.aborted === true) return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'the connection was cancelled', {}));
      const nowMs = ctx.clock.now().getTime();
      // ENFORCE:poll-expiry
      if (nowMs >= pending.expiresAtMs) return err(connectionFailed('consent', 'expired'));
      const r = await pending.provider.pollDeviceFlow(pending.config, pending.deviceCode, signalOf(ctx));
      if (r.ok) {
        if (r.value.status === 'granted') return ok(r.value.grant);
        if (r.value.status === 'slow_down') intervalMs += SLOW_DOWN_MS;
        transient = 0;
      } else if (r.error.code === 'cancelled') {
        return err(discoveryError(DiscoveryErrorCode.CANCELLED, 'the connection was cancelled', {}));
      } else if (r.error.code === 'unreachable' || r.error.code === 'timeout') {
        transient += 1;
        if (transient >= MAX_TRANSIENT_POLL_FAILURES) return err(sanitizeFailure('consent', r.error));
      } else {
        return err(sanitizeFailure('consent', r.error));
      }
      // ENFORCE:poll-soft-timeout
      if (nowMs + intervalMs > softDeadline) return err(connectionFailed('consent', 'timeout', true));
      await this.sleep(intervalMs, ctx.signal);
    }
    return err(connectionFailed('consent', 'timeout', true));
  }

  /** Runs the C1 contract for a staged connection; inventory changes only AFTER detect and validate both passed. */
  private async registerSource(ctx: ConnectorContext, entry: Entry): Promise<Result<void, DiscoveryError>> {
    const connector = this.connector;
    const request = {
      sourceType: 'saas_application' as const,
      scope: cloudScope(entry.status.providerId, entry.status.tenantId, entry.status.connectionId),
    };
    const detected = await runEnforced(connector, 'detect', ctx, (c) => connector.detectSource(request, c), { audited: false });
    if (!detected.ok) return detected;
    const source = detected.value;
    if (
      source.detectedBy !== connector.descriptor.id ||
      source.sourceType !== 'saas_application' ||
      source.sourceId !== entry.status.sourceId
    )
      return err(identityMismatch('detected_source'));
    const validation = await runEnforced(connector, 'validate_connection', ctx, (c) => connector.validateConnection(request, c), {
      audited: false,
    });
    if (!validation.ok) return validation;
    if (validation.value.sourceId !== source.sourceId) return err(identityMismatch('validated_source'));

    const at = ctx.clock.now().toISOString();
    const inventory = this.options.inventory;
    inventory.observe(source, at);
    for (const event of ['connector_matched', 'connection_configured', 'authorization_granted', 'connection_validated'] as const) {
      const applied =
        event === 'connector_matched'
          ? inventory.apply(source.sourceId, event, at, { connectorId: connector.descriptor.id })
          : inventory.apply(source.sourceId, event, at);
      if (!applied.ok) {
        this.revokeInInventory(source.sourceId as string, ctx);
        return err(applied.error);
      }
    }
    if (ctx.state !== undefined) {
      const trust = trustFromContext(ctx);
      const synced = trust === undefined ? undefined : await ctx.state.syncInventory(trust);
      if (synced === undefined || !synced.ok) {
        this.revokeInInventory(source.sourceId as string, ctx);
        return err(
          synced !== undefined && !synced.ok
            ? synced.error
            : discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'the lifecycle state could not be persisted', {}),
        );
      }
    }
    return ok(undefined);
  }

  // ── status / revoke ────────────────────────────────────────────────────────────────────────────────────────────────────

  status(ctx: ConnectorContext, connectionId: string): Result<ConnectionStatus, DiscoveryError> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const entry = typeof connectionId === 'string' ? this.entries.get(connectionId) : undefined;
    return entry === undefined ? err(refused('unknown_connection')) : ok(publicStatus(entry));
  }

  list(ctx: ConnectorContext): Result<readonly ConnectionStatus[], DiscoveryError> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    return ok([...this.entries.values()].map(publicStatus).sort((a, b) => (a.connectionId < b.connectionId ? -1 : 1)));
  }

  /**
   * Destroys the credentials and blocks every later protected operation on this connection. Authorized (`secrets.write`) and audited,
   * but an audit outage does not stop a revocation: it only ever reduces authority, so it is reported (`audited: false`), not refused.
   */
  async revoke(ctx: ConnectorContext, connectionId: string): Promise<Result<RevocationResult, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const guard = requireOperationalState(ctx);
    if (!guard.ok) return guard;
    const entry = typeof connectionId === 'string' ? this.entries.get(connectionId) : undefined;
    if (entry === undefined) return err(refused('unknown_connection'));
    const scope = resourceScope(cloudResource(entry.status.providerId, entry.status.tenantId));
    const gate = await requireAuthorization(ctx.authorization, {
      connectorId: CLOUD_CONNECTOR_ID,
      operation: 'revoke_connection',
      permission: SECRETS_WRITE,
      scope,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: 'revoke a cloud account connection and destroy its credentials',
    });
    if (!gate.ok) {
      await auditDenial(ctx, {
        operation: 'revoke_connection',
        connectorId: CLOUD_CONNECTOR_ID,
        permission: SECRETS_WRITE,
        scope,
        error: gate.error,
      });
      return gate;
    }
    return this.serialize<Result<RevocationResult, DiscoveryError>>(async () => {
      const audit: OperationAudit = { operationId: this.newOperationId(ctx), permission: SECRETS_WRITE, scope, allow: gate.value };
      const attempted = await this.record(ctx, audit, 'attempt', 'attempted', 'revoke_connection', { sourceId: entry.status.sourceId });
      this.endEntry(entry, 'revoked', 'revoked_locally', ctx);
      this.revokeInInventory(entry.status.sourceId, ctx);
      if (ctx.state !== undefined) {
        const trust = trustFromContext(ctx);
        if (trust !== undefined) await ctx.state.syncInventory(trust);
      }
      const closed = attempted
        ? await this.record(ctx, audit, 'terminal', 'revoked', 'revoke_connection', { sourceId: entry.status.sourceId })
        : false;
      return ok({
        connection: publicStatus(entry),
        credentialsDestroyed: true as const,
        providerRevocation: 'not_performed' as const,
        audited: attempted && closed,
      });
    });
  }

  /**
   * Restart reconciliation. Credentials are memory-only, so after a restart the (durable) inventory can still say "connected and
   * validated" for a source with no credential behind it. This makes the VIEW truthful: for the named boundary, every inventory
   * source this connector detected that has no active connection is moved to `authorization: revoked` (and persisted).
   *
   * It only ever reduces authority, but is still authorized (`secrets.write` on that boundary) and audited like a revocation.
   * The durable journal does not retain a source's locator, so after a restart a source cannot be attributed to a tenant by
   * itself; the administrator therefore NAMES the boundary, and a source whose locator IS known must match it. That attribution
   * limit is reported (`unattributed`) rather than hidden.
   */
  async reconcileInventory(
    ctx: ConnectorContext,
    boundary: { readonly providerId: string; readonly tenantId: string },
  ): Promise<Result<{ readonly reconciled: number; readonly skipped: number; readonly unattributed: number }, DiscoveryError>> {
    const who = requireAuthenticatedPrincipal(ctx.principal);
    if (!who.ok) return who;
    const guard = requireOperationalState(ctx);
    if (!guard.ok) return guard;
    const provider = typeof boundary?.providerId === 'string' ? this.providers.get(boundary.providerId) : undefined;
    const parsed =
      provider === undefined
        ? undefined
        : provider.parseConfig({ tenantId: boundary.tenantId, clientId: '00000000-0000-4000-8000-000000000000' });
    if (provider === undefined || parsed === undefined || !parsed.ok) return err(refused('invalid_boundary'));
    const locator = `cloud:${parsed.value.providerId}/${parsed.value.tenantId}`;
    const scope = resourceScope(cloudResource(parsed.value.providerId, parsed.value.tenantId));
    let reconciled = 0;
    let skipped = 0;
    let unattributed = 0;
    for (const record of this.options.inventory.list()) {
      const source = record.source;
      if (source.detectedBy !== CLOUD_CONNECTOR_ID || record.axes.authorization === 'revoked') continue;
      // ENFORCE:reconcile-live-skip
      if ([...this.entries.values()].some((e) => e.status.sourceId === source.sourceId && e.status.state === 'active')) continue;
      // ENFORCE:reconcile-other-boundary
      if (source.locator !== '' && source.locator !== locator) continue; // another boundary's source
      const gate = await requireAuthorization(ctx.authorization, {
        connectorId: CLOUD_CONNECTOR_ID,
        operation: 'revoke_connection',
        permission: SECRETS_WRITE,
        scope,
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
        reason: 'mark a cloud source revoked because no credential survived a restart',
      });
      // ENFORCE:reconcile-authz
      if (!gate.ok) {
        await auditDenial(ctx, {
          operation: 'revoke_connection',
          connectorId: CLOUD_CONNECTOR_ID,
          permission: SECRETS_WRITE,
          scope,
          error: gate.error,
        });
        skipped += 1;
        continue;
      }
      if (source.locator === '') unattributed += 1;
      const audit: OperationAudit = { operationId: this.newOperationId(ctx), permission: SECRETS_WRITE, scope, allow: gate.value };
      const attempted = await this.record(ctx, audit, 'attempt', 'attempted', 'revoke_connection', { sourceId: source.sourceId });
      this.revokeInInventory(source.sourceId, ctx);
      if (ctx.state !== undefined) {
        const trust = trustFromContext(ctx);
        if (trust !== undefined) await ctx.state.syncInventory(trust);
      }
      if (attempted) await this.record(ctx, audit, 'terminal', 'revoked', 'revoke_connection', { sourceId: source.sourceId });
      reconciled += 1;
    }
    return ok({ reconciled, skipped, unattributed });
  }

  // ── credential broker ──────────────────────────────────────────────────────────────────────────────────────────────────

  describe(connectionId: string): ConnectionBinding | undefined {
    const entry = this.entries.get(connectionId);
    return entry === undefined ? undefined : { status: publicStatus(entry), config: entry.config, accountRef: entry.accountRef };
  }

  async use<T>(request: CredentialUse<T>): Promise<Result<T, DiscoveryError>> {
    const { ctx, allow } = request;
    const entry = this.entries.get(request.connectionId);
    if (entry === undefined) return err(ended('unknown_connection'));
    // Proof, not a claim: the exact decision object must have been honoured by the enforcement point, for THIS principal, once.
    // ENFORCE:broker-honoured-proof
    if (
      typeof allow !== 'object' ||
      allow === null ||
      !wasHonoured(allow.decision) ||
      !isAuthenticatedPrincipal(ctx.principal) ||
      !principalsEqual(allow.principal, toPrincipalSnapshot(ctx.principal)) ||
      this.usedAllows.has(allow.decision)
    )
      return err(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED, 'no honoured authorization decision backs this credential use', {
          reason: 'no_honoured_decision',
        }),
      );
    this.usedAllows.add(allow.decision);
    const scope = resourceScope(cloudResource(entry.status.providerId, entry.status.tenantId));
    // ENFORCE:broker-scope-covers
    if (allow.grant.grantedScope === undefined || !scopeContains(allow.grant.grantedScope, scope))
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the granted scope does not cover this connection', {
          reason: 'scope_does_not_cover_connection',
        }),
      );
    // ENFORCE:broker-active-only
    if (entry.status.state !== 'active') return err(ended(entry.status.state === 'revoked' ? 'credential_revoked' : 'credential_expired'));

    const epoch = entry.epoch;
    const fresh = await this.freshCredential(entry, ctx);
    if (!fresh.ok) return fresh;
    const result = await request.fn(fresh.value, { status: publicStatus(entry), config: entry.config, accountRef: entry.accountRef });
    // A credential revoked or replaced while the call was in flight invalidates the result.
    // ENFORCE:broker-inflight-epoch
    if (entry.epoch !== epoch || entry.status.state !== 'active') return err(ended('revoked_during_call'));
    return result;
  }

  private async freshCredential(entry: Entry, ctx: ConnectorContext): Promise<Result<Secret, DiscoveryError>> {
    const nowMs = ctx.clock.now().getTime();
    const cred = entry.credential;
    if (cred === undefined) return err(ended('credential_unavailable'));
    // ENFORCE:refresh-fresh-window
    if (nowMs < cred.accessExpiresAtMs - REFRESH_SKEW_MS) return ok(cred.access);
    const id = entry.status.connectionId;
    // Single-flight: a rotating refresh token must never be redeemed twice concurrently.
    let flight = this.refreshing.get(id);
    if (flight === undefined) {
      flight = this.refreshOnce(entry, ctx).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, flight);
    }
    const refreshed = await flight;
    if (!refreshed.ok) return refreshed;
    const next = entry.credential;
    if (next === undefined || entry.status.state !== 'active') return err(ended('credential_unavailable'));
    return ok(next.access);
  }

  private async refreshOnce(entry: Entry, ctx: ConnectorContext): Promise<Result<void, DiscoveryError>> {
    const provider = this.providers.get(entry.config.providerId);
    const cred = entry.credential;
    const epoch = entry.epoch;
    if (provider === undefined || cred === undefined) return err(ended('credential_unavailable'));
    // ENFORCE:refresh-no-token
    if (cred.refresh === undefined) {
      this.endEntry(entry, 'expired', 'refresh_failed', ctx);
      this.revokeInInventory(entry.status.sourceId, ctx);
      return err(ended('credential_expired'));
    }
    const r = await provider.refresh(entry.config, cred.refresh, signalOf(ctx));
    if (entry.epoch !== epoch) return err(ended('revoked_during_call'));
    if (!r.ok) {
      // ENFORCE:refresh-invalid-grant
      if (r.error.code === 'invalid_grant') {
        this.endEntry(entry, 'revoked', 'revoked_by_provider', ctx);
        this.revokeInInventory(entry.status.sourceId, ctx);
        return err(ended('credential_revoked'));
      }
      return err(sanitizeFailure('refresh', r.error));
    }
    const scopes = checkGrantedScopes(provider.info, r.value.scopes);
    // ENFORCE:refresh-scope-recheck
    if (!scopes.ok) {
      this.endEntry(entry, 'revoked', 'refresh_failed', ctx);
      this.revokeInInventory(entry.status.sourceId, ctx);
      return err(discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the refreshed grant is not acceptable', { reason: scopes.error }));
    }
    entry.credential = credentialOf(r.value, ctx.clock.now().getTime(), cred.refresh);
    entry.status = Object.freeze({
      ...entry.status,
      grantedScopes: Object.freeze([...scopes.value]),
      credentialExpiresAt: new Date(entry.credential.accessExpiresAtMs).toISOString(),
    });
    return ok(undefined);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  private endEntry(
    entry: Entry,
    state: 'revoked' | 'expired',
    reason: NonNullable<ConnectionStatus['endedReason']>,
    ctx: ConnectorContext,
  ): void {
    entry.epoch += 1;
    entry.credential = undefined;
    entry.status = Object.freeze({ ...entry.status, state, endedAt: ctx.clock.now().toISOString(), endedReason: reason });
  }

  private revokeInInventory(sourceId: string, ctx: ConnectorContext): void {
    // Best effort and in memory: the credential is already gone, so a failure here can only leave a stale VIEW, never authority.
    const id = SourceId(sourceId);
    if (this.options.inventory.get(id) !== undefined)
      this.options.inventory.apply(id, 'authorization_revoked', ctx.clock.now().toISOString());
  }

  private purgeExpired(nowMs: number): void {
    for (const [id, p] of this.pending) if (nowMs >= p.expiresAtMs && !p.completing) this.pending.delete(id);
  }

  private newOperationId(ctx: ConnectorContext): string {
    return (ctx.auditOptions?.newOperationId ?? (() => `op_${randomUUID()}`))();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commitChain.then(fn, fn);
    this.commitChain = run.catch(() => undefined);
    return run;
  }

  /** One awaited audit write for a connect/revoke operation. `true` only when the event was ACCEPTED. */
  private async record(
    ctx: ConnectorContext,
    audit: OperationAudit,
    phase: 'attempt' | 'terminal',
    outcome: AuditRecordRequest['outcome'],
    operation: Extract<AuditOperation, 'connect_account' | 'revoke_connection'>,
    extra: { readonly errorCode?: string; readonly sourceId?: string } = {},
  ): Promise<boolean> {
    const recorder = ctx.audit;
    const trust = isAuthenticatedPrincipal(ctx.principal) ? { principal: ctx.principal } : undefined;
    if (recorder === undefined || trust === undefined) return false;
    const requested = scopeRef(audit.scope);
    const granted = audit.allow.grant.grantedScope === undefined ? undefined : scopeRef(audit.allow.grant.grantedScope);
    const event: AuditRecordRequest = {
      idempotencyKey: `${audit.operationId}:${phase}`,
      operationId: audit.operationId,
      phase,
      outcome,
      operation,
      occurredAt: ctx.clock.now().toISOString(),
      principal: audit.allow.principal,
      connectorId: CLOUD_CONNECTOR_ID,
      connectorVersion: CONNECTOR_VERSION,
      ...(extra.sourceId !== undefined ? { sourceId: extra.sourceId } : {}),
      permission: audit.permission,
      ...(requested !== undefined ? { requestedScope: requested } : {}),
      ...(granted !== undefined ? { grantedScope: granted } : {}),
      decision: {
        effect: 'allow',
        authority: audit.allow.authority,
        ...(audit.allow.grant.policyId !== undefined ? { policyId: safeIdentifier(audit.allow.grant.policyId) } : {}),
        ...(audit.allow.grant.lifetime !== undefined ? { lifetime: audit.allow.grant.lifetime } : {}),
      },
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
    };
    const accepted = await acceptAuditEvent(recorder, event, trust, ctx.auditOptions ?? {});
    return accepted.ok;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const auditUnavailable = (phase: 'attempt' | 'completion'): DiscoveryError =>
  discoveryError(
    DiscoveryErrorCode.AUDIT_UNAVAILABLE,
    phase === 'attempt'
      ? 'the audit attempt was not accepted; nothing was started'
      : 'the completion audit was not accepted; the connection was not established',
    { phase },
  );

const signalOf = (ctx: ConnectorContext): { readonly signal?: AbortSignal } => (ctx.signal !== undefined ? { signal: ctx.signal } : {});

function who(ctx: ConnectorContext): Principal {
  // Only reached after `requireAuthenticatedPrincipal` succeeded for this ctx.
  return toPrincipalSnapshot(ctx.principal as Parameters<typeof toPrincipalSnapshot>[0]);
}

function snapshotOf(p: Principal): ConnectionStatus['connectedBy'] {
  return Object.freeze({ kind: p.kind, id: p.id, ...(p.orgId !== undefined ? { orgId: p.orgId } : {}) });
}

function credentialOf(grant: TokenGrant, nowMs: number, fallbackRefresh: Secret | undefined): Credential {
  const refresh = grant.refreshToken ?? fallbackRefresh;
  return { access: grant.accessToken, ...(refresh !== undefined ? { refresh } : {}), accessExpiresAtMs: nowMs + grant.expiresInSec * 1000 };
}

function publicStatus(entry: Entry): ConnectionStatus {
  return entry.status;
}

function cloneEntry(entry: Entry): Entry {
  return { status: entry.status, config: entry.config, accountRef: entry.accountRef, credential: entry.credential, epoch: entry.epoch };
}
