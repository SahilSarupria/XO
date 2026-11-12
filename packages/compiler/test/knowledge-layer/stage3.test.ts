import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const INS = [
  '# Policy',
  'The insurer shall indemnify the insured up to the sum insured. A deductible applies to each claim, and the premium is payable annually.',
  '1.1 If the first excess is partly waived by the surveyor, the claim must be reviewed.',
].join('\n');

async function run(text: string, opts = {}) {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'p.md' }], opts);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value;
}

test('an unresolved condition gets domain hints retrieved from the identified pack (synonym "excess" -> deductible), with provenance', async () => {
  const v = await run(INS);
  const item = v.reviewQueue!.items.find((i) => i.kind === 'unresolved-condition')!;
  assert.ok(item, 'unresolved condition item');
  const hint = item.hints?.find((h) => h.conceptId === 'deductible');
  assert.ok(hint, JSON.stringify(item.hints));
  assert.equal(hint!.packId, 'insurance-claims');
  assert.ok(hint!.engines.length >= 1);
  assert.ok(hint!.definition.length > 0);
});

test('hints are advisory: readiness states and node content are identical with and without packs', async () => {
  const withPacks = await run(INS);
  const without = await run(INS, { knowledgePacks: false });
  assert.deepEqual(withPacks.executionReadiness, without.executionReadiness);
  assert.equal(
    without.reviewQueue!.items.some((i) => i.hints !== undefined),
    false,
  );
});

test('in an unfamiliar domain, an unstructured rule produces a clarification request listing the terms it could not place', async () => {
  const v = await run('# Rules\n1.1 If the gadget behaves oddly, the request must be rejected.\n');
  const item = v.reviewQueue!.items.find((i) => i.kind === 'domain-clarification')!;
  assert.ok(item);
  assert.match(item.summary, /gadget behaves oddly/);
  assert.match(item.detail, /gadget/);
  assert.match(item.detail, /which domain|define|profile/i);
  assert.equal(item.priority, 2);
});

test('no clarification request is raised when the domain WAS recognised (hints are offered instead)', async () => {
  const v = await run(INS);
  assert.equal(
    v.reviewQueue!.items.some((i) => i.kind === 'domain-clarification'),
    false,
  );
});

test('hints never claim the document contains a rule: they only carry reference definitions', async () => {
  const v = await run(INS);
  for (const i of v.reviewQueue!.items) for (const h of i.hints ?? []) assert.ok(!('condition' in h) && !('outcome' in h));
});
