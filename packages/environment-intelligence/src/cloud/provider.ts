import { err, ok, type Result } from '@xo/types';
import type { ConfigFieldSpec } from '../connector.js';
import type { Secret } from './secret.js';

/**
 * C3 provider contract. A provider adapter is the ONLY code that knows a vendor's wire protocol. It never decides authorization,
 * never persists anything and never sees a principal: the connection manager owns all of that. Everything a provider returns is
 * untrusted data and is re-validated by the manager (granted scopes, verification URI, user code) before it is used.
 */
export type ProviderFailureCode =
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'rejected'
  | 'malformed'
  | 'invalid_grant'
  | 'declined'
  | 'expired'
  | 'identity_invalid'
  | 'tenant_mismatch';

/** Fixed code only: never provider text. */
export interface ProviderFailure {
  readonly code: ProviderFailureCode;
}
export const providerFailure = (code: ProviderFailureCode): Result<never, ProviderFailure> => err({ code });

export interface ProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: 'saas_application';
  /** The ONLY consent flow this provider offers. No callback listener: the human completes consent on the provider's own page. */
  readonly flow: 'device_code';
  /** Non-secret configuration the administrator must supply. Credentials are never configuration. */
  readonly configFields: readonly ConfigFieldSpec[];
  /** Read-only scopes the connection must be granted for the declared capabilities to work. */
  readonly requiredScopes: readonly string[];
  /** The complete set of scopes this integration accepts. A grant containing anything outside it is refused (no silent over-grant). */
  readonly allowedScopes: readonly string[];
  /** Hosts a human is sent to for consent. A provider response naming any other host is refused. */
  readonly verificationHosts: readonly string[];
  /** What bounds the connection, in words (the thing identity is pinned to). */
  readonly resourceBoundary: string;
  /** Operations this provider's connector actually implements. Capabilities declared = capabilities implemented. */
  readonly capabilities: readonly ('detect' | 'validate_connection' | 'health')[];
  /** Provider-side token revocation is performed by `revoke` when true; otherwise only local credentials are destroyed. */
  readonly remoteRevocation: boolean;
}

/** Validated, non-secret configuration. `tenantId` is the resource boundary the connection is pinned to. */
export interface ProviderConfig {
  readonly providerId: string;
  readonly tenantId: string;
  readonly clientId: string;
}

export interface DeviceAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
  readonly deviceCode: Secret;
}

export interface TokenGrant {
  readonly accessToken: Secret;
  readonly refreshToken?: Secret;
  readonly expiresInSec: number;
  /** As the provider reports them, normalized by the provider adapter to canonical scope names. */
  readonly scopes: readonly string[];
  readonly idToken?: Secret;
}

export type PollOutcome =
  { readonly status: 'pending' } | { readonly status: 'slow_down' } | { readonly status: 'granted'; readonly grant: TokenGrant };

/** The cryptographically verified identity behind a grant. `accountId` is the provider's stable subject id. */
export interface VerifiedAccount {
  readonly tenantId: string;
  readonly accountId: string;
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface CloudProvider {
  readonly info: ProviderInfo;
  /** Hosts the transport for this provider is allowed to reach. */
  readonly allowedHosts: readonly string[];
  parseConfig(raw: unknown): Result<ProviderConfig, ProviderFailure>;
  startDeviceFlow(config: ProviderConfig, options: ProviderCallOptions): Promise<Result<DeviceAuthorization, ProviderFailure>>;
  pollDeviceFlow(config: ProviderConfig, deviceCode: Secret, options: ProviderCallOptions): Promise<Result<PollOutcome, ProviderFailure>>;
  refresh(config: ProviderConfig, refreshToken: Secret, options: ProviderCallOptions): Promise<Result<TokenGrant, ProviderFailure>>;
  /** Verifies the identity assertion that came with `grant` (signature, issuer, audience, tenant, validity window). */
  verifyIdentity(
    config: ProviderConfig,
    grant: TokenGrant,
    nowMs: number,
    options: ProviderCallOptions,
  ): Promise<Result<VerifiedAccount, ProviderFailure>>;
  /** Asks the provider, with the bearer credential, who it belongs to. A cheap authenticated read; no content. */
  probe(
    config: ProviderConfig,
    accessToken: Secret,
    options: ProviderCallOptions,
  ): Promise<Result<{ readonly accountId: string }, ProviderFailure>>;
}

/** Why a grant's scopes are not acceptable. */
export type ScopeProblem = 'insufficient_scope' | 'excess_scope';

/**
 * The manager (not the provider) enforces least privilege: every required scope present, and nothing outside the allow-list.
 * Comparison is exact on the canonical names; there is no inference ("a broader scope implies a narrower one" is NOT assumed).
 */
export function checkGrantedScopes(info: ProviderInfo, granted: readonly string[]): Result<readonly string[], ScopeProblem> {
  const set = new Set(granted);
  // ENFORCE:scope-required
  if (!info.requiredScopes.every((s) => set.has(s))) return err('insufficient_scope');
  // ENFORCE:scope-allowlist
  if (!granted.every((s) => info.allowedScopes.includes(s))) return err('excess_scope');
  return ok([...set].sort());
}
