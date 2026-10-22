import { test } from 'node:test';
import assert from 'node:assert/strict';
import { establishAuthenticatedPrincipal, PermissionManager, Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { toJson, XoirNodeId } from '@xo/xoir';
import type { CapabilityInputSchema } from '@xo/types';
import { ExternalToolDispatcher, InMemoryDispatchLedger } from '@xo/adapters';
import { ScriptedExternalAdapter } from '@xo/testing';
import { createExternalToolWiring } from '@xo/runtime';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph } from './workflow-fixtures.js';
import { executeApprovedCapability } from '../src/executions/execute-capability.js';
import { createReferenceAdapter, ReferenceService } from '../../../examples/external-tool-reference/reference-service.js';

// P1.1 M4 -- external_tool binding at the capability-authority layer, exercised at the real dispatch point
// (`executeApprovedCapability` -> `resolveContractBinding` / `executeResolvedContract` -> `RuntimeCapabilityExecutor`).
// FIXTURE: the hand-built P0.8 graph plus two capabilities with NO rule/action evidence (so no standard resolver binds them).
// Adapters are deterministic local doubles; there is no network, clock, credential or real side effect anywhere.
// NOT covered here: authoring/approving a procedure that CONTAINS an external_tool step (blocked by M2 registry validation; see
// P11_M4_O7_CORE_IMPLEMENTATION_STATUS.md), so the procedure runner's external path is not exercised end to end.

const EXT_FREE = 'cap_m4_ext_free';
const EXT_PERM = 'cap_m4_ext_perm';
const SCHEMA: CapabilityInputSchema = {
  type: 'object',
  properties: { amount: { type: 'number' }, scenario: { type: 'string' } },
  required: ['amount'],
};
const FILE = Permissions.filesystem.read;

function graphJson(): ReturnType<typeof toJson> {
  const g = buildFixtureGraph();
  for (const [id, perms] of [
    [EXT_FREE, []],
    [EXT_PERM, ['filesystem.read']],
  ] as const) {
    const added = g.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name: id, description: 'external tool capability (declared only)', requiredPermissions: [...perms] },
      confidence: 0.9,
      sourceRefs: [{ documentPath: 'p08-fixture.pdf', pages: [1] }],
    });
    assert.ok(added.ok, 'fixture node added');
  }
  return toJson(g);
}
const principal = (id = 'alice') => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id });
  if (!r.ok) throw r.error;
  return r.value;
};
const authz = (rules: readonly PolicyRule[] = [], id = 'alice') => ({
  subject: principal(id),
  permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([...rules]) }),
});
const grant = (id = 'alice'): PolicyRule => ({ id: `g-${id}`, effect: 'ALLOW', match: { permission: FILE, principalId: id } });

function setup(
  adapter: ScriptedExternalAdapter | ReturnType<typeof createReferenceAdapter>,
  capIds: readonly string[] = [EXT_FREE, EXT_PERM],
) {
  const ledger = new InMemoryDispatchLedger();
  const dispatcher = new ExternalToolDispatcher({ adapters: new Map(capIds.map((c) => [c, adapter])), ledger });
  const externalTools = createExternalToolWiring(dispatcher, new Map(capIds.map((c) => [c, SCHEMA])));
  return { ledger, externalTools };
}

test('M4: a declared external_tool alone confers nothing — without explicit wiring the capability is unresolved and the adapter is never called', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: 1 } }]);
  const out = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), {});
  assert.equal(out.kind, 'unresolved');
  // wiring present but this id is NOT configured on the dispatcher: still unresolved, still no call
  const { externalTools } = setup(adapter, [EXT_PERM]);
  const other = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'k' });
  assert.equal(other.kind, 'unresolved');
  assert.equal(adapter.calls.length, 0);
});

test('M4: configured + authorized + valid input => one dispatch, confirmed success, evidence recorded, server-derived key forwarded', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: { receipt: 'r1' } } }]);
  const { ledger, externalTools } = setup(adapter);
  const out = await executeApprovedCapability(graphJson(), EXT_PERM, { amount: 5 }, authz([grant()]), {
    externalTools,
    dispatchKey: 'pex1:s1',
  });
  assert.equal(out.kind, 'succeeded');
  if (out.kind === 'succeeded') {
    assert.deepEqual(out.output, { receipt: 'r1' });
    assert.match(out.bindingId ?? '', /^external_tool:a:/);
  }
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0]!.dispatchKey, 'pex1:s1');
  assert.deepEqual(
    ledger.all().map((e) => e.state),
    ['dispatch_attempted', 'confirmed_success'],
  );
});

