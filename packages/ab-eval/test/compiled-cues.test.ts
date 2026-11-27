import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGrounding, parseTrees } from '@xo/capability-layer';
import { compileManual, FREIGHT_CUE_HINTS } from '../src/index.js';

async function compiledTree(hints?: Record<string, readonly string[]>) {
  const { bundle } = await compileManual(hints === undefined ? {} : { cueHints: hints });
  const data = bundle.components.find((c) => c.kind === 'decision_trees')!.data;
  return parseTrees(JSON.parse(new TextDecoder().decode(data)))![0]!;
}

test('compiler derives evidence cues for every non-enum input and none for fixed-label inputs', async () => {
  const tree = await compiledTree();
  for (const i of tree.inputs) {
    if (i.enum !== undefined) assert.equal(i.evidenceCues, undefined, i.name);
    else assert.ok((i.evidenceCues?.length ?? 0) > 0, `${i.name} has no cues`);
  }
});

test('compiled tree: automatic cues refuse an unrelated real quote and accept the manual-worded clause', async () => {
  const tree = await compiledTree();
  const text = 'The bill of lading shows a declared value of $7,200 for the affected goods. They are asking for $7,200.';
  const g = (quote: string) => checkGrounding(tree, { declared_value_usd: 7200 }, { declared_value_usd: { quote } }, text);
  assert.equal(g('They are asking for $7,200').ok, false);
  assert.deepEqual(g('The bill of lading shows a declared value of $7,200 for the affected goods'), { ok: true });
});

test('known limit, pinned: automatic cues only know the manual\'s words; reviewer hints close the gap', async () => {
  const text = 'BOL lists $3,100 as the stated worth.';
  const ask = (tree: Awaited<ReturnType<typeof compiledTree>>) => checkGrounding(tree, { declared_value_usd: 3100 }, { declared_value_usd: { quote: 'BOL lists $3,100 as the stated worth' } }, text);
  assert.equal(ask(await compiledTree()).ok, false); // a false escalation, never a silent approval
  assert.deepEqual(ask(await compiledTree(FREIGHT_CUE_HINTS)), { ok: true });
});
