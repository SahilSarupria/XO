import { constants, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { err, ok, type Result } from '@xo/types';
import type { HttpResponse, HttpTransport } from './http.js';
import {
  providerFailure,
  type ProviderCallOptions,
  type CloudProvider,
  type DeviceAuthorization,
  type PollOutcome,
  type ProviderConfig,
  type ProviderFailure,
  type ProviderInfo,
  type TokenGrant,
  type VerifiedAccount,
} from './provider.js';
import { revealSecret, Secret } from './secret.js';

/**
 * C3: Microsoft Entra ID / Microsoft Graph, delegated, READ-ONLY identity connection over the OAuth 2.0 device authorization grant
 * (RFC 8628). Chosen because it needs no inbound listener (the human consents on Microsoft's own page and EI only polls outward),
 * supports refresh tokens, and has a tenant boundary that can be verified cryptographically.
 *
 * What this adapter proves and does not prove:
 *  - Scopes `openid offline_access User.Read` only (`profile`/`email` are tolerated if Microsoft reports them; they are identity
 *    claims). NO content scope (Files/Mail/Sites) is requested or accepted: the connector implemented in this slice can establish
 *    and validate an authorized identity, not read content, so it is not given a scope that could.
 *  - The tenant boundary is the verified `tid` of an RS256-signed id_token whose issuer, audience (the client id) and validity window
 *    are checked against the administrator-pinned tenant and client. `alg` is pinned to RS256 (no `none`, no HMAC downgrade).
 *  - LIVE VERIFICATION: nothing here has been exercised against Microsoft. Request/response shapes follow the published protocol and
 *    are covered by scripted tests only.
 */
export const MICROSOFT_PROVIDER_ID = 'microsoft-graph';
export const MICROSOFT_LOGIN_HOST = 'login.microsoftonline.com';
export const MICROSOFT_GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_ME_URL = `https://${MICROSOFT_GRAPH_HOST}/v1.0/me?$select=id`;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REQUESTED_SCOPE = 'openid offline_access User.Read';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_RSA_MODULUS_BYTES = 256;

export const MICROSOFT_INFO: ProviderInfo = Object.freeze({
  id: MICROSOFT_PROVIDER_ID,
  displayName: 'Microsoft 365 (Entra ID, Microsoft Graph) - read-only identity',
  sourceType: 'saas_application' as const,
  flow: 'device_code' as const,
  configFields: Object.freeze([
    Object.freeze({
      name: 'tenantId',
      description: 'Directory (tenant) id the connection is pinned to. A specific tenant GUID; never common/organizations.',
      required: true,
      secret: false,
    }),
    Object.freeze({
      name: 'clientId',
      description:
        'Application (client) id of a PUBLIC client registration with device-code flow enabled. No client secret is used or accepted.',
      required: true,
      secret: false,
    }),
  ]),
  requiredScopes: Object.freeze(['User.Read', 'offline_access', 'openid']),
  allowedScopes: Object.freeze(['User.Read', 'email', 'offline_access', 'openid', 'profile']),
  verificationHosts: Object.freeze(['microsoft.com', 'login.microsoft.com', 'www.microsoft.com']),
  resourceBoundary: 'one Entra tenant (verified tid), one account (verified oid)',
  capabilities: Object.freeze(['detect', 'validate_connection', 'health'] as const),
  remoteRevocation: false,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined;

const transportFailure = (code: string): Result<never, ProviderFailure> =>
  providerFailure(code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' : code === 'network' ? 'unreachable' : 'malformed');

/** Canonical scope name: Graph scopes may come back as `https://graph.microsoft.com/User.Read`; compare on the bare name. */
function canonicalScope(raw: string): string {
  const bare = raw.startsWith(`https://${MICROSOFT_GRAPH_HOST}/`) ? raw.slice(`https://${MICROSOFT_GRAPH_HOST}/`.length) : raw;
  const known = MICROSOFT_INFO.allowedScopes.find((s) => s.toLowerCase() === bare.toLowerCase());
  return known ?? bare;
}

export class MicrosoftGraphProvider implements CloudProvider {
  readonly info = MICROSOFT_INFO;
  readonly allowedHosts = Object.freeze([MICROSOFT_LOGIN_HOST, MICROSOFT_GRAPH_HOST]);

  constructor(private readonly http: HttpTransport) {}

  parseConfig(raw: unknown): Result<ProviderConfig, ProviderFailure> {
    if (!isRecord(raw)) return providerFailure('malformed');
    // Closed schema: unknown keys (a smuggled `clientSecret`, `token`, `authority`) are refused, not ignored.
    for (const key of Object.keys(raw)) if (key !== 'tenantId' && key !== 'clientId') return providerFailure('malformed');
    const tenantId = raw['tenantId'];
    const clientId = raw['clientId'];
    if (typeof tenantId !== 'string' || !GUID.test(tenantId) || typeof clientId !== 'string' || !GUID.test(clientId))
      return providerFailure('malformed');
    return ok(Object.freeze({ providerId: MICROSOFT_PROVIDER_ID, tenantId: tenantId.toLowerCase(), clientId: clientId.toLowerCase() }));
  }

  private authority(config: ProviderConfig): string {
    return `https://${MICROSOFT_LOGIN_HOST}/${config.tenantId}`;
  }

  async startDeviceFlow(config: ProviderConfig, options: ProviderCallOptions): Promise<Result<DeviceAuthorization, ProviderFailure>> {
    const r = await this.http.send({
      method: 'POST',
      url: `${this.authority(config)}/oauth2/v2.0/devicecode`,
      form: { client_id: config.clientId, scope: REQUESTED_SCOPE },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!r.ok) return transportFailure(r.error.code);
    if (r.value.status >= 500) return providerFailure('unreachable');
    if (r.value.status !== 200 || !isRecord(r.value.body)) return providerFailure('rejected');
    const b = r.value.body;
    const deviceCode = str(b['device_code'], 2048);
    const userCode = str(b['user_code'], 32);
    const verificationUri = str(b['verification_uri'], 512);
    const expiresInSec = int(b['expires_in'], 60, 1800);
    const intervalSec = b['interval'] === undefined ? 5 : int(b['interval'], 1, 60);
    if (
      deviceCode === undefined ||
      userCode === undefined ||
      !USER_CODE.test(userCode) ||
      verificationUri === undefined ||
      expiresInSec === undefined ||
      intervalSec === undefined
    )
      return providerFailure('malformed');
    return ok({ userCode, verificationUri, expiresInSec, intervalSec, deviceCode: new Secret(deviceCode) });
  }

  async pollDeviceFlow(
    config: ProviderConfig,
    deviceCode: Secret,
    options: ProviderCallOptions,
  ): Promise<Result<PollOutcome, ProviderFailure>> {
    const r = await this.tokenRequest(
      config,
      { grant_type: DEVICE_GRANT, client_id: config.clientId, device_code: revealSecret(deviceCode) },
      options,
    );
    if (!r.ok) return r;
    const { status, body } = r.value;
    if (status === 200) {
      const grant = this.parseGrant(body);
      return grant.ok ? ok({ status: 'granted', grant: grant.value }) : grant;
    }
    if (status >= 500) return providerFailure('unreachable');
    const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
    switch (code) {
      case 'authorization_pending':
        return ok({ status: 'pending' });
      case 'slow_down':
        return ok({ status: 'slow_down' });
      case 'authorization_declined':
        return providerFailure('declined');
      case 'expired_token':
      case 'bad_verification_code':
        return providerFailure('expired');
      default:
        return providerFailure('rejected');
    }
  }

  async refresh(config: ProviderConfig, refreshToken: Secret, options: ProviderCallOptions): Promise<Result<TokenGrant, ProviderFailure>> {
    const r = await this.tokenRequest(
      config,
      { grant_type: 'refresh_token', client_id: config.clientId, refresh_token: revealSecret(refreshToken), scope: REQUESTED_SCOPE },
      options,
    );
    if (!r.ok) return r;
    const { status, body } = r.value;
    if (status === 200) return this.parseGrant(body);
    if (status >= 500) return providerFailure('unreachable');
    const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
    // Revoked, expired, consent withdrawn, password changed, conditional access: the credential is no longer usable.
    return providerFailure(
      code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required' ? 'invalid_grant' : 'rejected',
    );
  }

  private tokenRequest(
    config: ProviderConfig,
    form: Record<string, string>,
    options: ProviderCallOptions,
  ): Promise<Result<HttpResponse, ProviderFailure>> {
    return this.http
      .send({
        method: 'POST',
        url: `${this.authority(config)}/oauth2/v2.0/token`,
        form,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      .then((r) => (r.ok ? ok(r.value) : transportFailure(r.error.code)));
  }

  private parseGrant(body: unknown): Result<TokenGrant, ProviderFailure> {
    if (!isRecord(body)) return providerFailure('malformed');
    const accessToken = str(body['access_token'], MAX_TOKEN_LENGTH);
    const tokenType = body['token_type'];
    const expiresIn = int(body['expires_in'], 60, 86_400);
    const scope = str(body['scope'], 2048);
    if (
      accessToken === undefined ||
      typeof tokenType !== 'string' ||
      tokenType.toLowerCase() !== 'bearer' ||
      expiresIn === undefined ||
      scope === undefined
    )
      return providerFailure('malformed');
    const refreshToken = body['refresh_token'] === undefined ? undefined : str(body['refresh_token'], MAX_TOKEN_LENGTH);
    const idToken = body['id_token'] === undefined ? undefined : str(body['id_token'], MAX_TOKEN_LENGTH);
    if ((body['refresh_token'] !== undefined && refreshToken === undefined) || (body['id_token'] !== undefined && idToken === undefined))
      return providerFailure('malformed');
    const scopes = scope
      .split(' ')
      .filter((s) => s.length > 0)
      .map(canonicalScope);
    return ok({
      accessToken: new Secret(accessToken),
      ...(refreshToken !== undefined ? { refreshToken: new Secret(refreshToken) } : {}),
      expiresInSec: expiresIn,
      scopes,
      ...(idToken !== undefined ? { idToken: new Secret(idToken) } : {}),
    });
  }

  async verifyIdentity(
    config: ProviderConfig,
    grant: TokenGrant,
    nowMs: number,
    options: ProviderCallOptions,
  ): Promise<Result<VerifiedAccount, ProviderFailure>> {
    if (grant.idToken === undefined) return providerFailure('identity_invalid');
    const parts = revealSecret(grant.idToken).split('.');
    if (parts.length !== 3) return providerFailure('identity_invalid');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeJson(h);
    const claims = decodeJson(p);
    if (header === undefined || claims === undefined) return providerFailure('identity_invalid');
    const kid = str(header['kid'], 128);
    // ENFORCE:idtoken-alg-rs256
    if (header['alg'] !== 'RS256' || kid === undefined) return providerFailure('identity_invalid');

    const jwks = await this.http.send({
      method: 'GET',
      url: `${this.authority(config)}/discovery/v2.0/keys`,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!jwks.ok) return transportFailure(jwks.error.code);
    if (
      jwks.value.status !== 200 ||
      !isRecord(jwks.value.body) ||
      !Array.isArray(jwks.value.body['keys']) ||
      jwks.value.body['keys'].length > 50
    )
      return providerFailure('identity_invalid');
    const jwk = (jwks.value.body['keys'] as unknown[]).find((k) => isRecord(k) && k['kid'] === kid && k['kty'] === 'RSA');
    if (!isRecord(jwk)) return providerFailure('identity_invalid');
    const n = str(jwk['n'], 2048);
    const e = str(jwk['e'], 16);
    // ENFORCE:idtoken-modulus-min
    if (n === undefined || e === undefined || Buffer.from(n, 'base64url').byteLength < MIN_RSA_MODULUS_BYTES)
      return providerFailure('identity_invalid');
    let verified = false;
    try {
      const key = createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
      verified = cryptoVerify(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        { key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(s, 'base64url'),
      );
    } catch {
      return providerFailure('identity_invalid');
    }
    // ENFORCE:idtoken-signature
    if (!verified) return providerFailure('identity_invalid');

    const tid = claims['tid'];
    // ENFORCE:idtoken-tenant
    if (typeof tid !== 'string' || tid.toLowerCase() !== config.tenantId) return providerFailure('tenant_mismatch');
    // ENFORCE:idtoken-issuer
    if (
      claims['iss'] !== `https://${MICROSOFT_LOGIN_HOST}/${config.tenantId}/v2.0` &&
      claims['iss'] !== `https://${MICROSOFT_LOGIN_HOST}/${tid}/v2.0`
    )
      return providerFailure('identity_invalid');
    // ENFORCE:idtoken-audience
    if (typeof claims['aud'] !== 'string' || claims['aud'].toLowerCase() !== config.clientId) return providerFailure('identity_invalid');
    const exp = claims['exp'];
    // ENFORCE:idtoken-expiry
    if (typeof exp !== 'number' || exp * 1000 <= nowMs - CLOCK_SKEW_MS) return providerFailure('identity_invalid');
    for (const k of ['nbf', 'iat'] as const) {
      const v = claims[k];
      if (v !== undefined && (typeof v !== 'number' || v * 1000 > nowMs + CLOCK_SKEW_MS)) return providerFailure('identity_invalid');
    }
    const oid = claims['oid'];
    // ENFORCE:idtoken-oid
    if (typeof oid !== 'string' || !GUID.test(oid)) return providerFailure('identity_invalid');
    return ok({ tenantId: config.tenantId, accountId: oid.toLowerCase() });
  }

  async probe(
    _config: ProviderConfig,
    accessToken: Secret,
    options: ProviderCallOptions,
  ): Promise<Result<{ readonly accountId: string }, ProviderFailure>> {
    const r = await this.http.send({
      method: 'GET',
      url: GRAPH_ME_URL,
      bearer: accessToken,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!r.ok) return transportFailure(r.error.code);
    if (r.value.status === 401) return providerFailure('invalid_grant');
    if (r.value.status >= 500) return providerFailure('unreachable');
    if (r.value.status !== 200 || !isRecord(r.value.body)) return providerFailure('rejected');
    const id = r.value.body['id'];
    if (typeof id !== 'string' || !GUID.test(id)) return providerFailure('malformed');
    return ok({ accountId: id.toLowerCase() });
  }
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  if (segment.length === 0 || segment.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Convenience: the failure-or-ok shape used by tests and the manager when a transport error must become a provider failure. */
export const asProviderFailure = (e: ProviderFailure): Result<never, ProviderFailure> => err(e);
