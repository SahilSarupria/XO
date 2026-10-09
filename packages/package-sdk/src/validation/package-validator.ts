import type { XoManifest } from '@xo/types';
import type { Hasher } from '@xo/crypto';
import { Sha256Hasher, buildMerkleRoot } from '@xo/crypto';
import { hashComponent } from '../hashing/component-hasher.js';
import { isValidSemVer, isValidSemVerRange } from '../manifest/semver.js';
import { PackageVerifier } from '../signing/package-signer.js';
import { isXoManifest, isXoMetadata } from './schema.js';
import type { PackageBundle, ValidationIssue, ValidationReport } from '../types.js';

export interface PackageValidatorOptions {
  readonly hasher?: Hasher;
  readonly verifier?: PackageVerifier;
  /** Resolves a signer DID to its public key PEM, for manifest.signatures (which carry no key of their own). Signature validation is skipped (not failed) when omitted, since a bundle that hasn't been signed yet is still a valid *unsigned* package. */
  readonly resolvePublicKey?: (signerDid: string) => string | undefined;
}

function issue(severity: ValidationIssue['severity'], code: string, message: string, path?: string): ValidationIssue {
  return path !== undefined ? { severity, code, message, path } : { severity, code, message };
}

/**
 * Runs every structural, cryptographic, and consistency check a
 * {@link PackageBundle} needs before it can be packed, published, or
 * installed. Each `validate*` method is independently callable (e.g. the
 * installer's `verifyInstallation()` only needs hash + Merkle, not
 * compatibility); `validateAll` runs the full suite and never short-circuits,
 * so a caller sees every problem in one pass instead of fixing issues
 * one validation run at a time.
 */
export class PackageValidator {
  private readonly hasher: Hasher;
  private readonly verifier: PackageVerifier;
  private readonly resolvePublicKey?: (signerDid: string) => string | undefined;

  constructor(options: PackageValidatorOptions = {}) {
    this.hasher = options.hasher ?? new Sha256Hasher();
    this.verifier = options.verifier ?? new PackageVerifier();
    if (options.resolvePublicKey) this.resolvePublicKey = options.resolvePublicKey;
  }

  validateSchema(manifest: unknown): readonly ValidationIssue[] {
    if (!isXoManifest(manifest)) {
      return [issue('error', 'SCHEMA_INVALID_MANIFEST', 'manifest.json does not match the XoManifest schema', 'manifest.json')];
    }
    return [];
  }

  validateVersion(manifest: XoManifest): readonly ValidationIssue[] {
    return isValidSemVer(manifest.version) ? [] : [issue('error', 'VERSION_INVALID', `"${manifest.version}" is not a valid semantic version`, 'manifest.json#version')];
  }

  /** Detects two components declaring the same archive path — an archive that would silently overwrite one component's file with another's on extraction. */
  validateNoDuplicatePaths(manifest: XoManifest): readonly ValidationIssue[] {
    const seen = new Map<string, string>();
    const issues: ValidationIssue[] = [];
    for (const [kind, entry] of Object.entries(manifest.components)) {
      const owner = seen.get(entry.path);
      if (owner) {
        issues.push(issue('error', 'COMPONENT_DUPLICATE_PATH', `Components "${owner}" and "${kind}" both declare path "${entry.path}"`, entry.path));
      } else {
        seen.set(entry.path, kind);
      }
    }
    return issues;
  }

  validateRequiredComponents(bundle: PackageBundle): readonly ValidationIssue[] {
    const present = new Set(bundle.components.map((c) => c.kind));
    const issues: ValidationIssue[] = [];
    for (const [kind, entry] of Object.entries(bundle.manifest.components)) {
      if (entry.required && !present.has(kind as (typeof bundle.components)[number]['kind'])) {
        issues.push(issue('error', 'REQUIRED_COMPONENT_MISSING', `Required component "${kind}" (${entry.path}) is not present`, entry.path));
      }
    }
    // The two components SPECIFICATION.md §1.2 hard-enforces for every publicly admitted XO.
    for (const mandatory of ['safety_rules', 'benchmark_suite'] as const) {
      if (!(mandatory in bundle.manifest.components)) {
        issues.push(issue('error', 'MANDATORY_COMPONENT_ABSENT', `"${mandatory}" must be declared for a package to be admitted to the public marketplace`));
      }
    }
    return issues;
  }

