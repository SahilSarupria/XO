import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { MockClock } from '@xo/testing';
import {
  InMemoryAuditSink,
  PermissionId,
  PermissionManager,
  RuleBasedPolicy,
  establishAuthenticatedPrincipal,
  resourceScope,
  type AuthenticatedPrincipal,
  type PolicyRule,
} from '@xo/permissions';
import {
  CloudConnectionManager,
  ConnectorRegistry,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  MicrosoftGraphProvider,
  PermissionManagerAuthorization,
  PinnedHttpsTransport,
  type AuthorizationPort,
  type CloudProvider,
  type ConnectorContext,
  type AuditRecorder,
} from '../../src/index.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
export const CLIENT = '33333333-3333-4333-8333-333333333333';
export const OID = '44444444-4444-4444-8444-444444444444';
export const OTHER_OID = '55555555-5555-4555-8555-555555555555';
export const KID = 'test-key-1';

/** Marker substrings that must never appear in anything but the scripted provider's own responses. */
export const SECRET_MARKERS = ['AT-SECRET-', 'RT-SECRET-', 'DC-SECRET-'] as const;

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface SignOptions {
  readonly alg?: string;
  readonly kid?: string;
  readonly tamper?: boolean;
}

export class TestKeys {
  readonly privateKey: KeyObject;
  readonly jwk: { kty: string; n: string; e: string; kid: string };
  constructor(bits = 2048) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
    this.privateKey = privateKey;
    const j = publicKey.export({ format: 'jwk' });
    this.jwk = { kty: 'RSA', n: String(j.n), e: String(j.e), kid: KID };
  }
  sign(claims: Record<string, unknown>, options: SignOptions = {}): string {
    const header = b64({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' });
    const payload = b64(claims);
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const sig = signer.sign(this.privateKey).toString('base64url');
    return options.tamper === true ? `${header}.${b64({ ...claims, oid: OTHER_OID })}.${sig}` : `${header}.${payload}.${sig}`;
  }
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: string | undefined;
  readonly credentials: string | undefined;
}

/**
 * A scripted stand-in for Microsoft's endpoints, plugged in as the transport's `fetch`. It proves CONTRACT behaviour of our code
 * against the documented wire shapes; it is NOT Microsoft and proves nothing about real OAuth, token exchange, refresh or revocation.
 */
export class ScriptedMicrosoft {
  readonly keys: TestKeys;
  constructor(keyBits = 2048) {
    this.keys = new TestKeys(keyBits);
  }
  readonly requests: RecordedRequest[] = [];
  nowMs: () => number = () => Date.now();
  // device flow
  pollsBeforeGrant = 0;
  deviceStatus = 200;
  deviceBody: Record<string, unknown> | undefined;
  verificationUri = 'https://microsoft.com/devicelogin';
  tokenError: string | undefined; // forced error on every poll
  // token grant
  scope = 'User.Read openid profile email offline_access';
  includeRefresh = true;
  expiresIn = 3600;
  tokenBodyOverride: Record<string, unknown> | undefined;
  tokenStatus = 200;
  // identity
  oid = OID;
  tid = TENANT;
  aud = CLIENT;
  iss: string | undefined;
  idTokenTtlSec = 3600;
  idTokenOptions: SignOptions = {};
  omitIdToken = false;
  jwksKeys: unknown[] | undefined;
  jwksStatus = 200;
  // refresh
  refreshMode: 'ok' | 'invalid_grant' | 'unreachable' | 'excess_scope' | 'no_refresh_token' = 'ok';
  // graph
  graphStatus = 200;
  graphId: string | undefined;
  graphThrows = false;
  hangGraph = false;
  /** When set, Graph answers only after this promise resolves (to hold a call in flight). */
  graphGate: Promise<void> | undefined;
  // counters
  polls = 0;
  issued = 0;
  refreshes = 0;
  graphCalls = 0;
  private readonly liveAccess = new Set<string>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    this.requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
      credentials: init?.credentials,
    });
    const u = new URL(url);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (u.pathname.endsWith('/oauth2/v2.0/devicecode')) {
      return this.json(
        this.deviceStatus,
        this.deviceBody ?? {
          device_code: 'DC-SECRET-1',
          user_code: 'ABCD-EFGH',
          verification_uri: this.verificationUri,
          expires_in: 900,
          interval: 5,
        },
      );
    }
    if (u.pathname.endsWith('/oauth2/v2.0/token')) {
      const grantType = form.get('grant_type');
      if (grantType === 'refresh_token') return this.refresh();
      this.polls += 1;
      if (this.tokenError !== undefined) return this.json(400, { error: this.tokenError });
      if (this.polls <= this.pollsBeforeGrant) return this.json(400, { error: 'authorization_pending' });
      return this.json(this.tokenStatus, this.tokenBodyOverride ?? this.grantBody());
    }
    if (u.pathname.endsWith('/discovery/v2.0/keys')) {
      return this.json(this.jwksStatus, { keys: this.jwksKeys ?? [this.keys.jwk] });
    }
    if (u.hostname === 'graph.microsoft.com') {
      this.graphCalls += 1;
      if (this.graphThrows) throw new TypeError('network down');
      if (this.hangGraph)
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      if (this.graphGate !== undefined) await this.graphGate;
      const bearer = (headers['authorization'] ?? '').replace('Bearer ', '');
      if (this.graphStatus !== 200) return this.json(this.graphStatus, { error: { code: 'x' } });
      if (!this.liveAccess.has(bearer)) return this.json(401, { error: { code: 'InvalidAuthenticationToken' } });
      return this.json(200, { id: this.graphId ?? this.oid });
    }
    return this.json(404, {});
  };

  /** Withdraws every issued access token, as a provider-side revocation would. */
  invalidateAccessTokens(): void {
    this.liveAccess.clear();
  }

  private grantBody(refreshOverride?: string): Record<string, unknown> {
    this.issued += 1;
    const access = `AT-SECRET-${this.issued}`;
    this.liveAccess.add(access);
    const now = Math.floor(this.nowMs() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.iss ?? `https://login.microsoftonline.com/${this.tid}/v2.0`,
      aud: this.aud,
      tid: this.tid,
      oid: this.oid,
      iat: now,
      nbf: now,
      exp: now + this.idTokenTtlSec,
    };
    return {
      token_type: 'Bearer',
      scope: this.scope,
      expires_in: this.expiresIn,
      access_token: access,
      ...(this.includeRefresh ? { refresh_token: refreshOverride ?? `RT-SECRET-${this.issued}` } : {}),
      ...(this.omitIdToken ? {} : { id_token: this.keys.sign(claims, this.idTokenOptions) }),
    };
  }

  private refresh(): Response {
    this.refreshes += 1;
    switch (this.refreshMode) {
      case 'invalid_grant':
        return this.json(400, { error: 'invalid_grant', error_description: 'AADSTS70008 refresh token SECRET-DETAIL' });
      case 'unreachable':
        return this.json(503, { error: 'temporarily_unavailable' });
      case 'excess_scope': {
        const saved = this.scope;
        this.scope = `${saved} Mail.ReadWrite`;
        const body = this.grantBody();
        this.scope = saved;
        return this.json(200, body);
      }
      case 'no_refresh_token': {
        const saved = this.includeRefresh;
        this.includeRefresh = false;
        const body = this.grantBody();
        this.includeRefresh = saved;
        return this.json(200, body);
      }
      default:
        return this.json(200, this.grantBody());
    }
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}

