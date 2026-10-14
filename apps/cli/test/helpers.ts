import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CapabilityDeclaration,
  CapabilityExecutionDeclaration,
  CapabilityInputSchema,
  CompatibilityDeclaration,
  DependencyDeclaration,
  ManifestPermissionDeclaration,
} from '@xo/types';
import { ManifestBuilder, PackageInstaller, PackageTrustPolicy, PackageValidator, type PackageBundle } from '@xo/package-sdk';
import { LocalFsBlobStore, type BlobStore } from '@xo/storage';

/**
 * P1.0 M5: package trust is fail-closed — the CLI refuses to install/verify/publish/run with no trust configuration. These tests exercise
 * packaging behaviour, not trust, so the whole test process runs in EXPLICIT development mode (the same operator setting a developer would
 * use) — set here, in one visible place, never inferred. Tests about trust either inject a policy or scrub this variable with
 * {@link withTrustEnv}. node:test runs each test file in its own process, so this cannot leak between files.
 */
process.env['XO_TRUST_MODE'] = 'development';

/** Runs `fn` with the trust-related environment replaced by `env` (unlisted trust variables are removed), then restores it. */
export async function withTrustEnv<T>(env: Readonly<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
  const keys = ['XO_TRUST_MODE', 'XO_PACKAGE_TRUST_POLICY', 'NODE_ENV'];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** An installer whose validator is in explicit development mode (see the note above). */
export function devInstaller(store: BlobStore): PackageInstaller {
  return new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: PackageTrustPolicy.development() }) });
}

/**
 * A minimal, always-valid `CompatibilityDeclaration` + capability +
 * component set, built directly from `@xo/package-sdk`'s public
 * `ManifestBuilder` (never reimplementing what it already validates) —
 * the CLI test equivalent of `@xo/runtime/test/fixtures.ts`'s
 * `buildContractLawyerBundle`, which apps/cli can't import since it's
 * not part of `@xo/runtime`'s published `dist/`.
 */
export const testCompatibility: CompatibilityDeclaration = {
  modelFamilies: [
    { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'safety_rules', 'benchmark_suite'] },
  ],
  fallbackPolicy: 'degrade_gracefully',
};

export const echoCapability: CapabilityDeclaration = {
  id: 'echo',
  name: 'Echo',
  description: 'Echoes the input back for CLI-level testing.',
  providerCompatibility: ['claude'],
  requiredComponents: ['knowledge_graph'],
  estimatedCost: { currency: 'USD', amount: 0.001 },
  estimatedLatencyMs: 100,
  confidence: { score: 0.9, basis: 'self_reported' },
};

export interface TestBundleOptions {
  readonly name?: string;
  readonly version?: string;
  readonly capabilities?: readonly CapabilityDeclaration[];
  readonly dependencies?: readonly DependencyDeclaration[];
}

