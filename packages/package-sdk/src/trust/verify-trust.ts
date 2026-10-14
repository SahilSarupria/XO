import { verify as nodeVerify, createPublicKey } from 'node:crypto';
import type { XoManifest } from '@xo/types';
import { fingerprintManifest, signableManifestBytes } from '../hashing/fingerprint.js';
import type { PackageTrustPolicy, SignatureRole, TrustedKey, TrustMode } from './trust-policy.js';

export type TrustStatus =
  /** At least one signature verified against operator-trusted keys and every policy requirement is met. */
  | 'trusted'
  /** Enforcing policy rejected the package (bad/untrusted/revoked signature, unmet role, publisher mismatch, or unsigned while a signature is required). */
  | 'untrusted'
  /** Enforcing policy, no signatures, and signatures are not required. Not trusted — merely permitted. */
  | 'unsigned'
  /** Explicit development mode: nothing was verified and nothing is claimed. Never to be treated as trusted. */
  | 'unverified';

export type TrustFailureCode =
  | 'PACKAGE_UNSIGNED'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'SIGNER_UNTRUSTED'
  | 'KEY_REVOKED'
  | 'KEY_NOT_VALID_NOW'
  | 'ROLE_REQUIREMENT_UNMET'
  | 'PUBLISHER_MISMATCH'
  /** No trust policy (enforcing or explicit development) was supplied to the component that needed one. Fails closed. */
  | 'TRUST_NOT_CONFIGURED';

export interface TrustFailure {
  readonly code: TrustFailureCode;
  readonly message: string;
  readonly signerDid?: string;
}

export interface VerifiedSigner {
  readonly signerDid: string;
  readonly role: SignatureRole;
  readonly keyId: string;
}

export interface TrustVerdict {
  readonly status: TrustStatus;
  /** Whether the package may be admitted under the policy (`trusted`, permitted `unsigned`, or `unverified` in explicit development mode). */
  readonly acceptable: boolean;
  /** The trust mode the verdict was computed under; `unconfigured` when no policy was supplied (never acceptable). Always surfaced so a development-mode admission cannot be mistaken for an enforced one. */
  readonly mode: TrustMode | 'unconfigured';
  readonly signers: readonly VerifiedSigner[];
  readonly failures: readonly TrustFailure[];
  readonly policyId: string;
  /** Fingerprint of the signable manifest bytes the verdict was computed over. */
  readonly manifestFingerprint: string;
}

const ROLES: readonly string[] = ['creator', 'reviewer', 'co_signer'];

/** Strict canonical base64 of exactly 64 bytes (an Ed25519 signature). */
function decodeSignature(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== 88) return undefined;
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return undefined;
  const buf = Buffer.from(value, 'base64');
  return buf.length === 64 && buf.toString('base64') === value ? buf : undefined;
}

function verifyWith(message: Uint8Array, signature: Buffer, key: TrustedKey): boolean {
  try {
    return nodeVerify(null, message, createPublicKey(key.publicKeyPem), signature);
  } catch {
    return false;
  }
}

function inWindow(key: TrustedKey, now: Date): boolean {
  const t = now.getTime();
  if (key.notBefore !== undefined && t < Date.parse(key.notBefore)) return false;
  if (key.notAfter !== undefined && t > Date.parse(key.notAfter)) return false;
  return true;
}

/**
 * Evaluates a manifest's signatures against an operator {@link PackageTrustPolicy}.
 *
 * Trust comes only from `policy.keys`. Nothing carried by the package (a `publicKeyPem` beside a signature, a key in the manifest) is ever consulted. Every signature entry must verify: a malformed, unknown-signer, revoked or non-verifying entry fails the whole package rather than being skipped.
 *
 * Revocation is conservative: a signature made by a key now marked `revoked` is rejected regardless of when it was made, because the format carries no trustworthy signing time.
 */
