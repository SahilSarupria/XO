// UW-5 (ADR 0040): entity resolution, cardinality, claims, normalisation properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseIdentifier,
  resolutionChangeOperations,
  resolveEntities,
  validateCardinality,
  type ResolutionSchema,
} from '../src/index.js';

const schema = (cardinality: ResolutionSchema['cardinality'] = 'one_to_one'): ResolutionSchema => ({
  relationship: 'recipient-document',
  cardinality,
  strongSchemes: { email: 'email', employee: 'alnum' },
});
const out = (r: ReturnType<typeof resolveEntities>, ref: string) => r.results.find((x) => x.subject === ref)!;

test('a same-name pair with no distinguishing evidence is Ambiguous', () => {
  const r = resolveEntities(
    schema(),
    [
      { ref: 's1', name: 'Asha Rao' },
      { ref: 's2', name: 'Asha Rao' },
    ],
    [{ ref: 'c1', name: 'Asha Rao.pdf' }],
  );
  assert.equal(out(r, 's1').outcome, 'ambiguous');
  assert.equal(out(r, 's2').outcome, 'ambiguous');
  assert.equal(r.clean, false);
});

test('a distinguishing identifier resolves a same-name pair to the right person', () => {
  const r = resolveEntities(
    schema(),
    [
      { ref: 's1', name: 'Asha Rao', identifiers: [{ scheme: 'email', value: 'a1@x.org' }] },
      { ref: 's2', name: 'Asha Rao', identifiers: [{ scheme: 'email', value: 'a2@x.org' }] },
    ],
    [{ ref: 'c1', name: 'Asha Rao.pdf', identifiers: [{ scheme: 'email', value: 'A2@X.ORG' }] }],
  );
  assert.equal(out(r, 's2').outcome, 'resolved');
  assert.equal(out(r, 's1').outcome, 'unmatched');
});

test('similarity never auto-confirms: initials, nicknames and spelling variants are at most Ambiguous', () => {
  for (const [name, file] of [
    ['Asha Rao', 'A Rao.pdf'],
    ['Robert Dsouza', 'Bob Dsouza.pdf'],
    ['Lakshmi Srivastava', 'Laxmi Shrivastav.pdf'],
  ] as const) {
    const r = resolveEntities(schema(), [{ ref: 's', name }], [{ ref: 'c', name: file }]);
    const res = out(r, 's');
    assert.equal(res.outcome, 'ambiguous', file);
    assert.ok(res.outcome === 'ambiguous' && res.candidates.every((c) => !c.confirming));
  }
});

test('conflicting strong identifiers exclude a name match', () => {
  const r = resolveEntities(
    schema(),
    [{ ref: 's', name: 'Asha Rao', identifiers: [{ scheme: 'email', value: 'a@x.org' }] }],
    [{ ref: 'c', name: 'Asha Rao.pdf', identifiers: [{ scheme: 'email', value: 'b@x.org' }] }],
  );
  assert.equal(out(r, 's').outcome, 'unmatched');
});

test('a one-word name is never confirmed by name alone', () => {
  const r = resolveEntities(schema(), [{ ref: 's', name: 'Imran' }], [{ ref: 'c', name: 'Imran.pdf' }]);
  assert.equal(out(r, 's').outcome, 'ambiguous');
});

test('one recipient matching two documents: ambiguous under one_to_one, resolved under one_to_many', () => {
  const cands = [
    { ref: 'c1', name: 'Priya Nair 2025.pdf' },
    { ref: 'c2', name: 'Priya Nair 2026.pdf' },
  ];
  assert.equal(out(resolveEntities(schema('one_to_one'), [{ ref: 's', name: 'Priya Nair' }], cands), 's').outcome, 'ambiguous');
  const many = resolveEntities(schema('one_to_many'), [{ ref: 's', name: 'Priya Nair' }], cands);
  assert.equal(out(many, 's').outcome, 'resolved');
  assert.deepEqual(many.violations, []);
});

test('two recipients matching one document are ambiguous under one_to_one', () => {
  const r = resolveEntities(
    schema(),
    [
      { ref: 's1', name: 'Asha Rao' },
      { ref: 's2', name: 'Asha Rao Kumar' },
    ],
    [{ ref: 'c', name: 'Asha Rao Kumar.pdf' }],
  );
  assert.equal(out(r, 's1').outcome, 'ambiguous');
  assert.equal(out(r, 's2').outcome, 'ambiguous');
});

test('unmatched sets are reported on both sides', () => {
  const r = resolveEntities(
    schema(),
    [
      { ref: 's1', name: 'Asha Rao' },
      { ref: 's2', name: 'Tarun Bose' },
    ],
    [
      { ref: 'c1', name: 'Asha Rao.pdf' },
      { ref: 'c2', name: 'Nobody Known.pdf' },
    ],
  );
  assert.deepEqual(r.unmatchedSubjects, ['s2']);
  assert.deepEqual(r.unmatchedCandidates, ['c2']);
  assert.equal(r.clean, false);
});

