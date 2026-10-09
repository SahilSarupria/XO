import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityDeclaration, CompatibilityDeclaration, ManifestPermissionDeclaration, XoMetadata } from '@xo/types';
import { LocalFsBlobStore } from '@xo/storage';
import { ManifestBuilder, PackageInstaller, type Clock, type PackageBundle } from '@xo/package-sdk';

export const contractCompatibility: CompatibilityDeclaration = {
  modelFamilies: [
    { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'decision_trees', 'safety_rules'] },
    { family: 'gpt', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'safety_rules'] },
  ],
  fallbackPolicy: 'degrade_gracefully',
};

export const strictCompatibility: CompatibilityDeclaration = {
  modelFamilies: [{ family: 'claude', minCapability: ['chat', 'tool_use', 'long_context'], consumes: ['decision_trees', 'safety_rules'] }],
  fallbackPolicy: 'reject',
};

export const sampleMetadata: XoMetadata = {
  domain: 'legal',
  description: 'Corporate contract review',
  scope: ['contract_review'],
  limitations: ['Not a substitute for a licensed attorney'],
};

export const contractAnalysisCapability: CapabilityDeclaration = {
  id: 'contract_analysis',
  name: 'Contract Analysis',
  description: 'Reviews corporate contracts for risk and missing clauses.',
  providerCompatibility: ['claude', 'gpt'],
  requiredComponents: ['knowledge_graph', 'safety_rules'],
  estimatedCost: { currency: 'USD', amount: 0.01 },
  estimatedLatencyMs: 1500,
  confidence: { score: 0.8, basis: 'expert_review' },
};

export const clauseLookupCapability: CapabilityDeclaration = {
  id: 'clause_lookup',
  name: 'Clause Lookup',
  description: 'Looks up individual clause types quickly.',
  providerCompatibility: ['claude'],
  requiredComponents: ['knowledge_graph'],
  estimatedCost: { currency: 'USD', amount: 0.002 },
  estimatedLatencyMs: 400,
  confidence: { score: 0.6, basis: 'self_reported' },
};

export const fraudDetectionCapability: CapabilityDeclaration = {
  id: 'fraud_detection',
  name: 'Fraud Detection',
  description: 'Flags anomalous transactions for review.',
  providerCompatibility: ['claude'],
  requiredComponents: ['decision_trees', 'safety_rules'],
  estimatedCost: { currency: 'USD', amount: 0.02 },
  estimatedLatencyMs: 2200,
  confidence: { score: 0.5, basis: 'benchmark' },
};

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface BuildBundleOptions {
  readonly name?: string;
  readonly version?: string;
  readonly compatibility?: CompatibilityDeclaration;
  readonly capabilities?: readonly CapabilityDeclaration[];
  readonly knowledgeGraph?: Readonly<Record<string, unknown>>;
  readonly safetyRules?: Readonly<Record<string, unknown>>;
  readonly permissions?: readonly ManifestPermissionDeclaration[];
}

export const sampleSafetyRules = {
  rules: [
    { pattern: 'ignore (all|previous) instructions', action: 'block', reason: 'prompt injection attempt' },
    { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'redact', reason: 'PII' },
  ],
};