  /**
   * Checks internal consistency of each declared capability against the
   * rest of the manifest — not against reality (that's the benchmark/
   * challenge system SPECIFICATION.md §3 describes, a later concern).
   * A capability that claims a `requiredComponents` entry the package
   * doesn't actually carry is exactly the kind of inconsistency
   * `@xo/runtime`'s mounter needs caught here, before it ever tries to
   * mount the package and offer a capability it can't back.
   */
  validateCapabilities(manifest: XoManifest): readonly ValidationIssue[] {
    const capabilities = manifest.capabilities ?? [];
    const issues: ValidationIssue[] = [];
    const seenIds = new Set<string>();

    for (const capability of capabilities) {
      const path = `manifest.json#capabilities[${capability.id}]`;
      if (seenIds.has(capability.id)) {
        issues.push(issue('error', 'CAPABILITY_DUPLICATE_ID', `Capability id "${capability.id}" is declared more than once`, path));
      }
      seenIds.add(capability.id);

      for (const kind of capability.requiredComponents) {
        if (!(kind in manifest.components)) {
          issues.push(
            issue('error', 'CAPABILITY_REQUIRED_COMPONENT_UNDECLARED', `Capability "${capability.id}" requires component "${kind}", which is not declared in manifest.components`, path),
          );
        }
      }

      if (capability.confidence.score < 0 || capability.confidence.score > 1) {
        issues.push(issue('error', 'CAPABILITY_CONFIDENCE_OUT_OF_RANGE', `Capability "${capability.id}" confidence.score (${capability.confidence.score}) must be between 0 and 1`, path));
      }
      if (capability.estimatedLatencyMs < 0) {
        issues.push(issue('error', 'CAPABILITY_NEGATIVE_LATENCY', `Capability "${capability.id}" estimatedLatencyMs must not be negative`, path));
      }
      if (capability.estimatedCost.amount < 0) {
        issues.push(issue('error', 'CAPABILITY_NEGATIVE_COST', `Capability "${capability.id}" estimatedCost.amount must not be negative`, path));
      }
      if (capability.providerCompatibility.length === 0) {
        issues.push(issue('warning', 'CAPABILITY_NO_PROVIDER_COMPATIBILITY', `Capability "${capability.id}" declares no providerCompatibility — no host family can ever resolve it`, path));
      }
    }
    return issues;
  }

  validateDependencies(manifest: XoManifest): readonly ValidationIssue[] {
    const dependencies = manifest.dependencies ?? [];
    const issues: ValidationIssue[] = [];
    const seenNames = new Set<string>();

    for (const dependency of dependencies) {
      const path = `manifest.json#dependencies[${dependency.name}]`;

      if (seenNames.has(dependency.name)) {
        issues.push(
          issue(
            'error',
            'DEPENDENCY_DUPLICATE_NAME',
            `Dependency "${dependency.name}" is declared more than once`,
            path,
          ),
        );
      }

      seenNames.add(dependency.name);

      if (dependency.name === manifest.name) {
        issues.push(
          issue(
            'error',
            'DEPENDENCY_SELF_REFERENCE',
            `Package "${manifest.name}" cannot declare itself as a dependency`,
            path,
          ),
        );
      }

      if (!isValidSemVerRange(dependency.versionRange)) {
        issues.push(
          issue(
            'error',
            'DEPENDENCY_RANGE_INVALID',
            `Dependency "${dependency.name}" has an invalid semver range "${dependency.versionRange}"`,
            path,
          ),
        );
      }
    }

    return issues;
  }

  validateHashes(bundle: PackageBundle): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of bundle.components) {
      const entry = bundle.manifest.components[component.kind];
      if (!entry) {
        issues.push(issue('warning', 'COMPONENT_NOT_IN_MANIFEST', `Component "${component.kind}" is present but not declared in manifest.components`, component.path));
        continue;
      }
      const actual = hashComponent(component, this.hasher);
      if (actual !== entry.hash) {
        issues.push(issue('error', 'HASH_MISMATCH', `Component "${component.kind}" hash does not match manifest (expected ${entry.hash}, got ${actual})`, entry.path));
      }
    }
    return issues;
  }

  validateMerkleRoot(bundle: PackageBundle): readonly ValidationIssue[] {
    if (!bundle.manifest.merkleRoot) return [];
    const leaves = Object.entries(bundle.manifest.components)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => entry.hash);
    if (leaves.length === 0) return [];
    const expected = buildMerkleRoot(leaves, this.hasher);
    if (expected !== bundle.manifest.merkleRoot) {
      return [issue('error', 'MERKLE_ROOT_MISMATCH', `Manifest merkleRoot (${bundle.manifest.merkleRoot}) does not match the root computed from component hashes (${expected})`, 'manifest.json#merkleRoot')];
    }
    return [];
  }

  validateSignatures(manifest: XoManifest): readonly ValidationIssue[] {
    if (!manifest.signatures || manifest.signatures.length === 0) return [];
    if (!this.resolvePublicKey) {
      return [issue('warning', 'SIGNATURES_UNVERIFIED', 'Manifest carries signatures but no public-key resolver was supplied — skipping cryptographic verification')];
    }
    const result = this.verifier.verifyAll(manifest, [], this.resolvePublicKey);
    return result.ok ? [] : [issue('error', 'SIGNATURE_INVALID', result.error.message, 'signatures/signatures.json')];
  }

  validateAll(bundle: PackageBundle): ValidationReport {
    const issues = [
      ...this.validateSchema(bundle.manifest),
      ...this.validateVersion(bundle.manifest),
      ...this.validateNoDuplicatePaths(bundle.manifest),
      ...this.validateRequiredComponents(bundle),
      ...this.validateCapabilities(bundle.manifest),
      ...this.validateDependencies(bundle.manifest),
      ...this.validateHashes(bundle),
      ...this.validateMerkleRoot(bundle),
      ...this.validateSignatures(bundle.manifest),
      ...(isXoMetadata(JSON.parse(new TextDecoder().decode(bundle.ancillary.metadataJson)))
        ? []
        : [issue('error', 'METADATA_INVALID', 'metadata.json does not match the XoMetadata schema', 'metadata.json')]),
    ];
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }
}
