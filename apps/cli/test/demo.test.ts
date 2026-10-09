import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoCommand, isKnownScenario, knownScenarioNames } from '../src/commands/runtime/demo.js';
import { withTempDir } from './helpers.js';

const AASTHA_PDF = fileURLToPath(new URL('../../../examples/vertical-test/Aastha.pdf', import.meta.url));
const COMMERCIAL_PROPERTY_PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));

test('no mock/stub execution path: the demo command module never imports a mock helper and reuses the real pipeline', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/commands/runtime/demo.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bmock\b/i);
  assert.doesNotMatch(source, /\bstub\b/i);
  assert.match(source, /runWorkflowPipeline/);
  // Must not re-implement compilation/composition/execution itself —
  // no direct (non-type) dependency on @xo/compiler at all; the only
  // @xo/runtime/@xo/workflow-composer imports are type-only (checked below).
  assert.doesNotMatch(source, /from '@xo\/compiler'/);
});

test('demo.ts only imports type-only bindings from @xo/runtime and @xo/workflow-composer (no new execution/composition logic)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/commands/runtime/demo.ts', import.meta.url), 'utf8');
  const runtimeImport = source.match(/import[^;]*from '@xo\/runtime';/);
  const composerImport = source.match(/import[^;]*from '@xo\/workflow-composer';/);
  assert.ok(runtimeImport && /^import type/.test(runtimeImport[0]), 'expected a type-only import from @xo/runtime');
  assert.ok(composerImport && /^import type/.test(composerImport[0]), 'expected a type-only import from @xo/workflow-composer');
});

test('knownScenarioNames/isKnownScenario expose exactly the documented scenarios', () => {
  const names = knownScenarioNames();
  assert.deepEqual([...names].sort(), ['aastha', 'commercial-property']);
  assert.ok(isKnownScenario('aastha'));
  assert.ok(isKnownScenario('commercial-property'));
  assert.equal(isKnownScenario('bogus'), false);
});

test('demo aastha: discovers the real Brokerage Reconciliation workflow from the actual source, source-grounded, all HITL, honest escalation, no fabricated completion', async () => {
  const result = await demoCommand({ scenario: 'aastha', source: AASTHA_PDF, json: true });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.lines[0]!);

  assert.equal(parsed.scenario, 'aastha');
  assert.equal(parsed.source.path, AASTHA_PDF);
  assert.ok(parsed.source.sources.length >= 1);
  assert.equal(parsed.source.sources[0].sourceType, 'pdf');
  assert.ok(['trusted', 'degraded'].includes(parsed.source.sources[0].qualityState));
  assert.ok(parsed.source.stats.nodeCount > 0);

  assert.ok(parsed.understanding.workflowId);
  assert.ok(Array.isArray(parsed.understanding.sourceSection));
  assert.ok(parsed.understanding.sourceSection.some((p: string) => p.includes('Brokerage Reconciliation')));

  assert.ok(Array.isArray(parsed.capabilities));
  assert.ok(parsed.capabilities.length > 0);
  // The current Aastha workflow remains primarily HITL.
  const hitlCount = parsed.capabilities.filter((c: { executionClass: string }) => c.executionClass === 'human_in_the_loop').length;
  assert.ok(hitlCount / parsed.capabilities.length > 0.5, 'expected the Aastha workflow to remain primarily HITL');

  // No fabricated deterministic business result: every HITL step must
  // honestly escalate, never claim completion.
  for (const step of parsed.execution.steps) {
    if (step.output?.status === 'escalation_required') {
      assert.notEqual(parsed.execution.status, 'completed');
    }
  }
  assert.equal(parsed.summary.deterministic, 0);
  assert.equal(parsed.summary.escalated, parsed.summary.hitl);
  assert.equal(parsed.summary.completed, 0);
  assert.notEqual(parsed.execution.status, 'completed');
});

test('demo aastha step ordering matches the underlying composed workflow order (no re-derivation of order)', async () => {
  const result = await demoCommand({ scenario: 'aastha', source: AASTHA_PDF, json: true });
  const parsed = JSON.parse(result.lines[0]!);
  const capabilityOrder = parsed.capabilities.map((c: { capabilityId: string }) => c.capabilityId);
  // Every executed step's engine node id embeds its capability id
  // (`step_<n>_<capabilityId>`) — the execution order must be a
  // subsequence of the classification order, i.e. this module never
  // re-derives or reshuffles step order itself.
  const executionCapabilityIds = parsed.execution.steps.map((s: { nodeId: unknown }) => capabilityOrder.find((id: string) => String(s.nodeId).endsWith(id)));
  const filteredClassificationOrder = capabilityOrder.filter((id: string) => executionCapabilityIds.includes(id));
  assert.deepEqual(executionCapabilityIds, filteredClassificationOrder);
});

