import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';

/** Environment variable naming the operator-controlled trust policy file. */
export const TRUST_POLICY_ENV = 'XO_PACKAGE_TRUST_POLICY';

/**
 * Environment variable that explicitly selects the trust mode. Absent/blank means `enforce` (the secure default): a trust policy is then REQUIRED. The only other accepted value is `development`, which must be spelled out and is refused when `NODE_ENV=production` or when a policy file is also configured. A missing policy file is never read as a request for development mode.
 */
export const TRUST_MODE_ENV = 'XO_TRUST_MODE';

/** Shown wherever development mode is active (CLI output, API startup log, doctor, validation reports). */
export const DEVELOPMENT_TRUST_WARNING = `PACKAGE TRUST IS DISABLED (${TRUST_MODE_ENV}=development): package signatures are NOT verified and no package is reported trusted. For local development only — never production or enterprise.`;

export type SignatureRole = 'creator' | 'reviewer' | 'co_signer';
const ROLES: readonly SignatureRole[] = ['creator', 'reviewer', 'co_signer'];

/**
 * `enforce`: signatures are verified against {@link TrustedKey}s and the policy's requirements are hard failures.
 * `development`: explicit local-development compatibility — nothing is verified and nothing is ever reported as trusted. It can only be selected by `XO_TRUST_MODE=development` (or `PackageTrustPolicy.development()` in code); a policy file can never select it.
 */
export type TrustMode = 'enforce' | 'development';

export interface TrustedKey {
  /** `ed25519:<sha256 hex of the SPKI DER>` — always derived from `publicKeyPem`, never trusted from input alone. */
  readonly keyId: string;
  readonly signerDid: string;
  /** Normalised SPKI PEM. */
  readonly publicKeyPem: string;
  readonly algorithm: 'ed25519';
  readonly status: 'active' | 'revoked';
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly revokedAt?: string;
  readonly comment?: string;
}

export interface TrustPolicyInit {
  readonly mode: TrustMode;
  /** Unsigned packages are refused (enforce mode only). */
  readonly requireSignature: boolean;
  /** Every listed role needs at least one verified signature. */
  readonly requiredRoles: readonly SignatureRole[];
  /** A verified `creator` signature must come from `manifest.creatorDid`. */
  readonly bindPublisher: boolean;
  readonly keys: readonly TrustedKey[];
}

const DID_RE = /^[A-Za-z0-9][A-Za-z0-9._:%@-]{0,255}$/;
const MAX_KEYS = 1000;

function bad(message: string): PackageError {
  return new PackageError(ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED, `Invalid package trust policy: ${message}`);
}

function notConfigured(message: string, options?: { readonly cause?: unknown }): PackageError {
  return new PackageError(ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED, message, options);
}

/** Immutable, validated trust configuration. Constructed only from operator-controlled input (a config file or code), never from package contents. */
export class PackageTrustPolicy {
  readonly mode: TrustMode;
  readonly requireSignature: boolean;
  readonly requiredRoles: readonly SignatureRole[];
  readonly bindPublisher: boolean;
  readonly keys: readonly TrustedKey[];
  /** Stable digest of the policy contents; recorded with install records so the policy a package was admitted under is identifiable. */
  readonly policyId: string;
  private readonly byDid: ReadonlyMap<string, readonly TrustedKey[]>;

  private constructor(init: TrustPolicyInit) {
    this.mode = init.mode;
    this.requireSignature = init.requireSignature;
    this.requiredRoles = Object.freeze([...init.requiredRoles]);
    this.bindPublisher = init.bindPublisher;
    this.keys = Object.freeze([...init.keys]);
    const map = new Map<string, TrustedKey[]>();
    for (const k of this.keys) map.set(k.signerDid, [...(map.get(k.signerDid) ?? []), k]);
    this.byDid = map;
    this.policyId = `sha256:${createHash('sha256')
      .update(JSON.stringify({ m: this.mode, s: this.requireSignature, r: this.requiredRoles, b: this.bindPublisher, k: this.keys }))
      .digest('hex')}`;
  }

