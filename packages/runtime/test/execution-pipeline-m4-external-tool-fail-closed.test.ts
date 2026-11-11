import { test } from 'node:test';
import { allowAllPermissionGate } from './authz-helpers.js';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration } from '@xo/types';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { ExecutionStrategyRouter } from '../src/execution/execution-strategy-router.js';
import { withTempInstaller, buildContractLawyerBundle, fakeMountedPackage, ScriptedModelProvider } from './fixtures.js';

/**
 * M4 (O-7) deterministic regression for the fail-open fall-through:
 * once `'external_tool'` is a registered strategy, ExecutionPipeline.prepare()
 * must not fall through to the AI-model path. Before the dedicated branch,
 * widening the union + registering the strategy made an external_tool
 * capability complete via the model provider (1 provider request).
 */

const externalToolCapability: CapabilityDeclaration = {
  id: 'contract_analysis',
  name: 'Contract Analysis',
  description: 'Analyzes a contract.',
  providerCompatibility: ['claude'],
  requiredComponents: [],
  estimatedCost: { currency: 'USD', amount: 0 },
  estimatedLatencyMs: 5,
  confidence: { score: 0.9, basis: 'expert_review' },
  execution: { mode: 'external_tool' },
};

function request(simulate?: boolean): ExecutionRequest {
  return {
    requestId: RequestId('req_m4_ext_1'),
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
    ...(simulate === undefined ? {} : { simulate }),
  };
}

test('M4/O-7: router registers external_tool and still lists the existing four first, in order', () => {
  const router = new ExecutionStrategyRouter();
  const r = router.resolve('external_tool');
  assert.equal(r.ok && r.value, 'external_tool');
  for (const m of ['deterministic_rule', 'model', 'hybrid', 'human_in_the_loop'] as const) {
    assert.equal(router.resolve(m).ok, true);
  }
  const bad = router.resolve('future_strategy' as never);
  assert.equal(bad.ok, false);
  const msg = !bad.ok ? bad.error.message : '';
  assert.match(msg, /known: deterministic_rule, model, hybrid, human_in_the_loop, external_tool\)/);
});

for (const simulate of [undefined, true]) {
  test(`M4/O-7: external_tool never falls through to the model path (simulate=${String(simulate)}): fails closed, zero provider requests, no retries`, async () => {
    await withTempInstaller(async (installer) => {
      const bundle = buildContractLawyerBundle({ capabilities: [externalToolCapability] });
      const registry = PackageRegistry.empty().withMounted(fakeMountedPackage(bundle));
      const provider = new ScriptedModelProvider();
      const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
        permissionGate: allowAllPermissionGate,
      });

      const result = await engine.execute(request(simulate));

      assert.equal(result.error?.code, 'XO_RUNTIME_UNSUPPORTED_EXECUTION_MODE');
      assert.equal(result.session.status, 'failed');
      assert.equal(provider.requests.length, 0, 'external_tool must never reach the AI Capability Layer');
    });
  });
}