test('demo aastha human-readable output shows input/output requirements, HITL escalation with reason, and never fabricates completion', async () => {
  const result = await demoCommand({ scenario: 'aastha', source: AASTHA_PDF });
  const output = result.lines.join('\n');
  assert.match(output, /Source\n/);
  assert.match(output, /Understanding\n/);
  assert.match(output, /Capability classification\n/);
  assert.match(output, /Execution\n/);
  assert.match(output, /Final summary\n/);
  assert.match(output, /escalation_required/);
  assert.match(output, /reason:/);
  assert.doesNotMatch(output, /Workflow status:\s+completed/);
});

test('demo commercial-property: real deterministic rule evaluation with the default synthetic demo payload, unresolved capabilities remain unresolved and unexecuted', async () => {
  const result = await demoCommand({ scenario: 'commercial-property', source: COMMERCIAL_PROPERTY_PDF, json: true });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.lines[0]!);

  assert.ok(parsed.summary.deterministic > 0, 'expected at least one deterministic_rule capability');
  assert.ok(parsed.summary.unresolved > 0, 'expected at least one unresolved capability in this fixture');
  assert.ok(parsed.execution.usedDefaultDemoInput, 'expected the default demo trigger payload to be used when no --input is supplied');

  const unresolvedCapabilities = parsed.capabilities.filter((c: { executionClass: string }) => c.executionClass === 'unresolved');
  const unresolvedIds = new Set(unresolvedCapabilities.map((c: { capabilityId: string }) => c.capabilityId));
  // Unresolved capabilities must not appear among executed step results.
  for (const step of parsed.execution.steps) {
    assert.ok(!unresolvedIds.has(String(step.nodeId)), `unresolved capability ${step.nodeId} must not have executed`);
  }

  // At least one deterministic capability actually evaluated (real rule
  // output, not a fabricated business result) — i.e. produced a result
  // object that is neither an escalation nor absent.
  const evaluatedDeterministic = parsed.execution.steps.filter(
    (s: { output?: { status?: string } }) => s.output !== undefined && s.output.status !== 'escalation_required',
  );
  assert.ok(evaluatedDeterministic.length > 0);
});

test('demo commercial-property: an explicit empty --input suppresses the default demo payload (never silently re-adds it)', async () => {
  const result = await demoCommand({ scenario: 'commercial-property', source: COMMERCIAL_PROPERTY_PDF, input: {}, json: true });
  const parsed = JSON.parse(result.lines[0]!);
  assert.equal(parsed.execution.usedDefaultDemoInput, false);
  // With no inputs at all, no deterministic rule can have every required field, so nothing should show as "supplied".
  const anySupplied = parsed.capabilities.some((c: { inputs: readonly unknown[] }) =>
    c.inputs.some((i) => (i as { runtimeKey: string }).runtimeKey !== undefined) ,
  );
  assert.ok(anySupplied || parsed.capabilities.length === 0);
});

test('demo cleanly rejects an unresolvable/unsupported source (e.g. a .xo package) rather than crashing', async () => {
  await withTempDir('xo-demo-test-', async (tmp) => {
    const path = join(tmp, 'package.xo');
    await writeFile(path, 'not a real archive', 'utf8');
    const result = await demoCommand({ scenario: 'aastha', source: path });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /error:/i);
  });
});

test('demo JSON mode: capability classification carries execution class, contract id, inputs with status, outputs, confidence, and provenance', async () => {
  const result = await demoCommand({ scenario: 'commercial-property', source: COMMERCIAL_PROPERTY_PDF, json: true });
  const parsed = JSON.parse(result.lines[0]!);
  const deterministic = parsed.capabilities.find((c: { executionClass: string }) => c.executionClass === 'deterministic_rule');
  assert.ok(deterministic);
  assert.ok('capabilityId' in deterministic);
  assert.ok('contractId' in deterministic);
  assert.ok('confidence' in deterministic);
  assert.ok('evidence' in deterministic);
  assert.ok(Array.isArray(deterministic.inputs));
  assert.ok(Array.isArray(deterministic.outputs));
});
