import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { ExternalToolDispatcher, InMemoryDispatchLedger, type ExternalToolAdapter } from '@xo/adapters';
import type { CapabilityInputSchema } from '@xo/types';
import { testSubject } from '../authz-helpers.js';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../../src/capability-authority/capability-binding-registration.js';
import { createExternalToolWiring } from '../../src/capability-authority/external-tool-binding.js';

// P1.1 M6 — evidence for the claim made in external-tool-binding.ts: external dispatch happens only after the confidence gate.
// The floor is OPT-IN and host-configured (it is passed per call; see RuntimeCapabilityExecutionRequest.minConfidence). Nothing here
// adds or changes behaviour: it pins what the existing executor already does for `external_tool`, which the M1.4 tests pinned only
// for deterministic_rule and human_in_the_loop.

const CAP = 'capability:pay-out';
const SCHEMA: CapabilityInputSchema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };

const contract: SemanticCapabilityContract = {
  id: CAP,
  name: 'Pay out',
  description: 'Pays an amount through an external system',
  inputs: [],
  outputs: [],
  requiredPermissions: [],
  determinism: 'unknown',
  rules: [],
  confidence: 0.7,
  sourceRefs: [],
  sourceXoirNodeIds: [CAP],
};

function setup() {
  const calls: string[] = [];
  const adapter: ExternalToolAdapter = {
    id: 'ref',
    approvalMode: 'definition',
    invoke: async (request) => {
      calls.push(request.dispatchKey);
      return { kind: 'confirmed_success', output: { receipt: 'r1' } };
    },
  };
  const dispatcher = new ExternalToolDispatcher({
    adapters: new Map([[CAP, adapter]]),
    ledger: new InMemoryDispatchLedger(),
    unsafeAllowVolatileLedger: true,
  });
  const wiring = createExternalToolWiring(dispatcher, new Map([[CAP, SCHEMA]]));
  const resolved = resolveCapabilityBinding(contract, [wiring.resolver]);
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') throw new Error('unreachable');
  const registry = new RuntimeCapabilityRegistry();
  const registered = registerResolvedCapabilityBinding(registry, contract, resolved.binding, {
    externalToolHandler: wiring.handlerFor(contract, 'exec-1:s1'),
  });
  assert.equal(registered.ok, true);
  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  return { calls, wiring, executor };
}

test('M6 floor: a configured floor above the capability confidence denies an external_tool step before ANY dispatch (no adapter call, no evidence)', async () => {
  const { calls, wiring, executor } = setup();
  const result = await executor.execute({ capabilityId: CAP, input: { amount: 5 }, confidenceScore: 0.5, minConfidence: 0.8 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
  assert.equal(calls.length, 0, 'the adapter was never called');
  assert.equal((await wiring.evidenceFor('exec-1:s1')).length, 0, 'no write-ahead evidence was created');
});

test('M6 floor: a configured floor with NO confidence score fails closed for external_tool', async () => {
  const { calls, wiring, executor } = setup();
  const result = await executor.execute({ capabilityId: CAP, input: { amount: 5 }, minConfidence: 0.8 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
  assert.equal(calls.length, 0);
  assert.equal((await wiring.evidenceFor('exec-1:s1')).length, 0);
});

test('M6 floor: at or above the floor the step dispatches exactly once with write-ahead evidence', async () => {
  const { calls, wiring, executor } = setup();
  const result = await executor.execute({ capabilityId: CAP, input: { amount: 5 }, confidenceScore: 0.8, minConfidence: 0.8 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls, ['exec-1:s1']);
  assert.deepEqual(
    (await wiring.evidenceFor('exec-1:s1')).map((e) => e.state),
    ['dispatch_attempted', 'confirmed_success'],
  );
});

test('M6 floor: the floor is opt-in — with none configured (the API host today) an external_tool step is not gated by confidence', async () => {
  const { calls, executor } = setup();
  const result = await executor.execute({ capabilityId: CAP, input: { amount: 5 }, confidenceScore: 0.01 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
});