export function buildContractLawyerBundle(options: BuildBundleOptions = {}): PackageBundle {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: options.name ?? 'xo_contract_lawyer', version: options.version ?? '1.0.0', creatorDid: 'did:xo:test-creator' })
    .setCompatibility(options.compatibility ?? contractCompatibility)
    .setMetadata(sampleMetadata)
    .setCapabilities(options.capabilities ?? [contractAnalysisCapability, clauseLookupCapability])
    .setPermissions(options.permissions ?? [])
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode(JSON.stringify(options.knowledgeGraph ?? { nodes: [], edges: [] })), required: false })
    .addComponent({ kind: 'decision_trees', path: 'reasoning/decision_trees.json', data: new TextEncoder().encode('{"trees":[]}'), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify(options.safetyRules ?? { rules: [] })), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

export function buildFraudDetectorBundle(options: BuildBundleOptions = {}): PackageBundle {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: options.name ?? 'xo_fraud_detector', version: options.version ?? '1.0.0', creatorDid: 'did:xo:test-creator' })
    .setCompatibility(options.compatibility ?? strictCompatibility)
    .setMetadata({ domain: 'finance', description: 'Fraud detection', scope: ['fraud_detection'], limitations: [] })
    .setCapabilities(options.capabilities ?? [fraudDetectionCapability])
    .setPermissions(options.permissions ?? [])
    .addComponent({ kind: 'decision_trees', path: 'reasoning/decision_trees.json', data: new TextEncoder().encode('{"trees":[]}'), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify(options.safetyRules ?? { rules: [] })), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

export async function withTempInstaller<T>(fn: (installer: PackageInstaller, store: LocalFsBlobStore) => Promise<T>, clock?: Clock): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-'));
  try {
    const store = new LocalFsBlobStore(dir);
    const installer = new PackageInstaller(store, clock ? { clock } : {});
    return await fn(installer, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Stage 2 fixtures ----------------------------------------------

import { PackageRegistry, type MountedPackage } from '../src/registry/mounted-package.js';
import { PackageLoader } from '../src/loader/package-loader.js';
import { MountId } from '../src/ids.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderId, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '@xo/ai-core';

/** Mounts `bundle` (already installed on `installer`) into a fresh `PackageRegistry`, for tests that don't need the full `PackageLoader` verification path exercised. */
export async function mountBundle(installer: PackageInstaller, bundle: PackageBundle, registry: PackageRegistry = PackageRegistry.empty()): Promise<PackageRegistry> {
  const loader = new PackageLoader(installer);
  const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, registry);
  if (!result.ok) throw new Error(`Fixture mount failed: ${result.error.message}`);
  return result.value;
}

export function fakeMountedPackage(bundle: PackageBundle): MountedPackage {
  return Object.freeze({
    mountId: MountId(`${bundle.manifest.name}@${bundle.manifest.version}#0`),
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    manifest: bundle.manifest,
    capabilities: (bundle.manifest.capabilities ?? []).map((declaration) => ({ declaration, packageName: bundle.manifest.name, packageVersion: bundle.manifest.version })),
    mountedAt: '2026-01-01T00:00:00.000Z',
    manifestHash: 'sha256:fake',
  }) as unknown as MountedPackage;
}

/**
 * A scriptable `ModelProvider` test double for `@xo/runtime`'s own
 * tests — distinct from `@xo/ai-core`'s own `ScriptableTestProvider`
 * (`providers/scriptable-test-provider.ts`), which doesn't implement
 * `completeStream` at all (its own doc comment: it exists to exercise
 * `router.ts`'s retry/circuit-breaker/fallback behavior, which doesn't
 * need streaming). This one supports streaming, since `@xo/runtime`'s
 * own tests need to exercise `executeStreaming`.
 */
export class ScriptedModelProvider implements ModelProvider {
  public readonly requests: ProviderRequest[] = [];
  public failNextWith: Error | undefined;
  public streamEventsToYield: readonly ProviderStreamEvent[] | undefined;
  /** When set, `complete()` waits this long before resolving — for tests that need to race cancellation against an in-flight call. */
  public delayMs = 0;
  /** R6: when set, `complete()` fails with this error for the first N calls (decrementing on each), then behaves normally — for exercising the retry loop's "eventually succeeds" path. Independent of `failNextWith` (which always fails exactly the next single call regardless of this counter). */
  public failNextCallsWith: { error: Error; count: number } | undefined;

  constructor(
    public readonly id: ProviderId = 'anthropic',
    private response: ProviderResponse = { text: 'default response', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' },
    private readonly descriptor: ProviderCapabilityDescriptor = {
      providerId: id,
      models: ['test-model'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      maxContextTokens: 100_000,
    },
  ) {}

  describeCapabilities(): ProviderCapabilityDescriptor {
    return this.descriptor;
  }

  setResponse(response: ProviderResponse): void {
    this.response = response;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = undefined;
      throw error;
    }
    if (this.failNextCallsWith && this.failNextCallsWith.count > 0) {
      this.failNextCallsWith.count -= 1;
      throw this.failNextCallsWith.error;
    }
    return this.response;
  }

  async *completeStream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const events = this.streamEventsToYield ?? [
      { type: 'text_delta' as const, delta: this.response.text },
      { type: 'done' as const, usage: this.response.usage, finishReason: this.response.finishReason },
    ];
    for (const event of events) yield event;
  }
}
