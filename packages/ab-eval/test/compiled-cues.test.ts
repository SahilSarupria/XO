import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGrounding, parseTrees } from '@xo/capability-layer';
import { applyLexicon } from '@xo/capability-layer';
import { compileManual } from '../src/index.js';
import { LEXICON } from './lexicon-fixture.js';

async function compiledTree(withBkb = false) {
  const { bundle } = await compileManual();
  const data = bundle.components.find((c) => c.kind === 'decision_trees')!.data;
  const tree = parseTrees(JSON.parse(new TextDecoder().decode(data)))![0]!;
  return withBkb ? applyLexicon(tree, LEXICON) : tree;
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

test('known limit, pinned: automatic cues only know the manual\'s words; the BKB vocabulary closes the gap', async () => {
  const text = 'BOL lists $3,100 as the stated worth.';
  const ask = (tree: Awaited<ReturnType<typeof compiledTree>>) => checkGrounding(tree, { declared_value_usd: 3100 }, { declared_value_usd: { quote: 'BOL lists $3,100 as the stated worth' } }, text);
  assert.equal(ask(await compiledTree()).ok, false); // a false escalation, never a silent approval
  assert.deepEqual(ask(await compiledTree(true)), { ok: true });
});
