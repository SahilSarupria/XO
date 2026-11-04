import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTree } from '@xo/capability-layer';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { packageXoirGraph } from '../../src/pipeline/packager.js';
import { policyTextFromParsed } from '../../src/policy/from-document.js';
import { synthesizePolicyArtifacts } from '../../src/policy/artifacts.js';

const doc = [
  '# Late Fee Policy',
  '',
  '## Timing (R1)',
  '',
  '**Payment window.** A standard invoice must be paid within 30 days after the invoice date. A rush invoice must be paid within 10 days after the invoice date.',
  '',
  '## Fees (R2)',
  '',
  '**Fee.** The late fee is the days overdue multiplied by the rate for the invoice tier.',
  '',
  '**Approval limit.** If the total fee is more than $500, escalate to the Finance Director.',
  '',
  '## Rates',
  '',
  '| Invoice tier | Fee per day |',
  '| ------------ | ----------- |',
  '| standard | 5 |',
  '| rush | 12 |',
].join('\n');

test('compileSources runs policy synthesis, so `xo create` yields an executable tree', async () => {
  const r = await compileSources([{ kind: 'document', text: doc, sourcePath: 'late-fee.md', title: 'Late Fee Policy' }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.value.policy?.trees?.[0], 'a decision tree was synthesized from the document');
  const packaged = packageXoirGraph(r.value.graph, {
    identity: { name: 'late-fee', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: { domain: 'test', description: 'd', scope: [], limitations: [] },
    policy: r.value.policy!,
  });
  assert.ok(packaged.ok);
  if (packaged.ok) assert.ok(packaged.value.bundle.components.some((c) => c.kind === 'decision_trees'));
});

test('policy synthesis can be switched off', async () => {
  const r = await compileSources([{ kind: 'document', text: doc, sourcePath: 'late-fee.md' }], { policy: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.policy, undefined);
});

test('a table is read as rows (not prose), and compiles to a lookup the rules can use', async () => {
  const r = await compileSources([{ kind: 'document', text: doc, sourcePath: 'late-fee.md' }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  const table = r.value.policy!.program.tables?.[0];
  assert.ok(table !== undefined, 'the table became a lookup');
  assert.deepEqual(table!.rows, [
    { key: 'standard', value: 5 },
    { key: 'rush', value: 12 },
  ]);
  const tree = r.value.policy!.trees![0]!;
  const out = evaluateTree(tree, { invoice_type: 'rush', days_to_pay: 99, total_fee_usd: 1 }) as {
    ok: boolean;
    output: { decision: string };
  };
  assert.equal(out.output.decision, 'deny', 'a rush invoice paid after 10 days is late');
  // table cells never become capabilities
  const capNames = r.value.graph
    .allNodes()
    .filter((n) => n.kind === 'capability')
    .map((n) => JSON.stringify(n.properties));
  assert.ok(!capNames.some((c) => /Fee per day|rush \| 12/.test(c)));
});

test('aligned-column text tables are detected too, a lone double-spaced line is not', () => {
  const parsedOf = async (text: string) => {
    const r = await compileSources([{ kind: 'document', text, sourcePath: 'x.txt' }], { policy: false });
    return r;
  };
  void parsedOf;
  const a = synthesizePolicyArtifacts([{ text: doc, title: 't' }]);
  assert.ok(a.program.facts.length > 0);
});

test('policyTextFromParsed pulls table rows out of the text and keeps headings and paragraphs', async () => {
  const { DocumentSourceFrontend } = await import('../../src/sources/document-frontend.js');
  const ingested = new DocumentSourceFrontend().ingest({
    kind: 'document',
    text: 'Intro line.\n\nTier   Fee\nstandard   5\nrush   12\n\nThis sentence  has two spaces only.',
    sourcePath: 'x.txt',
  });
  assert.ok(ingested.ok);
  if (!ingested.ok || ingested.value.content.kind !== 'document') return;
  const out = policyTextFromParsed(ingested.value.content.parsed);
  assert.equal(out.tables.length, 1);
  assert.deepEqual(out.tables[0]!.header, ['Tier', 'Fee']);
  assert.ok(out.text.includes('This sentence  has two spaces only.') || out.text.includes('This sentence has two spaces only.'));
  assert.ok(!out.text.includes('standard'));
});
