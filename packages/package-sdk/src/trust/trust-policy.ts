import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';

/** Environment variable naming the operator-controlled trust policy file. */
export const TRUST_POLICY_ENV = 'XO_PACKAGE_TRUST_POLICY';

export type SignatureRole = 'creator' | 'reviewer' | 'co_signer';
const ROLES: readonly SignatureRole[] = ['creator', 'reviewer', 'co_signer'];

/** `enforce`: signatures are verified against {@link TrustedKey}s and the policy's requirements are hard failures. `unenforced`: nothing is verified and nothing is reported as trusted (legacy behaviour, explicit and visible). */
export type TrustMode = 'enforce' | 'unenforced';

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
  return new PackageError(ErrorCode.PACKAGE_UNTRUSTED, `Invalid package trust policy: ${message}`);
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

  /** Explicitly nothing enforced: signatures are not verified and no package is ever reported `trusted`. This is the pre-M5 behaviour, kept only so deployments without a configured policy keep working — and say so. */
  static unenforced(): PackageTrustPolicy {
    return new PackageTrustPolicy({ mode: 'unenforced', requireSignature: false, requiredRoles: [], bindPublisher: false, keys: [] });
  }

  /** Validates `init` strictly and builds an enforcing (or explicitly unenforced) policy. */
  static create(init: TrustPolicyInit): Result<PackageTrustPolicy, PackageError> {
    if (init.mode !== 'enforce' && init.mode !== 'unenforced') return err(bad('mode must be "enforce" or "unenforced"'));
    if (typeof init.requireSignature !== 'boolean' || typeof init.bindPublisher !== 'boolean') {
      return err(bad('requireSignature and bindPublisher must be booleans'));
    }
    if (!Array.isArray(init.requiredRoles) || init.requiredRoles.some((r) => !ROLES.includes(r))) {
      return err(bad(`requiredRoles must be a subset of ${ROLES.join(', ')}`));
    }
    if (new Set(init.requiredRoles).size !== init.requiredRoles.length) return err(bad('requiredRoles contains duplicates'));
    if (init.mode === 'enforce' && init.requireSignature && init.requiredRoles.length === 0) {
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
    mode: mode as TrustMode,
    requireSignature: requireSignature as boolean,
    requiredRoles: requiredRoles as SignatureRole[],
    bindPublisher: bindPublisher as boolean,
    keys,
  });
}

/**
 * Loads the operator trust policy named by `XO_PACKAGE_TRUST_POLICY`.
 * Unset → the explicit {@link PackageTrustPolicy.unenforced} policy. Set but unreadable/invalid → an error: a configured policy that cannot be loaded never silently downgrades to unenforced.
 */
export function loadOperatorTrustPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Result<PackageTrustPolicy, PackageError> {
  const path = env[TRUST_POLICY_ENV];
  if (path === undefined || path.trim().length === 0) return ok(PackageTrustPolicy.unenforced());
  let text: string;
  try {
    text = readFile(path);
  } catch (cause) {
    return err(
      new PackageError(ErrorCode.PACKAGE_UNTRUSTED, `${TRUST_POLICY_ENV} is set to "${path}" but it could not be read`, { cause }),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_UNTRUSTED, `${TRUST_POLICY_ENV} file "${path}" is not valid JSON`, { cause }));
  }
  return parseTrustPolicy(json);
}