export function buildTestBundle(options: TestBundleOptions = {}): PackageBundle {
  const result = ManifestBuilder.create()
    .setIdentity({
      formatVersion: '1.0',
      name: options.name ?? 'xo_cli_test_pkg',
      version: options.version ?? '1.0.0',
      creatorDid: 'did:xo:cli-test',
    })
    .setCompatibility(testCompatibility)
    .setMetadata({ domain: 'testing', description: 'CLI test fixture package', scope: ['testing'], limitations: [] })
    .setCapabilities(options.capabilities ?? [echoCapability])
    .setDependencies(options.dependencies ?? [])
    .addComponent({
      kind: 'knowledge_graph',
      path: 'knowledge/graph.json',
      data: new TextEncoder().encode('{"nodes":[],"edges":[]}'),
      required: false,
    })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
    .addComponent({
      kind: 'benchmark_suite',
      path: 'evaluation/benchmark_suite.json',
      data: new TextEncoder().encode('{"categories":[]}'),
      required: true,
    })
    .build();
  if (!result.ok) throw new Error(`Test fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

/**
 * A package bundle whose `knowledge_graph` component embeds a real
 * `SemanticCapabilityContract` (`@xo/capability-contract`) for a
 * `claim_approval` capability with one deterministic comparison rule —
 * "claim amount exceeds 10000" — matching the exact grammar
 * `StructuredComparisonBindingResolver`/`comparison-grammar.ts` accepts.
 * This is the CLI-level regression fixture for the deterministic-router
 * (see `deterministic-router.ts`): with no `inputs` declared on the
 * contract, the field phrase "claim amount" resolves to the runtime
 * input key `claim_amount` (`normalizeToFallbackKey`), so a caller
 * invokes it as `{ claim_amount: <number> }`. Handwritten JSON rather
 * than run through the real compiler (unlike
 * `examples/vertical-test/run.ts`, which proves the compiler->contract
 * leg separately) — this fixture exists only to prove the CLI-level
 * routing decision, not to re-prove extraction.
 */
export function buildDeterministicClaimBundle(): PackageBundle {
  const knowledgeGraph = {
    nodes: [
      {
        id: 'claim_approval',
        kind: 'capability',
        properties: {
          requiredPermissions: [], // P1.0 M2: explicit permission-free declaration (absent => denied)
          semanticCapabilityContract: {
            id: 'claim_approval',
            name: 'Claim Approval',
            description: 'Denies a claim when the claim amount exceeds the threshold.',
            inputs: [],
            outputs: [],
            requiredPermissions: [],
            determinism: 'deterministic',
            rules: [
              {
                sourceNodeId: 'claim_approval_rule_1',
                kind: 'decision_node',
                condition: 'claim amount exceeds 10000',
                outcome: 'deny',
                exceptionConditions: [],
                confidence: 0.95,
              },
            ],
            confidence: 0.95,
            sourceRefs: [],
            sourceXoirNodeIds: ['claim_approval', 'claim_approval_rule_1'],
          },
        },
      },
    ],
    edges: [],
  };

  const claimApprovalCapability: CapabilityDeclaration = {
    id: 'claim_approval',
    name: 'Claim Approval',
    description: 'Denies a claim when the claim amount exceeds 10000.',
    providerCompatibility: ['claude'],
    requiredComponents: ['knowledge_graph'],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.95, basis: 'self_reported' },
  };

  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'xo_cli_test_claim_pkg', version: '1.0.0', creatorDid: 'did:xo:cli-test' })
    .setCompatibility(testCompatibility)
    .setMetadata({
      domain: 'testing',
      description: 'CLI deterministic-execution test fixture package',
      scope: ['testing'],
      limitations: [],
    })
    .setCapabilities([claimApprovalCapability])
    .setDependencies([])
    .addComponent({
      kind: 'knowledge_graph',
      path: 'knowledge/graph.json',
      data: new TextEncoder().encode(JSON.stringify(knowledgeGraph)),
      required: false,
    })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
    .addComponent({
      kind: 'benchmark_suite',
      path: 'evaluation/benchmark_suite.json',
      data: new TextEncoder().encode('{"categories":[]}'),
      required: true,
    })
    .build();
  if (!result.ok) throw new Error(`Deterministic test fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

/** The default, valid `CapabilityInputSchema` every `buildAuthoritativeClaimBundle` fixture uses unless overridden — matches `claim_amount exceeds 10000`'s single field. */
export const claimApprovalInputSchema: CapabilityInputSchema = {
  type: 'object',
  properties: { claim_amount: { type: 'number' } },
  required: ['claim_amount'],
};

export interface AuthoritativeClaimBundleOptions {
  /** Defaults to `claimApprovalInputSchema`. Pass `null` to build a declaration with `execution.mode` set but no `inputSchema` at all (R1 present, R2 not applicable). */
  readonly inputSchema?: CapabilityInputSchema | null;
  /** Defaults to `0.95` (above `MIN_DETERMINISTIC_EXECUTION_CONFIDENCE`). Set below the threshold to exercise R3's confidence gate. */
  readonly confidence?: number;
  /** Manifest-level `permissions[]` declarations (R3's real, reused authorization source) — defaults to none (permissionless). */
  readonly permissions?: readonly ManifestPermissionDeclaration[];
  /** `execution.requiredPermissionIds` — defaults to none. */
  readonly executionRequiredPermissionIds?: readonly string[];
  /** P1.0 M2 — the capability node's own `requiredPermissions` property. Default `[]` (explicit permission-free); `'omit'` leaves it absent; anything else is stored verbatim (for malformed-declaration tests). */
  readonly nodeRequiredPermissions?: unknown;
  /** The CONTRACT / graph-node id (`execution.contractId`). Defaults to `claim_approval` (== the manifest capability id); a different value exercises the manifest-id != contract-id case. */
  readonly contractNodeId?: string;
}

/**
 * R1/R2/R3's authoritative-declaration fixture: same `claim_approval` /
 * `claim amount exceeds 10000` capability as {@link buildDeterministicClaimBundle},
 * but with `CapabilityDeclaration.execution` populated — so the router
 * uses the `authoritative_declaration` source, not the
 * `knowledge_graph_fallback` one, and R2/R3's gates (schema validation,
 * confidence threshold, manifest-derived permission authorization)
 * actually have something to check.
 * {@link buildDeterministicClaimBundle} itself is left completely
 * untouched (per R1's brief: "preserve the existing CLI behavior for the
 * current approved deterministic regression fixture") — it remains the
 * fallback-path regression case.
 */
export function buildAuthoritativeClaimBundle(options: AuthoritativeClaimBundleOptions = {}): PackageBundle {
  const knowledgeGraph = {
    nodes: [
      {
        id: options.contractNodeId ?? 'claim_approval',
        kind: 'capability',
        properties: {
          ...(options.nodeRequiredPermissions === 'omit'
            ? {}
            : { requiredPermissions: options.nodeRequiredPermissions === undefined ? [] : options.nodeRequiredPermissions }), // P1.0 M2: explicit declaration (absent => denied)
          semanticCapabilityContract: {
            id: options.contractNodeId ?? 'claim_approval',
            name: 'Claim Approval',
            description: 'Denies a claim when the claim amount exceeds the threshold.',
            inputs: [],
            outputs: [],
            requiredPermissions: [],
            determinism: 'deterministic',
            rules: [
              {
                sourceNodeId: 'claim_approval_rule_1',
                kind: 'decision_node',
                condition: 'claim amount exceeds 10000',
                outcome: 'deny',
                exceptionConditions: [],
                confidence: 0.95,
              },
            ],
            confidence: 0.95,
            sourceRefs: [],
            sourceXoirNodeIds: [options.contractNodeId ?? 'claim_approval', 'claim_approval_rule_1'],
          },
        },
      },
    ],
    edges: [],
  };

  const execution: CapabilityExecutionDeclaration = {
    mode: 'deterministic_rule',
    contractId: options.contractNodeId ?? 'claim_approval',
    ...(options.inputSchema !== null ? { inputSchema: options.inputSchema ?? claimApprovalInputSchema } : {}),
    ...(options.executionRequiredPermissionIds !== undefined ? { requiredPermissionIds: options.executionRequiredPermissionIds } : {}),
  };

  const claimApprovalCapability: CapabilityDeclaration = {
    id: 'claim_approval',
    name: 'Claim Approval',
    description: 'Denies a claim when the claim amount exceeds 10000.',
    providerCompatibility: ['claude'],
    requiredComponents: ['knowledge_graph'],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: options.confidence ?? 0.95, basis: 'self_reported' },
    execution,
  };

  let builder = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'xo_cli_test_authoritative_claim_pkg', version: '1.0.0', creatorDid: 'did:xo:cli-test' })
    .setCompatibility(testCompatibility)
    .setMetadata({
      domain: 'testing',
      description: 'R1/R2/R3 authoritative-declaration test fixture package',
      scope: ['testing'],
      limitations: [],
    })
    .setCapabilities([claimApprovalCapability])
    .setDependencies([])
    .addComponent({
      kind: 'knowledge_graph',
      path: 'knowledge/graph.json',
      data: new TextEncoder().encode(JSON.stringify(knowledgeGraph)),
      required: false,
    })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
    .addComponent({
      kind: 'benchmark_suite',
      path: 'evaluation/benchmark_suite.json',
      data: new TextEncoder().encode('{"categories":[]}'),
      required: true,
    });

  if (options.permissions !== undefined) builder = builder.setPermissions(options.permissions);

  const result = builder.build();
  if (!result.ok) throw new Error(`Authoritative claim test fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

/** Creates a fresh temp directory, runs `fn` with it, and always removes it afterward — regardless of `fn` throwing. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Installs `bundle` into a fresh temp `LocalFsBlobStore`-backed store and hands both back — for tests that need an already-installed package (e.g. `xo run`) without going through the CLI's own `install` command. */
export async function withInstalledBundle<T>(
  bundle: PackageBundle,
  fn: (storeDir: string, installer: PackageInstaller) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-cli-test-store-', async (storeDir) => {
    const installer = devInstaller(new LocalFsBlobStore(storeDir));
    const installResult = await installer.install(bundle);
    if (!installResult.ok) throw new Error(`Test fixture install failed: ${installResult.error.message}`);
    return fn(storeDir, installer);
  });
}
