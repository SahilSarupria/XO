import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodesOfKind } from '@xo/xoir';
import { identifyDomain } from '../../src/knowledge-layer/identify.js';
import { BUILT_IN_PACKS } from '../../src/knowledge-layer/packs/index.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const INSURANCE = 'The insurer shall indemnify the insured for loss up to the sum insured. A deductible applies to each claim, and the premium is payable annually. Flood is an exclusion unless an endorsement is added.';
const FINANCE = 'The borrower shall repay the principal and accrued interest on the maturity date. The lender may enforce its collateral on an event of default. Each instalment is due monthly.';
const SUPPLY = 'The supplier shall deliver each shipment within the agreed lead time against the purchase order. Orders below the minimum order quantity are rejected. Safety stock is held at the warehouse.';

test('each built-in domain is identified from its own vocabulary, with the evidence that decided it', () => {
  for (const [text, pack] of [[INSURANCE, 'insurance-claims'], [FINANCE, 'finance-lending'], [SUPPLY, 'supply-chain']] as const) {
    const r = identifyDomain(text, BUILT_IN_PACKS);
    assert.equal(r.domain, pack, text.slice(0, 30));
    assert.ok(r.candidates[0]!.matchedConcepts.length >= 3);
  }
});

test('synonyms identify a domain even when the canonical term never appears ("excess" for deductible, "obligor" for borrower)', () => {
  const insurance = 'The policyholder bears the first excess on every claim; the limit of liability is the most the insurer pays, and a surveyor assesses the loss. Cover is subject to the exclusions in the schedule.';
  assert.equal(identifyDomain(insurance, BUILT_IN_PACKS).domain, 'insurance-claims');
  const finance = 'The obligor pays each instalment; the creditor holds security over the assets and the facility has a fixed tenor.';
  assert.equal(identifyDomain(finance, BUILT_IN_PACKS).domain, 'finance-lending');
});

test('text from an unfamiliar domain is reported as unknown, never forced into the nearest pack', () => {
  const hr = 'Full-time employees may take up to 20 days of annual leave. Requests longer than 5 days require line manager approval. Sick leave needs a medical certificate after 3 days.';
  const r = identifyDomain(hr, BUILT_IN_PACKS);
  assert.equal(r.domain, 'unknown');
});

test('generic words that merely OVERLAP a domain ("policy", "claim", "interest") do not trigger it', () => {
  const generic = 'Our privacy policy applies to all users. Users may claim a reward if they show interest in the program. The default setting is on.';
  assert.equal(identifyDomain(generic, BUILT_IN_PACKS).domain, 'unknown');
});

test('a document spanning two domains is reported as mixed with both candidates', () => {
  const r = identifyDomain(`${INSURANCE} ${FINANCE}`, BUILT_IN_PACKS);
  assert.equal(r.domain, 'mixed');
  assert.ok(r.candidates.length >= 2);
});

test('empty text and an empty pack list are handled', () => {
  assert.equal(identifyDomain('', BUILT_IN_PACKS).domain, 'unknown');
  assert.equal(identifyDomain(INSURANCE, []).domain, 'unknown');
});

test('compile reports the identified domain as an advisory diagnostic and does NOT change extraction', async () => {
  const text = `# Policy\n${INSURANCE}\n1.1 If the claim amount exceeds 5000, manager approval is required.\n`;
  const withPacks = await compileSources([{ kind: 'document', text, sourcePath: 'p.md' }], {});
  const without = await compileSources([{ kind: 'document', text, sourcePath: 'p.md' }], { knowledgePacks: false });
  assert.equal(withPacks.ok && without.ok, true);
  if (!withPacks.ok || !without.ok) return;
  const d = withPacks.value.diagnostics.find((x) => x.code === 'domain/identified');
  assert.ok(d && /insurance-claims/.test(d.message));
  assert.equal(without.value.diagnostics.some((x) => x.code.startsWith('domain/')), false);
  // identification never alters extraction: same stats and the same node properties (the graph hash itself embeds
  // per-compile metadata, so structural content is compared instead)
  assert.deepEqual(withPacks.value.stats, without.value.stats);
  const view = (g: Parameters<typeof nodesOfKind>[0]) => (['heuristic', 'decision_node', 'constraint', 'capability'] as const).flatMap((k) => nodesOfKind(g, k).map((n) => JSON.stringify(n.properties))).sort();
  assert.deepEqual(view(withPacks.value.graph), view(without.value.graph));
});

test('compile flags an unrecognised domain and says the neutral core was used alone', async () => {
  const r = await compileSources([{ kind: 'document', text: '# Leave\n1.1 If the leave request exceeds 5 days, line manager approval is required.\n', sourcePath: 'l.md' }], {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.value.diagnostics.find((x) => x.code === 'domain/unknown');
  assert.ok(d && /neutral core/i.test(d.message));
});
