import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityDeclaration } from '@xo/types';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageInstaller } from '../src/install/package-installer.js';
import { buildSampleBundle } from './fixtures.js';

/**
 * Human-in-the-Loop Execution Class Lowering milestone: proves
 * `@xo/package-sdk`'s manifest schema validator
 * (`validation/schema.ts`'s `EXECUTION_MODES` allowlist) accepts a
 * well-formed `mode: 'human_in_the_loop'` capability declaration.
 * Exercised through `PackageInstaller.install()` — the same real
 * validation path `capability-execution-hybrid.test.ts` (R5) already
 * uses for `'hybrid'` — because this is exactly the gap that caused a
 * `human_in_the_loop`-mode manifest to fail package installation before
 * this milestone (`EXECUTION_MODES` did not recognize the value at all),
 * even after `capability-lowering.ts` started producing one.
 */

async function withTempStore<T>(fn: (store: LocalFsBlobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-package-sdk-hitl-'));
  try {
    return await fn(new LocalFsBlobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function humanInTheLoopCapability(): CapabilityDeclaration {
  return {
    id: 'reconcile_invoice',
    name: 'Reconcile the invoice balance',
    description: 'Reconciles the outstanding invoice balance against recorded payments.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 0,
    confidence: { score: 0.72, basis: 'self_reported' },
    execution: { mode: 'human_in_the_loop', contractId: 'capability:reconcile-invoice-balance', bindingId: 'binding_capability:reconcile-invoice-balance_action-escalation-resolver' },
  };
}

test("HITL: a well-formed mode: 'human_in_the_loop' capability installs successfully", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle({ capabilities: [humanInTheLoopCapability()] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});

test("HITL: mode: 'human_in_the_loop' with no inputSchema is valid (never required for this mode, unlike deterministic_rule's optional-but-common one)", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const capability: CapabilityDeclaration = { ...humanInTheLoopCapability(), execution: { mode: 'human_in_the_loop', contractId: 'capability:reconcile-invoice-balance' } };
    const bundle = buildSampleBundle({ capabilities: [capability] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});

test("HITL: mode: 'hybrid' and mode: 'deterministic_rule' validation is completely unaffected by the new allowlist entry", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const deterministic: CapabilityDeclaration = {
      id: 'clause_lookup_det',
      name: 'Clause Lookup',
      description: 'd',
      providerCompatibility: ['claude'],
      requiredComponents: [],
      estimatedCost: { currency: 'USD', amount: 0 },
      estimatedLatencyMs: 0,
      confidence: { score: 0.8, basis: 'self_reported' },
      execution: { mode: 'deterministic_rule', contractId: 'capability:clause-lookup' },
    };
    const bundle = buildSampleBundle({ capabilities: [deterministic] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
  });
});

test("HITL: an unrecognized execution mode string still fails package validation -- the allowlist is still closed, not opened to arbitrary strings", async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const capability = { ...humanInTheLoopCapability(), execution: { mode: 'not_a_real_mode' } } as unknown as CapabilityDeclaration;
    const bundle = buildSampleBundle({ capabilities: [capability] });
    const result = await installer.install(bundle);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});