test('cardinality validation names the items, and catches links a person confirmed', () => {
  const v = validateCardinality({ relationship: 'r', cardinality: 'one_to_one' }, [
    { subject: 's1', candidate: 'c1' },
    { subject: 's1', candidate: 'c2' },
    { subject: 's2', candidate: 'c1' },
  ]);
  assert.deepEqual(
    v.map((x) => [x.kind, x.item, x.linkedTo]),
    [
      ['candidate_has_many', 'c1', ['s1', 's2']],
      ['subject_has_many', 's1', ['c1', 'c2']],
    ],
  );
  assert.deepEqual(
    validateCardinality({ relationship: 'r', cardinality: 'many_to_one' }, [
      { subject: 's1', candidate: 'c1' },
      { subject: 's2', candidate: 'c1' },
    ]),
    [],
  );
});

test('only resolved results become proposed claims, with evidence and no names', () => {
  const r = resolveEntities(
    schema(),
    [
      { ref: 's1', name: 'Asha Rao' },
      { ref: 's2', name: 'Imran' },
    ],
    [
      { ref: 'c1', name: 'Asha Rao.pdf' },
      { ref: 'c2', name: 'Imran.pdf' },
    ],
  );
  const ev = (n: string) => ({
    sourceDigestSha256: 'a'.repeat(64),
    sourceName: n,
    locator: { row: 1 },
    method: { kind: 'system' as const, name: 't', version: '1' },
  });
  const ops = resolutionChangeOperations(r, {
    tenantId: 't',
    relationship: 'rel',
    recordedAt: '2026-11-18T00:00:00Z',
    evidenceByRef: { s1: ev('list'), c1: ev('doc'), s2: ev('list'), c2: ev('doc') },
  });
  assert.equal(ops.length, 1);
  const rec = ops[0]!.op === 'add' ? ops[0]!.record : undefined;
  assert.ok(rec && rec.kind === 'claim');
  assert.ok(!/Asha|Rao/.test(JSON.stringify(rec)));
  const again = resolutionChangeOperations(r, {
    tenantId: 't',
    relationship: 'rel',
    recordedAt: '2027-01-01T00:00:00Z',
    evidenceByRef: { s1: ev('list'), c1: ev('doc') },
  });
  assert.equal((again[0] as { record: { id: string } }).record.id, (ops[0] as { record: { id: string } }).record.id);
  // No evidence, no claim.
  assert.equal(resolutionChangeOperations(r, { tenantId: 't', relationship: 'rel', recordedAt: 'x', evidenceByRef: {} }).length, 0);
});

test('normalisation is deterministic and idempotent, and does not merge different identifiers', () => {
  const samples = [' A.B@Example.ORG ', 'EMP-0012', 'emp 0012', 'ＥＭＰ０１２', 'x_y-z'];
  for (const rule of ['email', 'alnum', 'exact'] as const)
    for (const s of samples) {
      const once = normaliseIdentifier(rule, s);
      assert.equal(normaliseIdentifier(rule, s), once);
      assert.equal(normaliseIdentifier(rule, once), once);
    }
  assert.notEqual(normaliseIdentifier('email', 'a.b@x.org'), normaliseIdentifier('email', 'ab@x.org'));
  assert.notEqual(normaliseIdentifier('alnum', 'EMP-0012'), normaliseIdentifier('alnum', 'EMP-0021'));
  assert.equal(normaliseIdentifier('alnum', 'EMP-0012'), normaliseIdentifier('alnum', 'emp 0012'));
});

test('property: shuffling input order never changes any outcome (determinism), over many random worlds', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const first = ['Asha', 'Priya', 'Sanjay', 'Meera'];
  const last = ['Rao', 'Nair', 'Gupta'];
  for (let i = 0; i < 200; i++) {
    const subjects = Array.from({ length: 4 }, (_, k) => ({
      ref: `s${k}`,
      name: `${first[Math.floor(rnd() * 4)]} ${last[Math.floor(rnd() * 3)]}`,
    }));
    const cands = subjects.slice(0, 3).map((s, k) => ({ ref: `c${k}`, name: `${s.name}.pdf` }));
    const a = resolveEntities(schema(), subjects, cands);
    const b = resolveEntities(schema(), [...subjects].reverse(), [...cands].reverse());
    const key = (r: typeof a) =>
      r.results
        .map((x) => `${x.subject}:${x.outcome}`)
        .sort()
        .join('|');
    assert.equal(key(a), key(b));
    // No false merge: a resolved result always names a candidate whose name is the subject's.
    for (const res of a.results)
      if (res.outcome === 'resolved')
        for (const c of res.candidates)
          assert.equal(cands.find((x) => x.ref === c.candidate)!.name, `${subjects.find((s) => s.ref === res.subject)!.name}.pdf`);
  }
});
