import {
  DEVELOPMENT_TRUST_WARNING,
  assertTrustPolicyAllowedHere,
  loadOperatorTrustPolicy,
  PackageTrustPolicy,
  PackageValidator,
  type InstalledPackageRecord,
} from '@xo/package-sdk';

export interface ResolvedTrust {
  readonly ok: true;
  readonly validator: PackageValidator;
  readonly policy: PackageTrustPolicy;
  /** Non-empty exactly when development mode is active; every command that admits, verifies, publishes or runs packages prepends these to its output. */
  readonly warnings: readonly string[];
}

/**
 * P1.0 M5 — the CLI's single source of package trust, shared by install, verify, publish and run (the API and the runtime go through the same `loadOperatorTrustPolicy`). Effective trust is an injected policy (tests/embedders) or the environment: an operator trust-policy file (`XO_PACKAGE_TRUST_POLICY`) or, for local development only, the explicit `XO_TRUST_MODE=development`.
 *
 * It fails closed: with neither configured, with an unreadable/invalid policy, or with a contradictory combination, the command stops with an error. A missing policy is never read as development mode.
 */
export function resolveTrustValidator(injected?: PackageTrustPolicy): ResolvedTrust | { readonly ok: false; readonly message: string } {
  let policy: PackageTrustPolicy;
  if (injected !== undefined) {
    const allowed = assertTrustPolicyAllowedHere(injected);
    if (!allowed.ok) return { ok: false, message: `[${allowed.error.code}] ${allowed.error.message}` };
    policy = injected;
  } else {
    const loaded = loadOperatorTrustPolicy();
    if (!loaded.ok) return { ok: false, message: `[${loaded.error.code}] ${loaded.error.message}` };
    policy = loaded.value;
  }
  return {
    ok: true,
    validator: new PackageValidator({ trustPolicy: policy }),
    policy,
    warnings: policy.mode === 'development' ? [`warning: ${DEVELOPMENT_TRUST_WARNING}`] : [],
  };
}

/** One human-readable line describing how a package was admitted — shows `unverified [mode=development]` rather than anything resembling trust when verification was off. */
export function describeTrust(trust: NonNullable<InstalledPackageRecord['trust']>): string {
  return `${trust.status} [mode=${trust.mode}]${trust.signers.length > 0 ? ` signers: ${trust.signers.map((s) => `${s.signerDid}/${s.role}`).join(', ')}` : ''}`;
}

/**
 * Validator for AUTHORING commands (`xo create`, `xo build`): they check a package's structure before writing a .xo file and admit, publish, mount and run nothing, so no trust policy applies to them — and they never claim one. It is an explicit development-mode validator (structure, hashes and Merkle root are checked; signatures are not evaluated against any policy), and the packages they sign carry a throw-away development key that no enforcing policy trusts. Everything that *uses* a package (install, verify, publish, run, API, runtime) goes through {@link resolveTrustValidator} instead.
 */
export function authoringValidator(): PackageValidator {
  return new PackageValidator({ trustPolicy: PackageTrustPolicy.development() });
}