  /**
   * Explicit development compatibility: signatures are not verified and no package is ever reported `trusted`. There is deliberately no implicit way to obtain this policy — callers (and the environment resolver in {@link loadOperatorTrustPolicy}) must ask for it by name.
   */
  static development(): PackageTrustPolicy {
    return new PackageTrustPolicy({ mode: 'development', requireSignature: false, requiredRoles: [], bindPublisher: false, keys: [] });
  }

  /** Validates `init` strictly and builds an enforcing policy. Development mode is never constructible from data: use {@link PackageTrustPolicy.development}. */
  static create(init: TrustPolicyInit): Result<PackageTrustPolicy, PackageError> {
    if (init.mode !== 'enforce') {
      return err(bad('mode must be "enforce" (development mode is selected only by XO_TRUST_MODE=development, never by policy data)'));
    }
    if (typeof init.requireSignature !== 'boolean' || typeof init.bindPublisher !== 'boolean') {
      return err(bad('requireSignature and bindPublisher must be booleans'));
    }
    if (!Array.isArray(init.requiredRoles) || init.requiredRoles.some((r) => !ROLES.includes(r))) {
      return err(bad(`requiredRoles must be a subset of ${ROLES.join(', ')}`));
    }
    if (new Set(init.requiredRoles).size !== init.requiredRoles.length) return err(bad('requiredRoles contains duplicates'));
    if (init.requireSignature && init.requiredRoles.length === 0) {
      return err(bad('requireSignature=true needs at least one required role'));
    }
    if (!Array.isArray(init.keys) || init.keys.length > MAX_KEYS) return err(bad(`keys must be an array of at most ${MAX_KEYS} entries`));
    const seen = new Set<string>();
    for (const k of init.keys) {
      if (typeof k?.keyId !== 'string' || typeof k.signerDid !== 'string' || !DID_RE.test(k.signerDid))
        return err(bad('key entry has an invalid keyId/signerDid'));
      if (seen.has(k.keyId)) return err(bad(`duplicate keyId "${k.keyId}"`));
      seen.add(k.keyId);
    }
    return ok(new PackageTrustPolicy(init));
  }

  /** Candidate keys (active and revoked) registered for a signer identity. Exact-match lookup. */
  keysFor(signerDid: string): readonly TrustedKey[] {
    return this.byDid.get(signerDid) ?? [];
  }
}

/** Strictly parses and normalises one PEM public key; returns the derived `keyId` and canonical SPKI PEM. */
export function normalizeEd25519PublicKey(pem: unknown): Result<{ readonly keyId: string; readonly publicKeyPem: string }, PackageError> {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > 4096) return err(bad('publicKeyPem must be a non-empty PEM string'));
  if (/PRIVATE/.test(pem)) return err(bad('publicKeyPem must not contain private key material'));
  if ((pem.match(/-----BEGIN /g) ?? []).length !== 1) return err(bad('publicKeyPem must contain exactly one PEM block'));
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519')
      return err(bad(`unsupported key algorithm "${String(key.asymmetricKeyType)}" (only ed25519 is supported)`));
    const der = key.export({ type: 'spki', format: 'der' });
    return ok({
      keyId: `ed25519:${createHash('sha256').update(der).digest('hex')}`,
      publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
    });
  } catch {
    return err(bad('publicKeyPem is not a valid public key'));
  }
}

function isoDate(value: unknown, label: string): Result<string | undefined, PackageError> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    return err(bad(`${label} must be an ISO-8601 UTC timestamp`));
  }
  return ok(value);
}

const POLICY_FIELDS = ['version', 'mode', 'requireSignature', 'requiredRoles', 'bindPublisher', 'keys'];
const KEY_FIELDS = ['keyId', 'signerDid', 'publicKeyPem', 'algorithm', 'status', 'notBefore', 'notAfter', 'revokedAt', 'comment'];