export interface CloudEnv {
  readonly clock: MockClock;
  readonly provider: ScriptedMicrosoft;
  readonly manager: CloudConnectionManager;
  readonly registry: ConnectorRegistry;
  readonly inventory: EnvironmentInventory;
  readonly audit: InMemoryAuditRecorder;
  readonly ledger: EvidenceLedger;
  readonly principal: AuthenticatedPrincipal;
  readonly permissionAudit: InMemoryAuditSink;
  readonly slept: number[];
  ctx(overrides?: Partial<ConnectorContext>): ConnectorContext;
}

export const allowRules = (tenant = TENANT, permissions: readonly string[] = ['network.connect', 'secrets.write']): PolicyRule[] =>
  permissions.map((permission) => ({
    id: `allow-${permission.replace('.', '-')}-${tenant.slice(0, 8)}`,
    effect: 'ALLOW' as const,
    match: {
      permission: PermissionId(permission),
      packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER,
      scope: resourceScope(`cloud/microsoft-graph/${tenant}`),
    },
  }));

export interface EnvOptions {
  readonly rules?: readonly PolicyRule[];
  readonly authorization?: (inner: AuthorizationPort) => AuthorizationPort;
  readonly audit?: (inner: InMemoryAuditRecorder) => AuditRecorder;
  readonly principalId?: string;
  readonly maxPending?: number;
  readonly inventory?: EnvironmentInventory;
  readonly ledger?: EvidenceLedger;
  readonly keyBits?: number;
  readonly wrapProvider?: (p: CloudProvider) => CloudProvider;
}

export function makeCloudEnv(options: EnvOptions = {}): CloudEnv {
  const clock = new MockClock();
  const provider = new ScriptedMicrosoft(options.keyBits);
  provider.nowMs = () => clock.now().getTime();
  const transport = new PinnedHttpsTransport(['login.microsoftonline.com', 'graph.microsoft.com'], {
    fetchImpl: provider.fetch,
    timeoutMs: 5_000,
  });
  const registry = new ConnectorRegistry();
  const inventory = options.inventory ?? new EnvironmentInventory();
  const slept: number[] = [];
  const manager = new CloudConnectionManager({
    providers: [
      options.wrapProvider === undefined
        ? new MicrosoftGraphProvider(transport)
        : options.wrapProvider(new MicrosoftGraphProvider(transport)),
    ],
    registry,
    inventory,
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
  });
  const permissionAudit = new InMemoryAuditSink();
  const permissions = new PermissionManager({
    policy: new RuleBasedPolicy(options.rules ?? allowRules()),
    auditSink: permissionAudit,
    clock,
  });
  const base = new PermissionManagerAuthorization(permissions);
  const authorization = options.authorization === undefined ? base : options.authorization(base);
  const minted = establishAuthenticatedPrincipal({ kind: 'human', id: options.principalId ?? 'admin-1' });
  if (!minted.ok) throw new Error('principal');
  const audit = new InMemoryAuditRecorder(() => clock.now());
  const recorder = options.audit === undefined ? audit : options.audit(audit);
  const ledger = options.ledger ?? new EvidenceLedger();
  return {
    clock,
    provider,
    manager,
    registry,
    inventory,
    audit,
    ledger,
    principal: minted.value,
    permissionAudit,
    slept,
    ctx: (overrides = {}) => ({ clock, authorization, principal: minted.value, audit: recorder, ledger, ...overrides }),
  };
}

/** Connects once through the full flow and returns the connection id. */
export async function connectOnce(env: CloudEnv): Promise<string> {
  const begun = await env.manager.beginConnect(env.ctx(), {
    providerId: 'microsoft-graph',
    config: { tenantId: TENANT, clientId: CLIENT },
  });
  if (!begun.ok) throw new Error(`begin failed: ${begun.error.code}`);
  const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
  if (!done.ok) throw new Error(`complete failed: ${done.error.code} ${JSON.stringify(done.error.context)}`);
  return done.value.connection.connectionId;
}
