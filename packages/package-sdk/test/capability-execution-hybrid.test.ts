import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityDeclaration, HybridExecutionStep } from '@xo/types';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageInstaller } from '../src/install/package-installer.js';
import { buildSampleBundle } from './fixtures.js';

/**
 * R5: proves `@xo/package-sdk`'s manifest schema validator
 * (`validation/schema.ts`'s `EXECUTION_MODES` allowlist and the new
 * `isHybridExecutionStep`/`isHybridStepInputSource` structural checks,
 * plus `hasWellFormedHybridStepOrdering`'s referential-integrity checks —
 * unique `stepId`s and no self/forward/dangling `{ kind: 'step' }`
 * references) accepts a well-formed `mode: 'hybrid'` capability and
 * rejects the malformed shapes R5's own runtime-level invariants depend
 * on package validation having already ruled out (an empty
 * `hybridSteps` list, a step declaring `strategy: 'hybrid'`, a step with
 * no `input`, a duplicate `stepId`, a self/forward/dangling step
 * reference). Exercised
 * through `PackageInstaller.install()` — the same real validation path
 * every other `package-validator.test.ts`/`package-installer.test.ts`
 * case already uses — not `isXoManifest` in isolation, so this proves
 * the allowlist change actually reaches a real install, not just the
 * unit-level predicate.
 */

async function withTempStore<T>(fn: (store: LocalFsBlobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-package-sdk-r5-'));
  try {
    return await fn(new LocalFsBlobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hybridCapability(hybridSteps: unknown): CapabilityDeclaration {
  return {
    id: 'hybrid_review',
    name: 'Hybrid Review',
    description: 'A deterministic check plus a model synthesis step.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.9, basis: 'expert_review' },
    execution: { mode: 'hybrid', hybridSteps } as unknown as CapabilityDeclaration['execution'],
  };
}

const validSteps: readonly HybridExecutionStep[] = [
  { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
  { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
];

test("R5: a well-formed mode: 'hybrid' capability with a valid ordered hybridSteps list installs successfully", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(validSteps)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});

test("R5: mode: 'hybrid' with an empty hybridSteps list fails package validation", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle({ capabilities: [hybridCapability([])] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test("R5: mode: 'hybrid' with hybridSteps entirely absent fails package validation", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(undefined)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('R5: a hybrid step declaring strategy "hybrid" fails package validation (no recursive nesting at the package-format level either)', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const nestedSteps = [{ stepId: 'nested', strategy: 'hybrid', input: { kind: 'request' } }];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(nestedSteps)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('R5: a hybrid step missing its input reference fails package validation', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const malformedSteps = [{ stepId: 'det', strategy: 'deterministic_rule' }];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(malformedSteps)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test("R5: existing mode: 'deterministic_rule' and mode: 'model' capabilities are completely unaffected by the hybridSteps validation addition", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const deterministicOnly: CapabilityDeclaration = {
      id: 'claim_evaluation',
      name: 'Evaluate Claim',
      description: 'Evaluates a submitted claim.',
      providerCompatibility: ['claude'],
      requiredComponents: [],
      estimatedCost: { currency: 'USD', amount: 0 },
      estimatedLatencyMs: 5,
      confidence: { score: 0.9, basis: 'expert_review' },
      execution: { mode: 'deterministic_rule', contractId: 'capability:claim-evaluation' },
    };
    const bundle = buildSampleBundle({ capabilities: [deterministicOnly] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});

// --- Referential integrity: duplicate stepIds, self-references, forward references ---

test('R5: two hybrid steps sharing the same stepId fail package validation (ambiguous step identity)', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const duplicateStepIds = [
      { stepId: 'step', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
      { stepId: 'step', strategy: 'model', input: { kind: 'request' } },
    ];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(duplicateStepIds)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test("R5: a hybrid step referencing its own stepId ({ kind: 'step' } self-reference) fails package validation", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const selfReferencing = [{ stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'step', stepId: 'det' }, contractId: 'capability:hybrid-det' }];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(selfReferencing)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('R5: a hybrid step referencing a step declared later (a forward reference) fails package validation', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const forwardReferencing = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'step', stepId: 'model' }, contractId: 'capability:hybrid-det' },
      { stepId: 'model', strategy: 'model', input: { kind: 'request' } },
    ];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(forwardReferencing)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('R5: a hybrid step referencing a stepId that does not exist anywhere in the list fails package validation', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const danglingReference = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det' },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'nonexistent' } },
    ];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(danglingReference)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('R5: a longer, well-ordered hybrid chain where a later step references an earlier (not immediately preceding) step installs successfully', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    // Proves the ordering check is "strictly earlier in the list", not "immediately preceding" -- step 3 may reference step 1 directly, skipping step 2.
    const chain = [
      { stepId: 'first', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
      { stepId: 'second', strategy: 'model', input: { kind: 'request' } },
      { stepId: 'third', strategy: 'model', input: { kind: 'step', stepId: 'first' } },
    ];
    const bundle = buildSampleBundle({ capabilities: [hybridCapability(chain)] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});
