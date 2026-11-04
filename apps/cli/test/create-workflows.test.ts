import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapabilityLayer, type DecisionTree } from '@xo/capability-layer';
import { ConnectorHost, MapVault, fileConnector } from '@xo/connectors';
import { unpackArchive } from '@xo/package-sdk';
import { workflowsFromLayer, type WorkflowComponent } from '@xo/workflow-ir';
import { RunStore, WorkflowRunner, type Escalation } from '@xo/workflow-runtime';
import { createCommand } from '../src/commands/compiler/create.js';
import { withTempDir } from './helpers.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../../../packages/compiler/test/fixtures/${name}`, import.meta.url));
const WARRANTY = fixture('warranty-desk-policy.md');
const LOAN = fixture('loan-desk-policy.md');

/** Everything an operator would do. The root directory is deliberately NOT created: the connector is told it may create it. */
function runnerFor(
  component: WorkflowComponent,
  workflowId: string,
  trees: readonly DecisionTree[],
  base: string,
  escalations: Escalation[] = [],
) {
  const host = new ConnectorHost({
    component,
    policy: { connectors: { decision_records: { grant: ['write_record'] } } },
    implementations: {
      decision_records: fileConnector({ roots: { records: join(base, 'records') }, maxBytes: 65_536, createRoots: true }),
    },
    vault: new MapVault({}),
  });
  return new WorkflowRunner({
    component,
    workflowId,
    store: new RunStore(join(base, 'runs')),
    connectors: host,
    trees: new Map(trees.map((t) => [t.id, t])),
    onEscalate: (e) => void escalations.push(e),
  });
}

async function compileToPackage(tmp: string, source: string, extra: Partial<Parameters<typeof createCommand>[0]> = {}) {
  const out = extra.out ?? join(tmp, 'pkg.xo');
  const res = await createCommand({ sources: [source], name: 'desk', version: '1.0.0', sign: true, ...extra, out });
  assert.equal(res.exitCode, 0, res.lines.join('\n'));
  return { res, out };
}

