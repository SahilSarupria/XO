import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreCategoricalStates, LEGACY_DOMAIN_STATE_WORDS } from '@xo/capability-contract';
import { INSURANCE_CLAIMS_PROFILE, listDomainProfiles, resolveDomainProfile } from '../../src/profiles/index.js';

// GUARD: the neutral core's vocabulary is pinned. Adding a word here needs a justification that it is domain-neutral;
// a subject-matter word belongs in a profile. The legacy list may only shrink.
const NEUTRAL_CORE = new Set([
  'registered',
  'unregistered',
  'open',
  'closed',
  'scheduled',
  'unscheduled',
  'available',
  'unavailable',
  'enabled',
  'disabled',
  'suspended',
  'verified',
  'unverified',
  'authorized',
  'authorised',
  'unauthorized',
  'unauthorised',
  'overdue',
  'paid',
  'unpaid',
  'submitted',
  'confirmed',
  'signed',
  'unsigned',
  'resolved',
  'unresolved',
  'approved',
  'active',
  'inactive',
  'cancelled',
  'canceled',
  'applicable',
  'valid',
  'invalid',
  'excluded',
  'covered',
  'required',
  'mandatory',
  'void',
  'expired',
  'pending',
  'present',
  'missing',
  'denied',
  'eligible',
  'payable',
  'correct',
  'incorrect',
  'complete',
  'incomplete',
  'satisfied',
]);

test('the core categorical vocabulary contains only pinned neutral words plus the documented legacy domain words', () => {
  const unexpected = coreCategoricalStates().filter((w) => !NEUTRAL_CORE.has(w) && !LEGACY_DOMAIN_STATE_WORDS.includes(w));
  assert.deepEqual(unexpected, [], `new core word(s) need a neutrality justification or must move to a profile: ${unexpected.join(', ')}`);
});

test('the legacy domain words list never grows beyond the two documented claims words', () => {
  assert.deepEqual([...LEGACY_DOMAIN_STATE_WORDS].sort(), ['flood', 'theft']);
});

test('the insurance-claims profile carries every legacy domain word, so migrating them out of the core loses nothing', () => {
  for (const w of LEGACY_DOMAIN_STATE_WORDS) assert.ok(INSURANCE_CLAIMS_PROFILE.lexicon.categoricalStates?.includes(w), w);
});

test('profiles resolve by id; an unknown id is undefined, never a silent fallback', () => {
  assert.equal(resolveDomainProfile('insurance-claims'), INSURANCE_CLAIMS_PROFILE);
  assert.equal(resolveDomainProfile('does-not-exist'), undefined);
  assert.ok(listDomainProfiles().length >= 1);
});

// ── autoProfile: explicit opt-in application of the profile matching the IDENTIFIED domain ─────────────────────────
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { nodesOfKind } from '@xo/xoir';
import { identifyDomain } from '../../src/knowledge-layer/identify.js';
import { BUILT_IN_PACKS } from '../../src/knowledge-layer/packs/index.js';
import type { DomainKnowledgePack } from '../../src/knowledge-layer/types.js';
import type { DomainProfile } from '../../src/profiles/index.js';

const LAB_PACK: DomainKnowledgePack = {
  id: 'lab-testing',
  version: '1',
  domain: 'lab',
  description: 'fixture',
  provenance: 'test',
  status: 'draft',
  relationships: [],
  patterns: [],
  concepts: ['specimen', 'assay', 'reagent', 'centrifuge'].map((l) => ({
    id: l,
    label: l,
    kind: 'entity' as const,
    definition: `${l} in a laboratory`,
    synonyms: [],
    weight: 1,
  })),
};
const LAB_PROFILE: DomainProfile = { id: 'lab-testing', description: 'fixture', lexicon: { categoricalStates: ['quarantined'] } };
const TEXT =
  '# Lab rules\nEach specimen is run through the assay with a fresh reagent in the centrifuge.\n1.1 If the specimen is quarantined, the operator must log the event.\n';
const structured = (g: Parameters<typeof nodesOfKind>[0]) =>
  [...nodesOfKind(g, 'heuristic'), ...nodesOfKind(g, 'decision_node')].filter(
    (n) => (n.properties as Record<string, unknown>)['structuredCondition'] !== undefined,
  ).length;

test('autoProfile applies the profile whose id equals the identified domain, reports it, and is off by default', async () => {
  assert.equal(identifyDomain(TEXT, [LAB_PACK]).domain, 'lab-testing');
  const off = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'l.md' }], {
    knowledgePacks: [LAB_PACK],
    profiles: [LAB_PROFILE],
  });
  const on = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'l.md' }], {
    knowledgePacks: [LAB_PACK],
    profiles: [LAB_PROFILE],
    autoProfile: true,
  });
  assert.equal(off.ok && on.ok, true);
  if (!off.ok || !on.ok) return;
  assert.equal(structured(off.value.graph), 0);
  assert.ok(structured(on.value.graph) >= 1);
  assert.ok(on.value.diagnostics.some((d) => d.code === 'domain/profile-applied' && /lab-testing/.test(d.message)));
  assert.equal(
    off.value.diagnostics.some((d) => d.code === 'domain/profile-applied'),
    false,
  );
});

test('autoProfile never guesses: an unknown or mixed domain applies nothing', async () => {
  const unknown = await compileSources(
    [{ kind: 'document', text: '# Leave\n1.1 If the leave request is quarantined, approve it.\n', sourcePath: 'l.md' }],
    { knowledgePacks: [LAB_PACK], profiles: [LAB_PROFILE], autoProfile: true },
  );
  assert.equal(unknown.ok, true);
  if (unknown.ok)
    assert.equal(
      unknown.value.diagnostics.some((d) => d.code === 'domain/profile-applied'),
      false,
    );
  assert.ok(BUILT_IN_PACKS.length >= 1);
});

test('an explicit lexicon always wins over autoProfile', async () => {
  const r = await compileSources([{ kind: 'document', text: TEXT, sourcePath: 'l.md' }], {
    knowledgePacks: [LAB_PACK],
    profiles: [LAB_PROFILE],
    autoProfile: true,
    lexicon: { categoricalStates: [] },
  });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.equal(
      r.value.diagnostics.some((d) => d.code === 'domain/profile-applied'),
      false,
    );
});