test('M4: authorization precedes dispatch — a denied principal causes zero adapter calls and zero evidence', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: 1 } }]);
  const { ledger, externalTools } = setup(adapter);
  const noGrant = await executeApprovedCapability(graphJson(), EXT_PERM, { amount: 5 }, authz([]), { externalTools, dispatchKey: 'k' });
  assert.equal(noGrant.kind, 'error');
  if (noGrant.kind === 'error') assert.equal(noGrant.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
  const wrongPrincipal = await executeApprovedCapability(graphJson(), EXT_PERM, { amount: 5 }, authz([grant('alice')], 'mallory'), {
    externalTools,
    dispatchKey: 'k',
  });
  assert.equal(wrongPrincipal.kind, 'error');
  assert.equal(adapter.calls.length, 0);
  assert.equal(ledger.all().length, 0);
});

test('M4: input validation precedes dispatch — missing, mistyped and unknown properties are rejected with zero adapter calls', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: 1 } }]);
  const { ledger, externalTools } = setup(adapter);
  for (const bad of [{}, { amount: '5' }, { amount: 5, extra: true }, { amount: 5, scenario: 7 }]) {
    const out = await executeApprovedCapability(graphJson(), EXT_FREE, bad, authz(), {
      externalTools,
      dispatchKey: `k-${JSON.stringify(bad)}`,
    });
    assert.equal(out.kind, 'error', JSON.stringify(bad));
    if (out.kind === 'error') {
      assert.equal(out.errorCode, 'XO_RUNTIME_CAPABILITY_INPUT_INVALID');
      assert.equal(out.effectState, 'not_dispatched');
    }
  }
  assert.equal(adapter.calls.length, 0);
  assert.equal(ledger.all().length, 0);
});

test('M4: no dispatch key, or no wiring for a bound external contract, is refused before anything runs', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: 1 } }]);
  const { externalTools } = setup(adapter);
  const noKey = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools });
  assert.equal(noKey.kind, 'error');
  const emptyKey = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: '' });
  assert.equal(emptyKey.kind, 'error');
  assert.equal(adapter.calls.length, 0);
});

test('M4: a configured contract that the standard resolvers also bind is a configuration conflict and fails closed (no silent override)', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ returns: { kind: 'confirmed_success', output: 1 } }]);
  const { externalTools } = setup(adapter, [IDS.flowA]);
  const out = await executeApprovedCapability(graphJson(), IDS.flowA, { claim_amount: 20000 }, authz(), {
    externalTools,
    dispatchKey: 'k',
  });
  assert.equal(out.kind, 'unresolved');
  if (out.kind === 'unresolved') assert.equal(out.status, 'ambiguous');
  assert.equal(adapter.calls.length, 0);
});

test('M4: a configured adapter without an input schema never binds (fail closed)', async () => {
  const adapter = new ScriptedExternalAdapter('a');
  const dispatcher = new ExternalToolDispatcher({ adapters: new Map([[EXT_FREE, adapter]]), ledger: new InMemoryDispatchLedger() });
  const externalTools = createExternalToolWiring(dispatcher, new Map());
  const out = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'k' });
  assert.equal(out.kind, 'unresolved');
  assert.equal(adapter.calls.length, 0);
});

test('M4: confirmed failure with no effect is distinguishable from success and from unknown', async () => {
  const adapter = new ScriptedExternalAdapter('a', [
    { returns: { kind: 'confirmed_failure_no_effect', code: 'DENIED', message: 'declined' } },
  ]);
  const { externalTools } = setup(adapter);
  const out = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'k' });
  assert.equal(out.kind, 'error');
  if (out.kind === 'error') {
    assert.equal(out.effectState, 'confirmed_failure_no_effect');
    assert.equal(out.reconciliationRequired, false);
  }
});