async function loadFromPackage(out: string) {
  const unpacked = await unpackArchive(new Uint8Array(await readFile(out)));
  assert.ok(unpacked.ok, 'unpack failed');
  const layer = createCapabilityLayer(unpacked.value, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
  const loaded = workflowsFromLayer(layer);
  assert.ok(loaded, 'the signed package carries no loadable workflows component');
  return { layer, loaded, trees: layer.decisionTrees() as readonly DecisionTree[] };
}
const structured = (c: WorkflowComponent) => c.workflows.find((w) => w.id.endsWith('_structured'))!;

const WARRANTY_OK = { customer_with_3_or_more_replacement: false, proof_of_purchase_attached: true, request_usd: 10, replacement_usd: 100 };
const LOAN_OK = { library_card: true, borrower_with_3_or_more_overdue: false, loan_usd: 100 };

test('xo create emits a signed package whose workflows component loads through the layer (hash-verified, L3)', async () => {
  await withTempDir('xo-wf-create-', async (tmp) => {
    const { res, out } = await compileToPackage(tmp, WARRANTY, { workflowReport: join(tmp, 'report.json') });
    const text = res.lines.join('\n');
    assert.match(text, /Workflows: \(declared, not measured\)/);
    assert.match(text, /\[structured\]: 4 deterministic, 0 model-assisted, 1 human step\(s\); ratio 0\.80; runs with no model/);
    assert.match(text, /\[text\]: 4 deterministic, 1 model-assisted, 1 human/);
    assert.match(text, /5\/8 decision sentences recognized, 3 unrecognized -> review/);
    const { layer, loaded } = await loadFromPackage(out);
    assert.equal(layer.emitLoadReceipt().level, 'L3');
    assert.ok(layer.emitLoadReceipt().consumed.includes('workflows'));
    assert.equal(loaded.component.workflows.length, 2);
    const report = JSON.parse(await readFile(join(tmp, 'report.json'), 'utf8'));
    assert.equal(report.label, 'declared, not measured');
    assert.equal(report.reviewItems.filter((r: { kind: string }) => r.kind === 'unrecognized_rule').length, 3);
  });
});

test('--no-workflows leaves the package without the component, and --workflow-report then refuses', async () => {
  await withTempDir('xo-wf-off-', async (tmp) => {
    const { out, res } = await compileToPackage(tmp, WARRANTY, { noWorkflows: true });
    assert.match(res.lines.join('\n'), /skipped \(--no-workflows\)/);
    const unpacked = await unpackArchive(new Uint8Array(await readFile(out)));
    assert.ok(unpacked.ok);
    assert.equal(unpacked.value.manifest.components['workflows'], undefined);
    const refused = await createCommand({
      sources: [WARRANTY],
      out: join(tmp, 'x.xo'),
      noWorkflows: true,
      workflowReport: join(tmp, 'r.json'),
    });
    assert.equal(refused.exitCode, 1);
    assert.equal(existsSync(join(tmp, 'r.json')), false);
  });
});

test('end to end, no model and no network: deny, escalate, hold, and the record is created without any operator mkdir', async () => {
  await withTempDir('xo-wf-run-', async (tmp) => {
    const { out } = await compileToPackage(tmp, WARRANTY);
    const { loaded, trees } = await loadFromPackage(out);
    const escalations: Escalation[] = [];
    const runner = runnerFor(loaded.component, structured(loaded.component).id, trees, tmp, escalations); // NO extractor: a model is impossible here
    assert.equal(existsSync(join(tmp, 'records')), false, 'the root exists before the first write');
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls++;
      throw new Error('network access attempted');
    }) as typeof fetch;
    try {
      const deny = await runner.start({
        runId: 'r-deny',
        inputs: { case_id: 'C-1', ...WARRANTY_OK, request_usd: 120, proof_of_purchase_attached: false },
      });
      assert.equal(deny.state, 'completed', JSON.stringify(deny));
      assert.equal(deny.outputs?.['decision'], 'deny');
      assert.equal(
        await readFile(join(tmp, 'records', 'decisions', 'deny', 'C-1.json'), 'utf8'),
        'decision=deny;reason_code=W1_PROOF_OF_PURCHASE;amount=0;case_id=C-1',
      );

      const rep = await runner.start({
        runId: 'r-repeat',
        inputs: { case_id: 'C-2', ...WARRANTY_OK, customer_with_3_or_more_replacement: true },
      });
      assert.equal(rep.state, 'escalated');
      assert.equal(escalations.at(-1)?.target, 'Support Manager');
      assert.equal(existsSync(join(tmp, 'records', 'decisions', 'escalate')), false);

      // nothing in this policy is approvable: a case passing every recognized check escalates, never auto-approves
      const pass = await runner.start({ runId: 'r-pass', inputs: { case_id: 'C-3', ...WARRANTY_OK } });
      assert.equal(pass.state, 'escalated');
      assert.equal(escalations.at(-1)?.reason.includes('UNFORMALIZED_RULE'), true);

      // an unsupplied fact is unknown: the case escalates instead of being decided
      const { proof_of_purchase_attached: _omitted, ...incomplete } = WARRANTY_OK;
      void _omitted;
      const missing = await runner.start({ runId: 'r-missing', inputs: { case_id: 'C-4', ...incomplete, request_usd: 500 } });
      assert.equal(missing.state, 'escalated');
      assert.notEqual(missing.outputs?.['decision'], 'deny');
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(fetchCalls, 0, 'the model-free path touched the network');
  });
});

test('the from-text workflow cannot run without a model: the runner refuses it (fail closed) rather than skipping extraction', async () => {
  await withTempDir('xo-wf-text-', async (tmp) => {
    const { out } = await compileToPackage(tmp, WARRANTY);
    const { loaded, trees } = await loadFromPackage(out);
    const wf = loaded.component.workflows.find((w) => w.id.endsWith('_from_text'))!;
    assert.throws(() => runnerFor(loaded.component, wf.id, trees, tmp), /cannot run on this runner/);
  });
});

