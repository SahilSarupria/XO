import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCapabilityLayer } from '@xo/capability-layer';
import { evidenceLexiconRecord, loadEvidenceLexicon } from '@xo/knowledge-base';
import { buildGoldXo, FREIGHT_EVIDENCE_VOCABULARY, seedEvidenceVocabulary } from '../src/index.js';
import { LEXICON } from './lexicon-fixture.js';

const HOST = { family: 'claude' as const, capabilities: ['chat', 'tool_use'] as ('chat' | 'tool_use')[] };

test('the vocabulary reaches the runtime only through the BKB, and the signed receipt says which knowledge state was used', () => {
  const withBkb = createCapabilityLayer(buildGoldXo(), { host: HOST, evidenceLexicon: LEXICON }).emitLoadReceipt().grounding;
  assert.match(withBkb.lexicon?.id ?? '', /^bkb:freight-desk:/);
  assert.match(withBkb.lexicon?.digest ?? '', /^sha256:/);
  assert.ok(withBkb.typedEvidence.includes('weather_event'));
  const without = createCapabilityLayer(buildGoldXo(), { host: HOST }).emitLoadReceipt().grounding;
  assert.equal(without.lexicon, null);
  assert.deepEqual(without.typedEvidence, []); // no vocabulary supplied: the receipt says value checks are not in force
  assert.ok(without.unverifiedValue.includes('weather_event'));
});

test('BKB governance: a proposed entry is inactive until a reviewer approves it, and approval changes the digest the receipt binds', async () => {
  const { kb, lexicon: before } = await seedEvidenceVocabulary(FREIGHT_EVIDENCE_VOCABULARY.slice(0, 2));
  assert.equal(before.lookup('claim_adjudication', 'salvage_value_usd'), undefined);
  const rec = evidenceLexiconRecord(
    kb.tenantId,
    { concept: 'salvage', names: ['salvage_value_usd'], cues: ['scrap'] },
    [{ sourceDigestSha256: 'b'.repeat(64), sourceName: 'reviewer note', locator: {}, method: { kind: 'human', name: 'reviewer', version: '1' } }],
    '2026-11-02T00:00:00.000Z',
  );
  const cs = await kb.propose({ operations: [{ op: 'add', record: rec }], origin: { kind: 'manual', ref: 'extra' }, proposedBy: { id: 'a', kind: 'user' } });
  assert.ok(cs);
  assert.equal((await loadEvidenceLexicon(kb)).lookup('claim_adjudication', 'salvage_value_usd'), undefined, 'proposed is not active');
  await kb.approve(cs.changeSetId, { id: 'r', kind: 'user' }, 'ok');
  const after = await loadEvidenceLexicon(kb);
  assert.deepEqual(after.lookup('claim_adjudication', 'salvage_value_usd')?.cues, ['scrap']);
  assert.notEqual(after.digest, before.digest);
});

test('tree scoping: an entry scoped to one tree does not apply to another', () => {
  assert.ok(LEXICON.lookup('claim_adjudication', 'packaging')?.valueEvidence?.some((v) => v.value === 'shipper_adequate'));
  assert.equal(LEXICON.lookup('compiled_policy', 'packaging'), undefined);
  assert.ok(LEXICON.lookup('compiled_policy', 'shipper_packed_freight_and_packaging_inadequate')?.valueEvidence?.some((v) => v.value === true));
});

// ── the runtime stays domain-agnostic: no business vocabulary in generic code ──
const BANNED = /freight|carrier|cargo|hazmat|salvage|blizzard|consignee|pallet|full[ -]value|proof of delivery|claimant|reefer|endorsement|halvorsen/i;
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const ROOT = join(import.meta.dirname, '..', '..');
const GENERIC = [...readdirSync(join(ROOT, 'capability-layer/src')).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, 'capability-layer/src', f)), join(ROOT, 'compiler/src/policy/cues.ts'), join(ROOT, 'knowledge-base/src/evidence-lexicon.ts')];
for (const file of GENERIC)
  test(`generic runtime has no domain vocabulary in code: ${file.slice(ROOT.length + 1)}`, () => {
    const hit = BANNED.exec(stripComments(readFileSync(file, 'utf8')));
    assert.equal(hit, null, hit ? `"${hit[0]}" is business knowledge: put it in the BKB` : '');
  });