/** Parses the operator trust-policy JSON document (version 1). Unknown fields, unsupported algorithms and malformed keys are rejected, never ignored. */
export function parseTrustPolicy(input: unknown): Result<PackageTrustPolicy, PackageError> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return err(bad('policy must be a JSON object'));
  const doc = input as Record<string, unknown>;
  const extra = Object.keys(doc).filter((k) => !POLICY_FIELDS.includes(k));
  if (extra.length > 0) return err(bad(`unknown field(s): ${extra.join(', ')}`));
  if (doc['version'] !== 1) return err(bad('unsupported policy version (expected 1)'));
  const mode = doc['mode'] ?? 'enforce';
  if (mode !== 'enforce') {
    return err(
      bad(
        `mode must be "enforce" (got ${JSON.stringify(mode)}); a policy file cannot disable verification — development mode is selected only by ${TRUST_MODE_ENV}=development`,
      ),
    );
  }
  const requireSignature = doc['requireSignature'] ?? true;
  const bindPublisher = doc['bindPublisher'] ?? true;
  const requiredRoles = doc['requiredRoles'] ?? ['creator'];
  const rawKeys = doc['keys'];
  if (!Array.isArray(rawKeys)) return err(bad('keys must be an array'));
  if (rawKeys.length > MAX_KEYS) return err(bad(`keys must have at most ${MAX_KEYS} entries`));

  const keys: TrustedKey[] = [];
  for (const raw of rawKeys) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err(bad('each key must be an object'));
    const k = raw as Record<string, unknown>;
    const unknown = Object.keys(k).filter((f) => !KEY_FIELDS.includes(f));
    if (unknown.length > 0) return err(bad(`key has unknown field(s): ${unknown.join(', ')}`));
    if (k['algorithm'] !== 'ed25519') return err(bad('key algorithm must be "ed25519"'));
    if (typeof k['signerDid'] !== 'string' || !DID_RE.test(k['signerDid'])) return err(bad('key signerDid is missing or malformed'));
    if (k['status'] !== 'active' && k['status'] !== 'revoked') return err(bad('key status must be "active" or "revoked"'));
    const norm = normalizeEd25519PublicKey(k['publicKeyPem']);
    if (!norm.ok) return norm;
    if (k['keyId'] !== undefined && k['keyId'] !== norm.value.keyId)
      return err(bad(`keyId "${String(k['keyId'])}" does not match the supplied key (${norm.value.keyId})`));
    const nb = isoDate(k['notBefore'], 'notBefore');
    if (!nb.ok) return nb;
    const na = isoDate(k['notAfter'], 'notAfter');
    if (!na.ok) return na;
    const ra = isoDate(k['revokedAt'], 'revokedAt');
    if (!ra.ok) return ra;
    if (k['status'] === 'revoked' && ra.value === undefined) return err(bad('revoked keys must carry revokedAt'));
    if (k['comment'] !== undefined && (typeof k['comment'] !== 'string' || k['comment'].length > 500))
      return err(bad('comment must be a string of at most 500 characters'));
    keys.push({
      keyId: norm.value.keyId,
      signerDid: k['signerDid'],
      publicKeyPem: norm.value.publicKeyPem,
      algorithm: 'ed25519',
      status: k['status'],
      ...(nb.value !== undefined ? { notBefore: nb.value } : {}),
      ...(na.value !== undefined ? { notAfter: na.value } : {}),
      ...(ra.value !== undefined ? { revokedAt: ra.value } : {}),
      ...(typeof k['comment'] === 'string' ? { comment: k['comment'] } : {}),
    });
  }
  // The same key must not be both trusted and revoked (or listed twice): ambiguous operator intent fails closed.
  return PackageTrustPolicy.create({
    mode: 'enforce',
    requireSignature: requireSignature as boolean,
    requiredRoles: requiredRoles as SignatureRole[],
    bindPublisher: bindPublisher as boolean,
    keys,
  });
}

