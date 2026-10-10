import { test } from 'node:test';
import { allowAllPermissionGate } from './authz-helpers.js';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration, CapabilityExecutionMode } from '@xo/types';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { withTempInstaller, buildContractLawyerBundle, fakeMountedPackage, ScriptedModelProvider } from './fixtures.js';

/**
 * R4/R5 integration closure: proves `ExecutionPipeline` fails closed on a
 * capability declaring an `execution.mode` outside the strategies
 * `ExecutionStrategyRouter` has registered (`'deterministic_rule'`,
 * `'model'`, and — as of R5 — `'hybrid'`) — the runtime-reachable
 * counterpart to `execution-strategy-router.test.ts`'s unit-level proof.
 * `CapabilityExecutionMode` itself stays a closed union; the unrecognized
 * mode used here (`'future_strategy'`) is reached only via a deliberate
 * type cast, simulating a future compiler emitting a wider mode value
 * than this runtime binary knows about.
 *
 * Mounts via `fakeMountedPackage` directly into a `PackageRegistry`
 * rather than through `PackageInstaller.install()`/`PackageLoader.mount`:
 * `@xo/package-sdk`'s own manifest schema validator
 * (`validation/schema.ts`'s `EXECUTION_MODES` allowlist) already rejects
 * an unrecognized `execution.mode` at install time, so a real `.xo`
 * package can never carry one this far in the first place — that's a
 * real, independent defense-in-depth layer, not a gap this test needs to
 * paper over. This test instead proves the router's own fail-closed
 * behavior for the case package-sdk validation doesn't fully foreclose:
 * a `MountedPackage` constructed directly (e.g. by a future host/loader
 * path that doesn't route through today's validator).
 */

const unsupportedModeCapability: CapabilityDeclaration = {
  id: 'contract_analysis',
  name: 'Contract Analysis',
  description: 'Analyzes a contract.',
  providerCompatibility: ['claude'],
  requiredComponents: [],
  estimatedCost: { currency: 'USD', amount: 0 },
  estimatedLatencyMs: 5,
  confidence: { score: 0.9, basis: 'expert_review' },
  execution: {
    mode: 'future_strategy' as unknown as CapabilityExecutionMode,
  },
};

function unsupportedModeRequest(): ExecutionRequest {
  return {
    requestId: RequestId('req_unsupported_mode_1'),
    capabilityId: 'contract_analysis',
    input: 'analyze this contract',
    environment: {
      environmentId: EnvironmentId('env_1'),
      hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
      provider: 'anthropic',
      tokenBudget: 8000,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('R4: an unsupported execution.mode fails closed with RUNTIME_UNSUPPORTED_EXECUTION_MODE, calling neither the AI Capability Layer nor the capability authority executor', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [unsupportedModeCapability] });
    // Deliberately not installed/mounted through PackageInstaller/PackageLoader
    // (see the file-level doc comment above) — mounted directly so the
    // manifest schema validator's EXECUTION_MODES allowlist never gets a
    // chance to reject it first.
    const registry = PackageRegistry.empty().withMounted(fakeMountedPackage(bundle));
    const provider = new ScriptedModelProvider();

    // Deliberately no `capabilityAuthorityExecutor` configured. If the
    // unsupported-mode capability were (incorrectly) routed to the
    // deterministic path, the result would be
    // `RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED` instead of the router's
    // own code — so asserting the exact code below also proves the
    // deterministic path was never reached, without needing a spy on
    // `RuntimeCapabilityExecutor`.
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });

    const result = await engine.execute(unsupportedModeRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_UNSUPPORTED_EXECUTION_MODE');
    assert.equal(result.session.status, 'failed');
    assert.equal(provider.requests.length, 0, 'the AI Capability Layer must never be called for an unsupported execution mode');
  });
});
