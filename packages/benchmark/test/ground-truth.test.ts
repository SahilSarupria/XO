import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTATION_CATEGORIES,
  auditExpectationIntegrity,
  auditGroundTruth,
  canonicalJson,
  declaredWorld,
  evalAll,
  expectationsFingerprint,
  listExpectations,
  loadSuiteFile,
  matchesName,
  observeCase,
  parseGroundTruth,
  validateSuiteDefinition,
  type BenchmarkSuiteDefinition,
  type GroundTruthRegister,
} from '../src/index.js';

/**
 * P0.9C Step 3 — golden-expectation integrity. These tests never change what
 * is evaluated: they pin WHAT IS EXPECTED, WHY it is believed (the register),
 * and WHICH world each scope claims, so ground truth cannot drift silently.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const SUITES = ['vertical-fixtures', 'runtime-mechanics'] as const;

async function load(name: string): Promise<{ suite: BenchmarkSuiteDefinition; sourceRoot: string; register: GroundTruthRegister }> {
  const l = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
  assert.ok(l.ok, l.ok ? '' : l.message);
  const parsed = parseGroundTruth(JSON.parse(await readFile(join(PKG, 'ground-truth', `${name}.ground-truth.json`), 'utf8')));
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.issues));
  return { suite: l.suite, sourceRoot: l.sourceRoot, register: parsed.value };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (f: readonly { code: string }[]): string[] => f.map((x) => x.code);

// ---- 1. structure ---------------------------------------------------------------------------

test('every committed suite is structurally valid and every expectation has a valid category and a unique (category, id)', async () => {
  for (const name of SUITES) {
    const raw = JSON.parse(await readFile(join(PKG, 'suites', `${name}.suite.json`), 'utf8'));
    assert.ok(validateSuiteDefinition(raw).ok, `${name} validates`);
    const { suite } = await load(name);
    for (const def of suite.cases) {
      const refs = listExpectations(def);
      assert.ok(refs.length > 0, `${def.caseId} declares expectations`);
      for (const r of refs) assert.ok(EXPECTATION_CATEGORIES.includes(r.category));
      assert.equal(new Set(refs.map((r) => `${r.category}|${r.id}`)).size, refs.length, `${def.caseId}: no duplicate (category, id)`);
    }
  }
});

test('the suite validator rejects duplicate ids, unknown fields (so provenance cannot be smuggled inline) and malformed expectations', async () => {
  const { suite } = await load('vertical-fixtures');
  const base = clone(suite) as unknown as { cases: Array<{ expect: { capabilities: { items: Array<Record<string, unknown>> } } }> };
  const withCaps = base.cases.find((c) => c.expect.capabilities?.items?.length >= 2)!;

  const dup = clone(base);
  const items = dup.cases.find((c) => c.expect.capabilities?.items?.length >= 2)!.expect.capabilities.items;
  items[1]!['id'] = items[0]!['id'];
  assert.equal(validateSuiteDefinition(dup).ok, false, 'duplicate capability id rejected');

  const inline = clone(base);
  inline.cases.find((c) => c.expect.capabilities?.items?.length >= 2)!.expect.capabilities.items[0]!['basis'] = 'explicit';
  assert.equal(validateSuiteDefinition(inline).ok, false, 'an inline "basis" field is an unknown field: provenance lives in the register, not the suite');

  const noMatcher = clone(base);
  delete noMatcher.cases.find((c) => c.expect.capabilities?.items?.length >= 2)!.expect.capabilities.items[0]!['name'];
  assert.equal(validateSuiteDefinition(noMatcher).ok, false, 'an expectation without a name matcher is rejected');
  assert.ok(withCaps);
});

// ---- 2. register <-> suite --------------------------------------------------------------------

test('each committed register parses strictly and matches its suite exactly: full coverage, no orphans, fingerprints, world model, forbidden evidence', async () => {
  for (const name of SUITES) {
    const { suite, register } = await load(name);
    assert.deepEqual(auditGroundTruth(suite, register), [], `${name}: register is consistent with the suite`);
    const expectations = suite.cases.reduce((n, c) => n + listExpectations(c).length, 0);
    assert.equal(register.cases.reduce((n, c) => n + c.entries.length, 0), expectations, `${name}: exactly one entry per expectation`);
  }
});

test('the strict parser rejects malformed registers (unknown field, bad enum, duplicate, not_established, bad fingerprint, empty source, misplaced kinds)', async () => {
  const { register } = await load('vertical-fixtures');
  const bad = (mutate: (r: any) => void): string => {
    const r = clone(register) as any;
    mutate(r);
    const p = parseGroundTruth(r);
    assert.equal(p.ok, false);
    return p.ok ? '' : p.issues.map((i) => `${i.path}: ${i.message}`).join(' | ');
  };
  assert.match(bad((r) => (r.cases[0].entries[0].confidence = 0.9)), /unknown field/);
  assert.match(bad((r) => (r.cases[0].entries[0].identity = 'certain')), /must be one of/);
  assert.match(bad((r) => r.cases[0].entries.push(clone(r.cases[0].entries[0]))), /duplicate entry/);
  assert.match(bad((r) => (r.cases[0].entries[0].identity = 'not_established')), /unestablished/);
  assert.match(bad((r) => (r.cases[0].expectationsFingerprint = 'nope')), /16 lowercase hex/);
  assert.match(bad((r) => (r.cases[0].entries[0].source = '  ')), /non-empty string/);
  assert.match(bad((r) => (r.cases[0].world[1].kinds = ['x'])), /only valid for scope "facts"/);
  assert.match(bad((r) => r.cases.push(clone(r.cases[0]))), /duplicate caseId/);
  assert.match(bad((r) => r.cases[0].world.push(clone(r.cases[0].world[0]))), /duplicate world scope/);
  assert.match(bad((r) => (r.cases[0].unestablished[0] = { status: 'nope', topic: 't', note: 'n' })), /must be one of/);
  assert.equal(parseGroundTruth('nonsense').ok, false);
});

test('the audit detects a missing entry, an orphan entry, an unlisted case and a stale register', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const r1 = clone(register) as any;
  r1.cases[0].entries.shift();
  assert.deepEqual(codes(auditGroundTruth(suite, r1)), ['expectation_missing_in_register']);
  const r2 = clone(register) as any;
  r2.cases[0].entries.push({ category: 'capability', id: 'ghost', identity: 'explicit', source: 'x' });
  assert.deepEqual(codes(auditGroundTruth(suite, r2)), ['entry_orphan']);
  const r3 = clone(register) as any;
  r3.cases.pop();
  assert.deepEqual(codes(auditGroundTruth(suite, r3)), ['case_missing_in_register']);
  const r4 = clone(register) as any;
  r4.cases.push({ ...clone(r4.cases[0]), caseId: 'ghost-case' });
  assert.deepEqual(codes(auditGroundTruth(suite, r4)), ['case_orphan_in_register']);
  const r5 = clone(register) as any;
  r5.suiteId = 'other';
  assert.deepEqual(codes(auditGroundTruth(suite, r5)), ['suite_id_mismatch']);
});

test('editing ANY golden expectation is impossible to do silently: the fingerprint changes and the audit fails until the register is re-audited', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const edited = clone(suite) as any;
  edited.cases.find((c: any) => c.caseId === 'multidoc-burglary-claims').expect.capabilities.items[0].name = { contains: 'a weaker matcher' };
  const findings = auditGroundTruth(edited, register);
  assert.deepEqual(codes(findings), ['fingerprint_mismatch']);
  assert.match(findings[0]!.message, /CHANGELOG\.md/);
  // sources / descriptions are not expectations
  const described = clone(suite) as any;
  described.cases[0].description = 'reworded';
  assert.deepEqual(auditGroundTruth(described, register), []);
});

// ---- 3. history -------------------------------------------------------------------------------

test('historical expectations are unchanged except the recorded corrections: Step 3 (aastha-operations) and Step 4 (four producer assertions in the structured / OpenAPI cases)', async () => {
  const PRE_STEP3: Record<string, string> = {
    'synthetic-claim-rules': 'e3f18bb648927dce',
    'commercial-property-policy': 'fc7333250a689842',
    'aastha-operations': 'eaf93c35e6241f7a',
    'burglary-policy-schedule': '2384164b83638c58',
    'multidoc-burglary-claims': '6eb147408d795389',
    'structured-operation-data-flow': '9a958b11c1dbbf26',
    'openapi-operation-data-flow': '9a958b11c1dbbf26',
  };
  const POST_STEP3: Record<string, string> = { ...PRE_STEP3, 'aastha-operations': 'bbcc3cdac2c9a97c' };
  const { suite } = await load('vertical-fixtures');
  const fp = (id: string): string => expectationsFingerprint(suite.cases.find((c) => c.caseId === id)!);
  const movedSincePost3 = suite.cases.filter((c) => expectationsFingerprint(c) !== POST_STEP3[c.caseId]).map((c) => c.caseId);
  assert.deepEqual(movedSincePost3, ['structured-operation-data-flow', 'openapi-operation-data-flow'], 'only the two Step 4 cases moved after Step 3');
  assert.equal(fp('structured-operation-data-flow'), 'b294e8d762ce826c');
  assert.equal(fp('structured-operation-data-flow'), fp('openapi-operation-data-flow'), 'the two formats still carry identical expectations');

  // Undo exactly the Step 4 producer assertions and the Step 3 fingerprints are reproduced: nothing else in those cases moved.
  const undone = clone(suite) as any;
  for (const id of ['structured-operation-data-flow', 'openapi-operation-data-flow']) for (const k of undone.cases.find((c: any) => c.caseId === id).expect.capabilities.items) { assert.equal(k.producedBy, 'structured-operation'); delete k.producedBy; }
  assert.equal(expectationsFingerprint(undone.cases.find((c: any) => c.caseId === 'structured-operation-data-flow')), PRE_STEP3['structured-operation-data-flow']);

  // Undo the Step 3 correction and the pre-Step-3 fingerprint of aastha-operations is reproduced.
  const reverted = clone(suite) as any;
  const wf = reverted.cases.find((c: any) => c.caseId === 'aastha-operations').expect.workflows.items.find((w: any) => w.id === 'wf-reconciliation-tasks');
  assert.equal(wf.steps[2].contains, 'Reconcile invoice amounts vs receipt amounts');
  wf.steps[2].contains = 'Reconcile invoice amounts vs. receipt amounts';
  assert.equal(expectationsFingerprint(reverted.cases.find((c: any) => c.caseId === 'aastha-operations')), PRE_STEP3['aastha-operations']);

  const rm = await load('runtime-mechanics');
  assert.equal(expectationsFingerprint(rm.suite.cases[0]!), '3667e1c4ec1d46ed');
});

test('spuriousCapabilityAvoidance: all 10 forbidden capability traps are retained, each with a stated reason and an explicit/strongly-evidenced basis', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const traps = suite.cases.flatMap((c) => (c.expect.capabilities?.forbidden ?? []).map((f) => ({ caseId: c.caseId, ...f })));
  assert.deepEqual(
    traps.map((t) => `${t.caseId}/${t.id}`).sort(),
    [
      'burglary-policy-schedule/x-contact-no-email-id',
      'burglary-policy-schedule/x-partner-contact-row',
      'burglary-policy-schedule/x-schedule-action',
      'commercial-property-policy/x-record-action',
      'commercial-property-policy/x-review-action',
      'commercial-property-policy/x-schedule-action',
      'commercial-property-policy/x-schedule-fragment-higher-deductible',
      'commercial-property-policy/x-schedule-fragment-must-bear',
      'commercial-property-policy/x-schedule-fragment-not-excluded',
      'multidoc-burglary-claims/x-schedule-action',
    ],
  );
  for (const t of traps) {
    assert.ok((t.reason ?? '').trim().length > 0, `${t.id} has a reason`);
    const e = register.cases.find((c) => c.caseId === t.caseId)!.entries.find((x) => x.category === 'forbidden_capability' && x.id === t.id)!;
    assert.ok(e.identity === 'explicit' || e.identity === 'strongly_evidenced', `${t.id}: ${e.identity}`);
  }
});

// ---- 4. world model ---------------------------------------------------------------------------

test('open-world cases stay open and closed-world cases stay closed: the declared world of every case is pinned', async () => {
  const CLOSED = { facts: 'closed', capabilities: 'closed', workflows: 'closed' } as const;
  const OPEN = { facts: 'open', capabilities: 'open', workflows: 'open' } as const;
  const pinned: Record<string, { facts: string; capabilities: string; workflows: string; kinds?: string[] }> = {
    'synthetic-claim-rules': { ...CLOSED, kinds: ['decision_node'] },
    'commercial-property-policy': { ...OPEN, facts: 'closed', kinds: ['heuristic'] },
    'aastha-operations': { ...OPEN, capabilities: 'closed' },
    'burglary-policy-schedule': { ...OPEN },
    'multidoc-burglary-claims': { ...OPEN },
    'structured-operation-data-flow': { ...OPEN, capabilities: 'closed', workflows: 'closed' },
    'openapi-operation-data-flow': { ...OPEN, capabilities: 'closed', workflows: 'closed' },
    'runtime-mechanics': { ...OPEN, capabilities: 'closed', workflows: 'closed' },
  };
  for (const name of SUITES) {
    const { suite, register } = await load(name);
    for (const def of suite.cases) {
      const w = declaredWorld(def);
      const want = pinned[def.caseId]!;
      assert.deepEqual({ facts: w.facts.declared, capabilities: w.capabilities, workflows: w.workflows }, { facts: want.facts, capabilities: want.capabilities, workflows: want.workflows }, def.caseId);
      assert.deepEqual([...w.facts.kinds], want.kinds ?? []);
      // and the register agrees for every scope
      for (const a of register.cases.find((c) => c.caseId === def.caseId)!.world) assert.equal(a.declared, a.scope === 'facts' ? w.facts.declared : w[a.scope]);
    }
  }
});

test('flipping a world declaration in the suite (open->closed or closed->open) is caught by the audit', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const toClosed = clone(suite) as any;
  toClosed.cases.find((c: any) => c.caseId === 'multidoc-burglary-claims').expect.capabilities.closedWorld = true;
  const f1 = auditGroundTruth(toClosed, register);
  assert.ok(codes(f1).includes('world_mismatch') && codes(f1).includes('fingerprint_mismatch'), JSON.stringify(f1));
  const toOpen = clone(suite) as any;
  delete toOpen.cases.find((c: any) => c.caseId === 'synthetic-claim-rules').expect.semantics.closedWorldKinds;
  assert.ok(codes(auditGroundTruth(toOpen, register)).includes('world_mismatch'));
});

test('closed-world declarations are justified or explicitly flagged: exactly two are "questionable" (reported, not changed); every other closed scope is supported', async () => {
  const questionable: string[] = [];
  for (const name of SUITES) {
    const { register } = await load(name);
    for (const c of register.cases)
      for (const w of c.world) {
        if (w.declared === 'closed') assert.notEqual(w.support, 'not_declared', `${c.caseId}/${w.scope}`);
        if (w.support === 'questionable') questionable.push(`${c.caseId}/${w.scope}`);
        if (w.declared === 'open') assert.notEqual(w.support, 'questionable', `${c.caseId}/${w.scope}: open scopes are never over-claimed`);
      }
  }
  assert.deepEqual(questionable.sort(), ['aastha-operations/capabilities', 'commercial-property-policy/facts']);
});

test('a forbidden expectation must be evidence-based; ambiguous ground truth is never silently promoted', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const weak = clone(register) as any;
  weak.cases.find((c: any) => c.caseId === 'commercial-property-policy').entries.find((e: any) => e.id === 'x-record-action').identity = 'derived';
  assert.deepEqual(codes(auditGroundTruth(suite, weak)), ['forbidden_without_evidence']);
  const noReason = clone(suite) as any;
  delete noReason.cases.find((c: any) => c.caseId === 'commercial-property-policy').expect.capabilities.forbidden[0].reason;
  assert.ok(codes(auditGroundTruth(noReason, register)).includes('forbidden_without_reason'));
  // the ambiguous expectations are exactly the ones the audit identified, and none of them is forbidden
  const ambiguous = register.cases.flatMap((c) => c.entries.filter((e) => e.identity === 'ambiguous').map((e) => `${c.caseId}/${e.category}/${e.id}`)).sort();
  assert.deepEqual(ambiguous, [
    'aastha-operations/execution/wf-partner-payouts-escalates',
    'aastha-operations/workflow/wf-partner-payouts',
    'burglary-policy-schedule/capability/validate-policy-copy',
    'commercial-property-policy/capability/cA.H-review-not-covered-hitl',
    'commercial-property-policy/execution/H-coverage-review-human',
    'commercial-property-policy/execution/wf-hitl-review',
    'commercial-property-policy/workflow/wf-hitl-coverage-review',
  ]);
});

// ---- 5. static integrity lint -------------------------------------------------------------------

test('the committed suites pass the integrity lint (no duplicate matchers, no contradictions, no unsatisfiable name matchers)', async () => {
  for (const name of SUITES) assert.deepEqual(auditExpectationIntegrity((await load(name)).suite), [], name);
});

test('the lint catches the defect class fixed in Step 3: a name matcher with punctuation that document-derived names never contain', async () => {
  const { suite } = await load('vertical-fixtures');
  const reverted = clone(suite) as any;
  reverted.cases.find((c: any) => c.caseId === 'aastha-operations').expect.workflows.items.find((w: any) => w.id === 'wf-reconciliation-tasks').steps[2].contains = 'Reconcile invoice amounts vs. receipt amounts';
  const f = auditExpectationIntegrity(reverted);
  assert.deepEqual(f.map((x) => x.code), ['name_matcher_punctuation']);
  assert.match(f[0]!.message, /wf-reconciliation-tasks|workflow "wf-reconciliation-tasks" step 3/);

  // structured / openapi identifiers are verbatim source identifiers and are NOT linted
  const structured = clone(suite) as any;
  structured.cases.find((c: any) => c.caseId === 'structured-operation-data-flow').expect.capabilities.items[0].name = { equals: 'calculate.brokerage' };
  assert.deepEqual(auditExpectationIntegrity(structured), []);
});

test('the lint catches duplicate expectations and forbidden traps that would satisfy an expected item', async () => {
  const { suite } = await load('vertical-fixtures');
  const dup = clone(suite) as any;
  const items = dup.cases.find((c: any) => c.caseId === 'multidoc-burglary-claims').expect.capabilities.items;
  items.push({ ...clone(items[0]), id: 'ob-notify-police-again' });
  assert.deepEqual(auditExpectationIntegrity(dup).map((x) => x.code), ['duplicate_matcher']);

  const conflict = clone(suite) as any;
  const c = conflict.cases.find((x: any) => x.caseId === 'multidoc-burglary-claims');
  c.expect.capabilities.forbidden.push({ id: 'x-conflict', name: { equals: 'Notify the police immediately' }, reason: 'test' });
  assert.deepEqual(auditExpectationIntegrity(conflict).map((x) => x.code), ['forbidden_contradicts_expected']);

  const factDup = clone(suite) as any;
  const facts = factDup.cases.find((x: any) => x.caseId === 'multidoc-burglary-claims').expect.semantics.facts;
  facts.push({ ...clone(facts[0]), id: 'definition-again' });
  assert.deepEqual(auditExpectationIntegrity(factDup).map((x) => x.code), ['duplicate_matcher']);
});

// ---- 6. matching against the real pipeline ------------------------------------------------------

test('golden matching is sufficient for the current expectations: every expectation has at most one candidate and no observed item satisfies two expectations (all 8 cases, real pipeline)', async () => {
  for (const name of SUITES) {
    const { suite, sourceRoot } = await load(name);
    for (const def of suite.cases) {
      const obs = await observeCase(def, { sourceRoot });
      const claimedBy = new Map<string, string[]>();
      for (const k of def.expect.capabilities?.items ?? []) {
        const cands = obs.capabilities.filter((c) => matchesName(c.name, k.name));
        assert.ok(cands.length <= 1, `${def.caseId}/${k.id}: ${cands.length} candidates`);
        for (const c of cands) claimedBy.set(`cap|${c.capabilityId}`, [...(claimedBy.get(`cap|${c.capabilityId}`) ?? []), k.id]);
      }
      for (const f of def.expect.semantics?.facts ?? []) {
        const cands = obs.nodes.filter((n) => n.kind === f.kind && evalAll(n.properties, f.identify));
        assert.ok(cands.length <= 1, `${def.caseId}/${f.id}: ${cands.length} candidates`);
        for (const n of cands) claimedBy.set(`fact|${n.id}`, [...(claimedBy.get(`fact|${n.id}`) ?? []), f.id]);
      }
      for (const [k, v] of claimedBy) assert.equal(v.length, 1, `${def.caseId}: ${k} satisfies ${v.join(', ')}`);
    }
  }
});

test('a name matcher that can never match cannot be told apart from a genuine miss by the report alone — but the lint and the punctuation-stripped probe agree on the one historical instance', async () => {
  const { suite, sourceRoot } = await load('vertical-fixtures');
  const def = suite.cases.find((c) => c.caseId === 'aastha-operations')!;
  const obs = await observeCase(def, { sourceRoot });
  const names = obs.capabilities.map((c) => c.name);
  assert.ok(names.some((n) => matchesName(n, { contains: 'Reconcile invoice amounts vs receipt amounts' })));
  assert.ok(!names.some((n) => matchesName(n, { contains: 'Reconcile invoice amounts vs. receipt amounts' })), 'no capability name carries the period');
});

// ---- 7. determinism and purity ------------------------------------------------------------------

test('fingerprints, listings and the strict parser are deterministic and order-independent', async () => {
  const { suite, register } = await load('vertical-fixtures');
  const def = suite.cases.find((c) => c.caseId === 'commercial-property-policy')!;
  assert.equal(expectationsFingerprint(def), expectationsFingerprint(clone(def)));
  const shuffled = clone(def) as any;
  shuffled.expect.capabilities.items.reverse();
  assert.notEqual(expectationsFingerprint(shuffled), expectationsFingerprint(def), 'list order is part of the golden definition, so reordering is a visible edit');
  assert.equal(canonicalJson(listExpectations(def)), canonicalJson(listExpectations(shuffled)), 'the listing is sorted, so it never depends on order');
  assert.equal(canonicalJson(parseGroundTruth(register)), canonicalJson(parseGroundTruth(clone(register))));
});

test('the register is benchmark ground-truth provenance only: nothing in the evaluation path imports it', async () => {
  for (const f of ['evaluate', 'metrics', 'report', 'compare', 'attribution', 'observe', 'observation', 'evaluation-model', 'definition', 'match']) {
    const src = await readFile(join(PKG, 'src', `${f}.ts`), 'utf8');
    assert.ok(!/ground-truth/.test(src), `${f}.ts must not depend on the register`);
  }
});