function isProduction(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
}

/**
 * The one rule that keeps development compatibility out of production: a development policy is refused when `NODE_ENV=production`, however it was obtained (environment, or injected by an embedder/test harness). Every entry point applies it to whatever policy it ends up with, so none can be the permissive one.
 */
export function assertTrustPolicyAllowedHere(
  policy: PackageTrustPolicy,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<PackageTrustPolicy, PackageError> {
  if (policy.mode === 'development' && isProduction(env)) {
    return err(
      notConfigured(
        `development trust mode is refused when NODE_ENV=production: production requires an enforcing trust policy (${TRUST_POLICY_ENV})`,
      ),
    );
  }
  return ok(policy);
}

/**
 * Resolves the effective package-trust configuration from the environment. This is the ONE resolver every entry point (CLI install/verify/publish/run, API startup, registry publish, runtime mount) goes through, so they cannot disagree about mode or policy.
 *
 * Fail-closed semantics — any row not listed is an error:
 *
 * | `XO_TRUST_MODE`   | `XO_PACKAGE_TRUST_POLICY` | `NODE_ENV`     | Result                                      |
 * | ----------------- | ------------------------- | -------------- | ------------------------------------------- |
 * | unset / `enforce` | readable, valid file      | any            | enforcing policy from the file              |
 * | unset / `enforce` | unset / blank             | any            | ERROR — a policy is required                |
 * | unset / `enforce` | unreadable / invalid      | any            | ERROR — never a downgrade                   |
 * | `development`     | unset / blank             | not production | development policy (nothing verified)      |
 * | `development`     | set                       | any            | ERROR — ambiguous, refuse to pick one       |
 * | `development`     | any                       | `production`   | ERROR — forbidden in production             |
 * | anything else     | any                       | any            | ERROR — unknown mode                        |
 *
 * A missing policy is therefore never interpreted as development mode; development mode exists only when asked for by name.
 */
export function loadOperatorTrustPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Result<PackageTrustPolicy, PackageError> {
  const rawMode = env[TRUST_MODE_ENV]?.trim();
  const mode = rawMode === undefined || rawMode.length === 0 ? 'enforce' : rawMode;
  if (mode !== 'enforce' && mode !== 'development') {
    return err(notConfigured(`${TRUST_MODE_ENV} must be "enforce" or "development" (got "${mode}"); refusing to guess a trust mode`));
  }

  const path = env[TRUST_POLICY_ENV];
  const hasPath = path !== undefined && path.trim().length > 0;

  if (mode === 'development') {
    if (isProduction(env)) {
      return err(
        notConfigured(
          `${TRUST_MODE_ENV}=development is refused when NODE_ENV=production: production requires an enforcing trust policy (${TRUST_POLICY_ENV})`,
        ),
      );
    }
    if (hasPath) {
      return err(
        notConfigured(
          `${TRUST_MODE_ENV}=development cannot be combined with ${TRUST_POLICY_ENV}: unset one of them (a configured policy is never silently ignored)`,
        ),
      );
    }
    return ok(PackageTrustPolicy.development());
  }

  if (!hasPath) {
    return err(
      notConfigured(
        `no package trust policy is configured: set ${TRUST_POLICY_ENV} to an operator trust-policy file. (For local development only, ${TRUST_MODE_ENV}=development explicitly disables package trust verification.)`,
      ),
    );
  }
  let text: string;
  try {
    text = readFile(path);
  } catch (cause) {
    return err(notConfigured(`${TRUST_POLICY_ENV} is set to "${path}" but it could not be read`, { cause }));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return err(notConfigured(`${TRUST_POLICY_ENV} file "${path}" is not valid JSON`, { cause }));
  }
  return parseTrustPolicy(json);
}
