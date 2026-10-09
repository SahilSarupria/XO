import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowCommand } from '../src/commands/runtime/workflow.js';
import { withTempDir } from './helpers.js';

const OBLIGATION_TEXT =
  '# Vendor Agreement\n\n' +
  'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n\n' +
  'The team shall generate a summary report weekly and deliver it to the Client.\n' +
  'The team shall notify the Client of any delay within 24 hours.\n';

const OPERATION_FIXTURE = [
  { type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' }, rate: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } },
  { type: 'operation', name: 'record_brokerage', requires: ['calculate_brokerage'], inputs: { brokerage: { type: 'number' } }, outputs: {} },
];

test('no mock/stub execution path: the command module never imports a mock helper', async () => {
  const source = await readFile(new URL('../src/commands/runtime/workflow.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bmock\b/i);
  assert.doesNotMatch(source, /\bstub\b/i);
  // `workflow.ts` itself is now a thin presentation layer over the shared
  // `runWorkflowPipeline` (see `workflow-pipeline.ts`) — `xo demo` reuses
  // the exact same pipeline, so the compile/compose/execute calls live in
  // exactly one place instead of being duplicated across both commands.
  assert.match(source, /runWorkflowPipeline/);
  const pipelineSource = await readFile(new URL('../src/commands/runtime/workflow-pipeline.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(pipelineSource, /\bmock\b/i);
  assert.doesNotMatch(pipelineSource, /\bstub\b/i);
  // Every execution primitive must come from the real, existing packages — not a bespoke reimplementation.
  assert.match(pipelineSource, /from '@xo\/runtime'/);
  assert.match(pipelineSource, /from '@xo\/workflow-composer'/);
  assert.match(pipelineSource, /WorkflowExecutor/);
  assert.match(pipelineSource, /RuntimeCapabilityExecutor/);
});

test('workflow discovers a real HITL-only workflow from plain text and never reports it as completed', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');

    const result = await workflowCommand({ source: path, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);

    assert.ok(parsed.workflow.id);
    assert.ok(Array.isArray(parsed.steps));
    assert.ok(parsed.dataFlow);
    assert.ok(Array.isArray(parsed.dataFlow.bindings));
    assert.ok(Array.isArray(parsed.dataFlow.unboundInputs));
    // Whatever the actual status, it must be one of the honest, defined values — never a bespoke ad hoc string.
    assert.ok(['completed', 'waiting_for_human', 'not_executable_yet', 'failed'].includes(parsed.execution.status));
    // If any step actually escalated, its output must say so honestly.
    for (const step of parsed.execution.steps) {
      if (step.output?.status === 'escalation_required') {
        assert.notEqual(parsed.execution.status, 'completed');
      }
    }
  });
});

test('workflow human-readable output never describes a HITL escalation as a completed business action', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');
    const result = await workflowCommand({ source: path });
    const output = result.lines.join('\n');
    if (output.includes('escalation_required')) {
      assert.doesNotMatch(output, /Workflow status:\s+completed/);
    }
  });
});

test('workflow reports a real proven data-flow binding for the structured-operation fixture, with honest unresolved execution (no fabricated deterministic run)', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');

    const result = await workflowCommand({ source: path, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);

    const proven = parsed.dataFlow.bindings.filter((b: { status: string }) => b.status === 'proven');
    assert.equal(proven.length, 1);
    assert.equal(proven[0].outputParameterName, 'brokerage');
    assert.equal(proven[0].inputParameterName, 'brokerage');

    // No real resolver can execute bare arithmetic declared only in JSON —
    // both steps must be honestly unresolved, never fabricated as executed.
    for (const step of parsed.steps) assert.equal(step.status, 'unbound');
    assert.equal(parsed.execution.status, 'not_executable_yet');
  });
});

test('--workflow-index selects deterministically and reports the exact rationale', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');
    const result = await workflowCommand({ source: path, workflowIndex: 0, json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.match(parsed.selection.rationale, /--workflow-index 0/);
  });
});

test('an unknown --workflow-id fails clearly rather than silently falling back', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');
    const result = await workflowCommand({ source: path, workflowId: 'wf_does_not_exist' });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /no discovered workflow has id/);
  });
});

