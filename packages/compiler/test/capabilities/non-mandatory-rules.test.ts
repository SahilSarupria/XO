import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodesOfKind } from '@xo/xoir';
import { compileSources } from '../../src/pipeline/compile-sources.js';

// Domain-neutral wording. The same condition with a different modality must be treated differently.
async function compile(text: string) {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'rules.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value;
}

const capabilityNames = (graph: Parameters<typeof nodesOfKind>[0]) =>
  nodesOfKind(graph, 'capability').map((n) => String((n.properties as Record<string, unknown>)['name']));

const props = (graph: Parameters<typeof nodesOfKind>[0]) =>
  [...nodesOfKind(graph, 'heuristic'), ...nodesOfKind(graph, 'decision_node')].map((n) => n.properties as Record<string, unknown>);

test('every rule node carries typed modality and polarity beside its raw text', async () => {
  const v = await compile(
    '# Rules\n1.1 If the widget count exceeds 5, the operator must log the event.\n1.2 If the widget count exceeds 9, the supplier may suspend the line.\n',
  );
  const rules = props(v.graph);
  assert.ok(rules.length >= 2);
  for (const p of rules) {
    assert.ok(typeof p['modality'] === 'string' && typeof p['polarity'] === 'string', JSON.stringify(p));
  }
  const byText = (needle: string) => rules.find((p) => String(p['action'] ?? p['outcome']).includes(needle))!;
  assert.equal(byText('must log')['modality'], 'obligation');
  assert.equal(byText('may suspend')['modality'], 'permission');
});

test('a permission with a fully structured condition is not minted as a mandatory rule, and is reported', async () => {
  const v = await compile('# Rules\n1.1 If the widget count exceeds 9, the supplier may suspend the line.\n');
  assert.equal(
    capabilityNames(v.graph).some((n) => /suspend/i.test(n)),
    false,
  );
  assert.ok(v.diagnostics.some((d) => d.code === 'rule-modality/non-mandatory-not-executable' && /suspend/.test(d.message)));
  // meaning is preserved in the graph, not discarded
  assert.ok(props(v.graph).some((p) => String(p['action']).includes('may suspend')));
});

test('the same condition with a mandatory outcome IS still minted (no over-blocking)', async () => {
  const v = await compile('# Rules\n1.1 If the widget count exceeds 9, the operator must log the event.\n');
  assert.equal(
    capabilityNames(v.graph).some((n) => /log the event/i.test(n)),
    true,
  );
  assert.equal(
    v.diagnostics.some((d) => d.code === 'rule-modality/non-mandatory-not-executable'),
    false,
  );
});

test('rule nodes also carry a typed outcomeType distinct from modality', async () => {
  const v = await compile(
    '# Rules\n1.1 If the widget count exceeds 5, approve the request.\n1.2 If the widget count exceeds 9, manager approval is required.\n1.3 If the widget count exceeds 12, the request must be rejected.\n1.4 If the widget count exceeds 20, escalate to the duty lead.\n',
  );
  const rules = props(v.graph);
  const typeOf = (needle: string) => rules.find((p) => String(p['action'] ?? p['outcome']).includes(needle))?.['outcomeType'];
  assert.equal(typeOf('approve the request'), 'approve');
  assert.equal(typeOf('approval is required'), 'requires_approval');
  assert.equal(typeOf('rejected'), 'deny');
  assert.equal(typeOf('escalate'), 'escalate');
});

test('an exception companion node ("unless ...") is not typed as if it were a rule outcome', async () => {
  const v = await compile('# Rules\n1.1 If the widget count exceeds 5, the request must be rejected unless the gadget is approved.\n');
  const rules = props(v.graph);
  const main = rules.find((p) => String(p['action']).includes('must be rejected'))!;
  assert.equal(main['outcomeType'], 'deny');
  const companion = rules.find(
    (p) => String(p['condition']).includes('gadget is approved') && !String(p['action']).includes('must be rejected'),
  );
  assert.ok(companion, 'companion exception node exists');
  assert.equal(companion!['outcomeType'], undefined);
  assert.equal(companion!['modality'], undefined);
});