test('adversarial: case_ids that try to leave the records root, or to forge record fields, cannot', async () => {
  await withTempDir('xo-wf-adv-', async (tmp) => {
    const { out } = await compileToPackage(tmp, WARRANTY);
    const { loaded, trees } = await loadFromPackage(out);
    const runner = runnerFor(loaded.component, structured(loaded.component).id, trees, tmp);
    const denyInputs = { ...WARRANTY_OK, request_usd: 120, proof_of_purchase_attached: false };
    // ids with a ".." path segment must be refused outright; the others may be accepted or refused but must stay inside the root
    const traversal = ['../../escape', 'a/../../b', '../', 'a/../b'];
    const odd = ['..', 'x/..', '/abs/path', 'x\\..\\y', 'a//b'];
    for (const [i, evil] of [...traversal, ...odd].entries()) {
      const r = await runner.start({ runId: `r-evil-${i}`, inputs: { case_id: evil, ...denyInputs } });
      if (traversal.includes(evil)) assert.notEqual(r.state, 'completed', `case_id ${JSON.stringify(evil)} was accepted`);
    }
    assert.deepEqual((await readdir(tmp)).sort(), ['pkg.xo', 'records', 'runs']);
    const written: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else written.push(join(d, e.name));
      }
    };
    await walk(join(tmp, 'records'));
    for (const f of written) assert.ok(f.startsWith(join(tmp, 'records') + '/'), `${f} is outside the root`);

    // record forgery: a hostile id can only ever appear AFTER the policy-computed fields, so the first "decision=" is the real one
    const forged = await runner.start({ runId: 'r-forge', inputs: { case_id: 'x;decision=approve;reason_code=FORGED', ...denyInputs } });
    assert.equal(forged.state, 'completed');
    const rec = await readFile(join(tmp, 'records', 'decisions', 'deny', 'x;decision=approve;reason_code=FORGED.json'), 'utf8');
    assert.ok(rec.startsWith('decision=deny;reason_code=W1_PROOF_OF_PURCHASE;'), rec);
    assert.equal(rec.indexOf('decision=deny'), 0);
    assert.ok(rec.indexOf('case_id=') > rec.indexOf('reason_code='));
  });
});

test('approvals: a fully recognized policy approves end to end through the signed package', async () => {
  await withTempDir('xo-wf-approve-', async (tmp) => {
    const { res, out } = await compileToPackage(tmp, LOAN);
    assert.match(res.lines.join('\n'), /outcomes: deny, escalate, approve|outcomes: [a-z, ]*approve/);
    const { loaded, trees } = await loadFromPackage(out);
    const runner = runnerFor(loaded.component, structured(loaded.component).id, trees, tmp);
    const ok = await runner.start({ runId: 'r-ok', inputs: { case_id: 'L-9', ...LOAN_OK } });
    assert.equal(ok.state, 'completed', JSON.stringify(ok));
    assert.equal(ok.outputs?.['decision'], 'approve');
    assert.equal(
      await readFile(join(tmp, 'records', 'decisions', 'approve', 'L-9.json'), 'utf8'),
      'decision=approve;reason_code=APPROVED;amount=0;case_id=L-9',
    );
    const denied = await runner.start({ runId: 'r-no-card', inputs: { case_id: 'L-10', ...LOAN_OK, library_card: false } });
    assert.equal(denied.outputs?.['decision'], 'deny');
  });
});