test('a nonexistent source path fails with a read error, not a crash', async () => {
  const result = await workflowCommand({ source: '/nonexistent/path/does-not-exist.json' });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /could not read/);
});

test('a source with no discoverable capabilities/workflows fails clearly', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'empty.txt');
    await writeFile(path, 'The sky is blue.', 'utf8');
    const result = await workflowCommand({ source: path });
    assert.equal(result.exitCode, 1);
  });
});

test('each step reports its declared inputs/outputs with name, runtime key, type, derivedFrom, and status (injected/supplied/missing)', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');

    const withoutInput = await workflowCommand({ source: path, json: true });
    const parsedNoInput = JSON.parse(withoutInput.lines[0]!);
    const producerNoInput = parsedNoInput.steps.find((s: { capabilityName: string }) => s.capabilityName === 'calculate_brokerage');
    assert.equal(producerNoInput.inputs.length, 2);
    for (const p of producerNoInput.inputs) {
      assert.equal(p.runtimeKey, p.name); // single-word declared names normalize to themselves
      assert.equal(p.derivedFrom, 'declared');
      assert.equal(p.status, 'missing');
    }
    assert.equal(producerNoInput.outputs[0].name, 'brokerage');

    const withInput = await workflowCommand({ source: path, input: { premium: 100000, rate: 0.1 }, json: true });
    const parsedWithInput = JSON.parse(withInput.lines[0]!);
    const producerWithInput = parsedWithInput.steps.find((s: { capabilityName: string }) => s.capabilityName === 'calculate_brokerage');
    for (const p of producerWithInput.inputs) assert.equal(p.status, 'supplied');
  });
});

test('a declared input name that differs from its runtime key (e.g. a multi-word rule-derived phrase) reports both, so a --input value must match the runtime key to count as supplied', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    // A multi-word declared name normalizes to a different runtime key
    // (spaces/stopwords stripped) — reported explicitly so a user knows
    // exactly which key --input must use, not the literal declared name.
    const path = join(tmp, 'operations.json');
    await writeFile(
      path,
      JSON.stringify([{ type: 'operation', name: 'calculate_brokerage', inputs: { 'reported loss date': { type: 'number' } }, outputs: { brokerage: { type: 'number' } } }]),
      'utf8',
    );
    const result = await workflowCommand({ source: path, json: true });
    const parsed = JSON.parse(result.lines[0]!);
    const param = parsed.steps[0].inputs[0];
    assert.equal(param.name, 'reported loss date');
    assert.notEqual(param.runtimeKey, param.name);
    assert.equal(param.status, 'missing');
  });
});

test('human-readable output lists each step\'s inputs/outputs with a clear supplied/injected/MISSING label', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');
    const result = await workflowCommand({ source: path });
    const output = result.lines.join('\n');
    assert.match(output, /inputs:/);
    assert.match(output, /outputs:/);
    assert.match(output, /MISSING/);
  });
});

test('a --input value keyed by the declared name (not the normalized runtime key) does NOT count as supplied — only the exact runtime key does', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'operations.json');
    await writeFile(path, JSON.stringify(OPERATION_FIXTURE), 'utf8');
    const result = await workflowCommand({ source: path, input: { Premium: 100000 }, json: true });
    const parsed = JSON.parse(result.lines[0]!);
    const producer = parsed.steps.find((s: { capabilityName: string }) => s.capabilityName === 'calculate_brokerage');
    const premiumParam = producer.inputs.find((p: { name: string }) => p.name === 'premium');
    assert.equal(premiumParam.status, 'missing');
  });
});

test('a .xo archive argument is refused with a clear, honest error instead of being silently mis-decoded as text', async () => {
  await withTempDir('xo-workflow-test-', async (tmp) => {
    const path = join(tmp, 'package.xo');
    // Real .xo files are binary zip-like archives; any non-UTF8-safe
    // byte sequence is enough to prove this path never reaches the
    // document-as-text fallback.
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe]));
    const result = await workflowCommand({ source: path });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /packaged \.xo archive/);
  });
});
