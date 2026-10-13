import { loadOperatorTrustPolicy, PackageValidator, type PackageTrustPolicy } from '@xo/package-sdk';

/**
 * P1.0 M5 — the CLI's single source of package trust: an injected policy (tests/embedders) or the operator-controlled `XO_PACKAGE_TRUST_POLICY` file. A configured policy that cannot be loaded is an error, never a silent downgrade to `unenforced`.
 */
export function resolveTrustValidator(
  injected?: PackageTrustPolicy,
):
  | { readonly ok: true; readonly validator: PackageValidator; readonly policy: PackageTrustPolicy }
  | { readonly ok: false; readonly message: string } {
  if (injected !== undefined) return { ok: true, validator: new PackageValidator({ trustPolicy: injected }), policy: injected };
  const loaded = loadOperatorTrustPolicy();
  if (!loaded.ok) return { ok: false, message: `[${loaded.error.code}] ${loaded.error.message}` };
  return { ok: true, validator: new PackageValidator({ trustPolicy: loaded.value }), policy: loaded.value };
}