test('FAIL CLOSED end to end: an open review item holds the approval; a signed-in reviewer ruling file releases it', async () => {
  await withTempDir('xo-wf-hold-', async (tmp) => {
    const source = join(tmp, 'loan-with-open-item.md');
    const sentence = 'Staff must use judgement when the borrower is a minor.';
    const text = (await readFile(LOAN, 'utf8')).replace('## Rules', `## Rules\n\n**L0 Minors.** ${sentence}`);
    await writeFile(source, text);

    // 1. no ruling: the approval is HELD, and the CLI says so
    const held = await compileToPackage(tmp, source);
    assert.match(
      held.res.lines.join('\n'),
      /An approving rule is recognized \(.*\) but HELD: 1 decision sentence\(s\) are still unreviewed/,
    );
    {
      const { loaded, trees } = await loadFromPackage(held.out);
      const escalations: Escalation[] = [];
      const r = await runnerFor(loaded.component, structured(loaded.component).id, trees, tmp, escalations).start({
        runId: 'r-held',
        inputs: { case_id: 'L-1', ...LOAN_OK },
      });
      assert.equal(r.state, 'escalated');
      assert.match(escalations.at(-1)?.reason ?? '', /APPROVAL_HELD_UNREVIEWED_RULES/);
      assert.equal(existsSync(join(tmp, 'records', 'decisions', 'approve')), false, 'an approval was recorded over an unreviewed rule');
    }

    // 2. a ruling for a DIFFERENT sentence does not release it (stale rulings are inert)
    await writeFile(join(tmp, 'stale.json'), JSON.stringify({ accepted: [], rejected: [{ sentence: 'Some other sentence.' }] }));
    const stale = await compileToPackage(tmp, source, { reviewLedger: join(tmp, 'stale.json'), out: join(tmp, 'stale.xo') });
    assert.match(stale.res.lines.join('\n'), /HELD/);

    // 3. the reviewer rules the sentence is guidance, not a rule: the hold lifts and the approval runs
    await writeFile(
      join(tmp, 'rulings.json'),
      JSON.stringify({ accepted: [], rejected: [{ sentence, note: 'staff guidance, not a decision rule' }] }),
    );
    const released = await compileToPackage(tmp, source, { reviewLedger: join(tmp, 'rulings.json'), out: join(tmp, 'released.xo') });
    assert.doesNotMatch(released.res.lines.join('\n'), /HELD/);
    const { loaded, trees } = await loadFromPackage(released.out);
    const r = await runnerFor(loaded.component, structured(loaded.component).id, trees, tmp).start({
      runId: 'r-released',
      inputs: { case_id: 'L-2', ...LOAN_OK },
    });
    assert.equal(r.state, 'completed', JSON.stringify(r));
    assert.equal(r.outputs?.['decision'], 'approve');
  });
});

test('--decision-sink none: the package declares no connector and no action; the decision is the run result and nothing touches disk', async () => {
  await withTempDir('xo-wf-none-', async (tmp) => {
    const { res, out } = await compileToPackage(tmp, LOAN, { decisionSink: 'none' });
    assert.match(res.lines.join('\n'), /No action is emitted/);
    const { loaded, trees } = await loadFromPackage(out);
    assert.deepEqual(loaded.component.connectors, []);
    const wf = structured(loaded.component);
    assert.equal(
      wf.steps.some((s) => s.type === 'act'),
      false,
    );
    const runner = new WorkflowRunner({
      component: loaded.component,
      workflowId: wf.id,
      store: new RunStore(join(tmp, 'runs')),
      trees: new Map(trees.map((t) => [t.id, t])),
    });
    const r = await runner.start({ runId: 'r-none', inputs: { case_id: 'N-1', ...LOAN_OK } });
    assert.equal(r.state, 'completed', JSON.stringify(r));
    assert.equal(r.outputs?.['decision'], 'approve');
    assert.deepEqual((await readdir(tmp)).sort(), ['pkg.xo', 'runs']);
  });
});

test('bad operator input fails closed with a clear message: malformed ledger, unknown sink', async () => {
  await withTempDir('xo-wf-bad-', async (tmp) => {
    for (const [name, body] of [
      ['not-json.json', '{nope'],
      ['wrong-shape.json', JSON.stringify({ accepted: 'x', rejected: [] })],
      ['bad-entry.json', JSON.stringify({ accepted: [{ sentence: 1 }], rejected: [] })],
    ] as const) {
      await writeFile(join(tmp, name), body);
      const res = await createCommand({ sources: [LOAN], out: join(tmp, 'x.xo'), reviewLedger: join(tmp, name) });
      assert.equal(res.exitCode, 1, name);
      assert.match(res.lines.join('\n'), /--review-ledger/);
    }
    const sink = await createCommand({ sources: [LOAN], out: join(tmp, 'y.xo'), decisionSink: 'slack' as never });
    assert.equal(sink.exitCode, 1);
    assert.match(sink.lines.join('\n'), /--decision-sink/);
    assert.equal(existsSync(join(tmp, 'x.xo')) || existsSync(join(tmp, 'y.xo')), false);
  });
});
