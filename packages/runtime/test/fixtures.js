import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { ManifestBuilder, PackageInstaller } from '@xo/package-sdk';
export const contractCompatibility = {
    modelFamilies: [
        { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'decision_trees', 'safety_rules'] },
        { family: 'gpt', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'safety_rules'] },
    ],
    fallbackPolicy: 'degrade_gracefully',
};
export const strictCompatibility = {
    modelFamilies: [{ family: 'claude', minCapability: ['chat', 'tool_use', 'long_context'], consumes: ['decision_trees', 'safety_rules'] }],
    fallbackPolicy: 'reject',
};
export const sampleMetadata = {
    domain: 'legal',
    description: 'Corporate contract review',
    scope: ['contract_review'],
    limitations: ['Not a substitute for a licensed attorney'],
};
export const contractAnalysisCapability = {
    id: 'contract_analysis',
    name: 'Contract Analysis',
    description: 'Reviews corporate contracts for risk and missing clauses.',
    providerCompatibility: ['claude', 'gpt'],
    requiredComponents: ['knowledge_graph', 'safety_rules'],
    estimatedCost: { currency: 'USD', amount: 0.01 },
    estimatedLatencyMs: 1500,
    confidence: { score: 0.8, basis: 'expert_review' },
};
export const clauseLookupCapability = {
    id: 'clause_lookup',
    name: 'Clause Lookup',
    description: 'Looks up individual clause types quickly.',
    providerCompatibility: ['claude'],
    requiredComponents: ['knowledge_graph'],
    estimatedCost: { currency: 'USD', amount: 0.002 },
    estimatedLatencyMs: 400,
    confidence: { score: 0.6, basis: 'self_reported' },
};
export const fraudDetectionCapability = {
    id: 'fraud_detection',
    name: 'Fraud Detection',
    description: 'Flags anomalous transactions for review.',
    providerCompatibility: ['claude'],
    requiredComponents: ['decision_trees', 'safety_rules'],
    estimatedCost: { currency: 'USD', amount: 0.02 },
    estimatedLatencyMs: 2200,
    confidence: { score: 0.5, basis: 'benchmark' },
};
export class FixedClock {
    current;
    constructor(current = new Date('2026-01-01T00:00:00.000Z')) {
        this.current = current;
    }
    now() {
        return this.current;
    }
    advance(ms) {
        this.current = new Date(this.current.getTime() + ms);
    }
}
export const sampleSafetyRules = {
    rules: [
        { pattern: 'ignore (all|previous) instructions', action: 'block', reason: 'prompt injection attempt' },
        { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'redact', reason: 'PII' },
    ],
};
export function buildContractLawyerBundle(options = {}) {
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
    if (!result.ok)
        throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
    return result.value;
}
export function buildFraudDetectorBundle(options = {}) {
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
    if (!result.ok)
        throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
    return result.value;
}
export async function withTempInstaller(fn, clock) {
    const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-'));
    try {
        const store = new LocalFsBlobStore(dir);
        const installer = new PackageInstaller(store, clock ? { clock } : {});
        return await fn(installer, store);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
// --- Stage 2 fixtures ----------------------------------------------
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { PackageLoader } from '../src/loader/package-loader.js';
import { MountId } from '../src/ids.js';
/** Mounts `bundle` (already installed on `installer`) into a fresh `PackageRegistry`, for tests that don't need the full `PackageLoader` verification path exercised. */
export async function mountBundle(installer, bundle, registry = PackageRegistry.empty()) {
    const loader = new PackageLoader(installer);
    const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, registry);
    if (!result.ok)
        throw new Error(`Fixture mount failed: ${result.error.message}`);
    return result.value;
}
export function fakeMountedPackage(bundle) {
    return Object.freeze({
        mountId: MountId(`${bundle.manifest.name}@${bundle.manifest.version}#0`),
        name: bundle.manifest.name,
        version: bundle.manifest.version,
        manifest: bundle.manifest,
        capabilities: (bundle.manifest.capabilities ?? []).map((declaration) => ({ declaration, packageName: bundle.manifest.name, packageVersion: bundle.manifest.version })),
        mountedAt: '2026-01-01T00:00:00.000Z',
        manifestHash: 'sha256:fake',
    });
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
export class ScriptedModelProvider {
    id;
    response;
    descriptor;
    requests = [];
    failNextWith;
    streamEventsToYield;
    /** When set, `complete()` waits this long before resolving — for tests that need to race cancellation against an in-flight call. */
    delayMs = 0;
    constructor(id = 'anthropic', response = { text: 'default response', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' }, descriptor = {
        providerId: id,
        models: ['test-model'],
        supportsStreaming: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        maxContextTokens: 100_000,
    }) {
        this.id = id;
        this.response = response;
        this.descriptor = descriptor;
    }
    describeCapabilities() {
        return this.descriptor;
    }
    setResponse(response) {
        this.response = response;
    }
    async complete(request) {
        this.requests.push(request);
        if (this.delayMs > 0)
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (this.failNextWith) {
            const error = this.failNextWith;
            this.failNextWith = undefined;
            throw error;
        }
        return this.response;
    }
    async *completeStream(request) {
        this.requests.push(request);
        const events = this.streamEventsToYield ?? [
            { type: 'text_delta', delta: this.response.text },
            { type: 'done', usage: this.response.usage, finishReason: this.response.finishReason },
        ];
        for (const event of events)
            yield event;
    }
}
//# sourceMappingURL=fixtures.js.map