test('M4: an ambiguous outcome is NEVER success: throw / reject / malformed / reported unknown all surface outcome_unknown with reconciliation required, one call each', async () => {
  const steps = [
    { throws: 'socket hang up' },
    { rejects: 'ECONNRESET' },
    { returnsRaw: { kind: 'confirmed_success' } },
    { returns: { kind: 'outcome_unknown', reason: 'timeout' } },
  ] as const;
  for (const step of steps) {
    const adapter = new ScriptedExternalAdapter('a', [step]);
    const { externalTools } = setup(adapter);
    const out = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'k' });
    assert.notEqual(out.kind, 'succeeded', JSON.stringify(step));
    assert.equal(out.kind, 'error');
    if (out.kind === 'error') {
      assert.equal(out.effectState, 'outcome_unknown');
      assert.equal(out.reconciliationRequired, true);
      assert.match(out.errorMessage, /reconciliation is required/);
    }
    assert.equal(adapter.calls.length, 1, 'no automatic retry');
  }
});

test('M4: after an unknown outcome the same dispatch key can never be dispatched again (reconciliation required); a new key is independent', async () => {
  const adapter = new ScriptedExternalAdapter('a', [{ throws: 'reset' }, { returns: { kind: 'confirmed_success', output: 2 } }]);
  const { externalTools } = setup(adapter);
  const first = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'pex:s' });
  assert.equal(first.kind === 'error' && first.effectState, 'outcome_unknown');
  const again = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 1 }, authz(), { externalTools, dispatchKey: 'pex:s' });
  assert.equal(again.kind, 'error');
  if (again.kind === 'error') {
    assert.equal(again.effectState, 'not_dispatched');
    assert.equal(again.reconciliationRequired, true);
  }
  assert.equal(adapter.calls.length, 1);
});

test('M4: reference service — a dropped connection after the effect applied is reported unknown (not success), and no second effect is ever produced', async () => {
  const service = new ReferenceService();
  const { externalTools } = setup(createReferenceAdapter(service));
  const ok = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'accept' }, authz(), {
    externalTools,
    dispatchKey: 'a:1',
  });
  assert.equal(ok.kind, 'succeeded');
  const rejected = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'reject' }, authz(), {
    externalTools,
    dispatchKey: 'a:2',
  });
  assert.equal(rejected.kind === 'error' && rejected.effectState, 'confirmed_failure_no_effect');
  const dropped = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'drop' }, authz(), {
    externalTools,
    dispatchKey: 'a:3',
  });
  assert.equal(dropped.kind === 'error' && dropped.effectState, 'outcome_unknown');
  // retry the dropped dispatch under the same key: refused, so the (already applied) effect is not duplicated
  const retry = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'drop' }, authz(), {
    externalTools,
    dispatchKey: 'a:3',
  });
  assert.equal(retry.kind === 'error' && retry.effectState, 'not_dispatched');
  assert.deepEqual(
    service.effects.map((e) => e.dispatchKey),
    ['a:1', 'a:3'],
  );
  // a garbled reply (effect applied, reply unparseable) is unknown too, and the earlier unreconciled drop blocks any further dispatch here
  const blockedByDrop = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'garbled' }, authz(), {
    externalTools,
    dispatchKey: 'a:4',
  });
  assert.equal(blockedByDrop.kind === 'error' && blockedByDrop.effectState, 'not_dispatched');
  assert.equal(blockedByDrop.kind === 'error' && blockedByDrop.reconciliationRequired, true);
  const fresh = setup(createReferenceAdapter(service));
  const garbled = await executeApprovedCapability(graphJson(), EXT_FREE, { amount: 10, scenario: 'garbled' }, authz(), {
    externalTools: fresh.externalTools,
    dispatchKey: 'g:1',
  });
  assert.equal(garbled.kind === 'error' && garbled.effectState, 'outcome_unknown');
});

test('M4: existing deterministic path is unchanged by the wiring (a non-configured capability still executes through the standard binding)', async () => {
  const adapter = new ScriptedExternalAdapter('a');
  const { externalTools } = setup(adapter);
  const out = await executeApprovedCapability(graphJson(), IDS.perm, { file_size: 50 }, authz([grant()]), {
    externalTools,
    dispatchKey: 'k',
  });
  assert.equal(out.kind, 'succeeded');
  assert.equal(adapter.calls.length, 0);
});