export function evaluatePackageTrust(manifest: XoManifest, policy: PackageTrustPolicy | undefined, now: Date = new Date()): TrustVerdict {
  const manifestFingerprint = fingerprintManifest(manifest);

  // Fail closed: a caller that was never given a trust policy gets a refusal, not a default.
  if (policy === undefined) {
    return {
      status: 'untrusted',
      acceptable: false,
      mode: 'unconfigured',
      signers: [],
      failures: [
        {
          code: 'TRUST_NOT_CONFIGURED',
          message:
            'no package trust policy is configured (set XO_PACKAGE_TRUST_POLICY; for local development only, XO_TRUST_MODE=development explicitly disables verification)',
        },
      ],
      policyId: 'none',
      manifestFingerprint,
    };
  }

  const base = { policyId: policy.policyId, mode: policy.mode, manifestFingerprint };

  if (policy.mode === 'development') {
    return { status: 'unverified', acceptable: true, signers: [], failures: [], ...base };
  }

  const entries: unknown = manifest.signatures ?? [];
  const failures: TrustFailure[] = [];
  const signers: VerifiedSigner[] = [];

  if (!Array.isArray(entries)) {
    return {
      status: 'untrusted',
      acceptable: false,
      signers: [],
      failures: [{ code: 'SIGNATURE_MALFORMED', message: 'manifest.signatures is not an array' }],
      ...base,
    };
  }
  if (entries.length === 0) {
    if (policy.requireSignature) {
      return {
        status: 'untrusted',
        acceptable: false,
        signers: [],
        failures: [{ code: 'PACKAGE_UNSIGNED', message: 'package is unsigned and the trust policy requires a signature' }],
        ...base,
      };
    }
    return { status: 'unsigned', acceptable: true, signers: [], failures: [], ...base };
  }

  const message = signableManifestBytes(manifest);
  const seenPairs = new Set<string>();

  for (const raw of entries as unknown[]) {
    const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const did = e['signerDid'];
    const role = e['role'];
    if (typeof did !== 'string' || did.length === 0 || typeof role !== 'string' || !ROLES.includes(role)) {
      failures.push({ code: 'SIGNATURE_MALFORMED', message: 'signature entry has a missing/invalid signerDid or role' });
      continue;
    }
    const pair = `${did}\u0000${role}`;
    if (seenPairs.has(pair)) {
      failures.push({ code: 'SIGNATURE_MALFORMED', message: `duplicate signature entry for "${did}" (${role})`, signerDid: did });
      continue;
    }
    seenPairs.add(pair);

    const sig = decodeSignature(e['signature']);
    if (sig === undefined) {
      failures.push({
        code: 'SIGNATURE_MALFORMED',
        message: `signature from "${did}" is not a canonical base64 Ed25519 signature`,
        signerDid: did,
      });
      continue;
    }

    const candidates = policy.keysFor(did);
    if (candidates.length === 0) {
      failures.push({ code: 'SIGNER_UNTRUSTED', message: `signer "${did}" has no key in the trust policy`, signerDid: did });
      continue;
    }

    const matching = candidates.filter((k) => verifyWith(message, sig, k));
    const good = matching.find((k) => k.status === 'active' && inWindow(k, now));
    if (good !== undefined) {
      signers.push({ signerDid: did, role: role as SignatureRole, keyId: good.keyId });
    } else if (matching.some((k) => k.status === 'revoked')) {
      failures.push({ code: 'KEY_REVOKED', message: `signature from "${did}" was made by a revoked key`, signerDid: did });
    } else if (matching.length > 0) {
      failures.push({
        code: 'KEY_NOT_VALID_NOW',
        message: `signature from "${did}" was made by a key outside its validity window`,
        signerDid: did,
      });
    } else {
      failures.push({ code: 'SIGNATURE_INVALID', message: `signature from "${did}" (${role}) does not verify`, signerDid: did });
    }
  }

  for (const role of policy.requiredRoles) {
    if (!signers.some((s) => s.role === role)) {
      failures.push({ code: 'ROLE_REQUIREMENT_UNMET', message: `trust policy requires a verified "${role}" signature` });
    }
  }

  if (policy.bindPublisher) {
    const creators = signers.filter((s) => s.role === 'creator');
    if (creators.some((s) => s.signerDid !== manifest.creatorDid) || (creators.length === 0 && policy.requireSignature)) {
      failures.push({
        code: 'PUBLISHER_MISMATCH',
        message: `no verified creator signature from the manifest's creatorDid "${manifest.creatorDid}"`,
      });
    }
  }

  const trusted = failures.length === 0 && signers.length > 0;
  return { status: trusted ? 'trusted' : 'untrusted', acceptable: trusted, signers, failures, ...base };
}
