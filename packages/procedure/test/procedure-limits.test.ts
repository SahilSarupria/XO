import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProcedure,
  parseStrictJson,
  procedureHash,
  lowerToWorkflowGraph,
  MAX_PROCEDURE_BYTES,
  MAX_PROCEDURE_DEPTH,
  MAX_PROCEDURE_STEPS,
  utf8ByteLengthExceeds,
} from '../src/index.js';

// P1.1 N-10 (owner-approved 2026-10-18): 262,144 UTF-8 bytes; depth 16 (root container = 1); 25 entries in `steps`.
// Hand-built corpus (no compiler-proven fixture exists yet).

const chain = (n: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'xo.procedure/1',
    procedureId: 'p',
    version: 1,
    steps: Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      kind: 'capability',
      capabilityId: 'c',
      ...(i < n - 1 ? { next: `s${i + 1}` } : {}),
    })),
    ...extra,
  });
const codes = (raw: string | Uint8Array): string[] => {
  const r = validateProcedure(raw);
  return r.ok ? [] : r.findings.map((f) => f.code);
};
const doc = (title: string): string =>
  `{"schema":"xo.procedure/1","procedureId":"p","version":1,"title":${JSON.stringify(title)},"steps":[{"id":"a","kind":"capability","capabilityId":"c"}]}`;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Build a valid document of exactly `target` UTF-8 bytes using `unit` (1-4 byte chars) padding plus ASCII filler. */
function docOfBytes(target: number, unit = 'x'): string {
  const fixed = bytes(doc(''));
  const room = target - fixed;
  const ub = bytes(unit);
  const k = Math.floor(room / ub);
  let title = unit.repeat(k) + 'x'.repeat(room - k * ub);
  if (title.length === 0) title = 'x';
  const out = doc(title);
  assert.equal(bytes(out), target, 'test helper must hit the exact byte count');
  return out;
}

test('N-10 constants are exactly the owner-approved values and are not caller-configurable', () => {
  assert.equal(MAX_PROCEDURE_BYTES, 262144);
  assert.equal(MAX_PROCEDURE_DEPTH, 16);
  assert.equal(MAX_PROCEDURE_STEPS, 25);
  // extra arguments (an attempted "options" override) are ignored
  const over = chain(26);
  const r = (validateProcedure as unknown as (x: string, o: unknown) => ReturnType<typeof validateProcedure>)(over, {
    maxSteps: 1000,
    maxBytes: 1e9,
    maxDepth: 1000,
  });
  assert.equal(r.ok, false);
  // and a document-supplied `limits` is still a rejected authority field
  assert.ok(codes(chain(2, { limits: { maxSteps: 1000 } })).includes('PROC_AUTHORITY_FIELD'));
});

test('N-10 size: below / exactly at / one over 262,144 UTF-8 bytes (string input)', () => {
  assert.equal(validateProcedure(docOfBytes(MAX_PROCEDURE_BYTES - 1)).ok, true);
  assert.equal(validateProcedure(docOfBytes(MAX_PROCEDURE_BYTES)).ok, true);
  assert.deepEqual(codes(docOfBytes(MAX_PROCEDURE_BYTES + 1)), ['PROC_BODY_TOO_LARGE']);
});

test('N-10 size: byte (Uint8Array) input is checked on byteLength BEFORE decoding', () => {
  const enc = new TextEncoder();
  assert.equal(validateProcedure(enc.encode(docOfBytes(MAX_PROCEDURE_BYTES))).ok, true);
  assert.deepEqual(codes(enc.encode(docOfBytes(MAX_PROCEDURE_BYTES + 1))), ['PROC_BODY_TOO_LARGE']);
  // oversize AND invalid UTF-8: the size verdict wins, proving the check precedes decoding
  const bad = new Uint8Array(MAX_PROCEDURE_BYTES + 1).fill(0xff);
  assert.deepEqual(codes(bad), ['PROC_BODY_TOO_LARGE']);
  // in-limit invalid UTF-8 still reports the encoding error
  assert.deepEqual(codes(new Uint8Array([0xff, 0xfe])), ['PROC_INVALID_ENCODING']);
});

test('N-10 size: multi-byte Unicode is counted in UTF-8 bytes, not UTF-16 length', () => {
  // 90,000 euro signs = 90,000 UTF-16 units (< limit) but 270,000 UTF-8 bytes (> limit)
  const euros = doc('€'.repeat(90_000));
  assert.ok(euros.length < MAX_PROCEDURE_BYTES && bytes(euros) > MAX_PROCEDURE_BYTES);
  assert.deepEqual(codes(euros), ['PROC_BODY_TOO_LARGE']);
  // 70,000 emoji = 140,000 UTF-16 units but 280,000 bytes
  const emoji = doc('😀'.repeat(70_000));
  assert.ok(emoji.length < MAX_PROCEDURE_BYTES && bytes(emoji) > MAX_PROCEDURE_BYTES);
  assert.deepEqual(codes(emoji), ['PROC_BODY_TOO_LARGE']);
  // exactly at / one over using 2-, 3- and 4-byte units
  for (const unit of ['é', '€', '😀']) {
    assert.equal(validateProcedure(docOfBytes(MAX_PROCEDURE_BYTES, unit)).ok, true, `${unit} at limit`);
    assert.deepEqual(codes(docOfBytes(MAX_PROCEDURE_BYTES + 1, unit)), ['PROC_BODY_TOO_LARGE'], `${unit} over`);
  }
  // string and byte inputs agree
  const at = docOfBytes(MAX_PROCEDURE_BYTES, '€');
  assert.equal(validateProcedure(new TextEncoder().encode(at)).ok, validateProcedure(at).ok);
});

test('N-10 size: byte-length helper agrees with Buffer.byteLength incl. surrogate pairs and lone surrogates', () => {
  const samples = ['', 'abc', 'é', '€', '😀', 'a😀b', '\ud800', 'x\udc00y', '\ud83d', '😀\ud83d', '\u0000\u007f\u0080\u07ff\u0800\uffff'];
  for (const s of samples) {
    const n = bytes(s);
    assert.equal(utf8ByteLengthExceeds(s, n), false, `${JSON.stringify(s)} at cap`);
    if (n > 0) assert.equal(utf8ByteLengthExceeds(s, n - 1), true, `${JSON.stringify(s)} over cap`);
  }
  // a raw lone surrogate inside a document counts as 3 bytes (as TextEncoder would emit U+FFFD)
  const raw = docOfBytes(MAX_PROCEDURE_BYTES - 3).replace('"x', '"\ud800x'); // inserts one lone surrogate = +3 bytes
  assert.equal(bytes(raw), MAX_PROCEDURE_BYTES);
  assert.equal(codes(raw).includes('PROC_BODY_TOO_LARGE'), false);
  assert.deepEqual(codes(`${raw.slice(0, -1)} ${raw.slice(-1)}`), ['PROC_BODY_TOO_LARGE']);
});

test('N-10 depth: root container = depth 1; 16 accepted, 17 rejected (valid document, objects, arrays)', () => {
  // valid document: root 1, steps 2, step 3, condition 4, then `value` nested arrays occupy depths 5..16
  const withValue = (levels: number): string => {
    const nested = '['.repeat(levels) + ']'.repeat(levels);
    return `{"schema":"xo.procedure/1","procedureId":"p","version":1,"steps":[{"id":"d","kind":"decision","condition":{"path":"input.x","op":"eq","value":${nested}},"then":"a","else":"a"},{"id":"a","kind":"capability","capabilityId":"c"}]}`;
  };
  // then/else share one target => the second edge is redundant but structurally valid
  const ok = validateProcedure(withValue(12)); // depths 5..16
  assert.equal(ok.ok, true);
  assert.deepEqual(codes(withValue(13)), ['PROC_TOO_DEEP']); // depth 17
  assert.deepEqual(codes(withValue(11)).includes('PROC_TOO_DEEP'), false);
  // bare nesting
  const objs = (n: number): string => '{"a":'.repeat(n - 1) + '{}' + '}'.repeat(n - 1);
  assert.equal(codes(objs(16)).includes('PROC_TOO_DEEP'), false);
  assert.ok(codes(objs(16)).includes('PROC_UNKNOWN_FIELD'));
  assert.deepEqual(codes(objs(17)), ['PROC_TOO_DEEP']);
  assert.deepEqual(codes('['.repeat(16) + ']'.repeat(16)), ['PROC_NOT_AN_OBJECT']);
  assert.deepEqual(codes('['.repeat(17) + ']'.repeat(17)), ['PROC_TOO_DEEP']);
  // brackets inside strings never count as nesting
  assert.equal(codes(doc('['.repeat(5000))).length, 0);
  assert.equal(codes(doc('{"[[[[[[[[[[[[[[[[[[[[[[[[')).length, 0);
});

test('N-10 depth: extreme nesting (within and beyond the byte cap) is rejected without stack overflow or throw', () => {
  const within = '['.repeat(100_000); // 100 KB, unterminated: depth limit hits first
  assert.deepEqual(codes(within), ['PROC_TOO_DEEP']);
  assert.deepEqual(codes('['.repeat(MAX_PROCEDURE_BYTES + 10)), ['PROC_BODY_TOO_LARGE']);
  assert.deepEqual(codes('{"a":'.repeat(50_000)), ['PROC_TOO_DEEP']);
  assert.doesNotThrow(() => validateProcedure('['.repeat(250_000) + ']'.repeat(250_000)));
});

test('N-10 steps: 24 / exactly 25 accepted, 26 rejected; only the top-level steps array counts', () => {
  assert.equal(validateProcedure(chain(24)).ok, true);
  assert.equal(validateProcedure(chain(MAX_PROCEDURE_STEPS)).ok, true);
  assert.deepEqual(codes(chain(26)), ['PROC_TOO_MANY_STEPS']);
  assert.deepEqual(codes(chain(1000)), ['PROC_TOO_MANY_STEPS']);
  // unrelated large arrays are not steps
  const unrelated = JSON.parse(chain(2));
  unrelated.unknowns = Array.from({ length: 500 }, (_, i) => `u${i}`);
  assert.equal(validateProcedure(JSON.stringify(unrelated)).ok, true);
  const nested = JSON.parse(chain(2));
  nested.steps[0].evidence = Array.from({ length: 100 }, () => ({ documentPath: 'd' }));
  assert.equal(validateProcedure(JSON.stringify(nested)).ok, true);
  // a nested key literally named "steps" (inside a condition value) is not the steps array
  const sneaky = `{"schema":"xo.procedure/1","procedureId":"p","version":1,"steps":[{"id":"d","kind":"decision","condition":{"path":"input.x","op":"eq","value":{"steps":[${Array.from({ length: 60 }, () => '1').join(',')}]}},"then":"a","else":"a"},{"id":"a","kind":"capability","capabilityId":"c"}]}`;
  assert.equal(codes(sneaky).includes('PROC_TOO_MANY_STEPS'), false);
  // elements are counted regardless of their type; arrays inside entries do not add to the count
  const mixed = `{"steps":[${Array.from({ length: 26 }, (_, i) => (i % 2 ? '[1,2,3]' : '{}')).join(',')}]}`;
  assert.deepEqual(codes(mixed), ['PROC_TOO_MANY_STEPS']);
  const nestedArrays = `{"steps":[${Array.from({ length: 25 }, () => '[1,2,3,4,5]').join(',')}]}`;
  assert.equal(codes(nestedArrays).includes('PROC_TOO_MANY_STEPS'), false);
  // the key may be written with escapes; it is the decoded key at the root that counts
  const escaped = `{"\\u0073teps":[${Array.from({ length: 26 }, () => '1').join(',')}]}`;
  assert.deepEqual(codes(escaped), ['PROC_TOO_MANY_STEPS']);
  // steps appearing under an array root are not the top-level steps array
  assert.equal(codes(`[{"steps":[${Array.from({ length: 60 }, () => '1').join(',')}]}]`).includes('PROC_TOO_MANY_STEPS'), false);
});

test('N-10 steps and malformed JSON: deterministic by scan order, never throws', () => {
  const entries = (n: number): string => Array.from({ length: n }, () => '1').join(',');
  // limit reached before the syntax error => limit code
  assert.deepEqual(codes(`{"steps":[${entries(26)}`), ['PROC_TOO_MANY_STEPS']);
  assert.deepEqual(codes(`{"steps":[${entries(26)} @@@`), ['PROC_TOO_MANY_STEPS']);
  // syntax error before the 26th entry => invalid JSON
  assert.deepEqual(codes(`{"steps":[${entries(10)},,`), ['PROC_INVALID_JSON']);
  assert.deepEqual(codes(`{"steps":[${entries(25)},]}`), ['PROC_INVALID_JSON']); // trailing comma after 25
  assert.deepEqual(codes(`{"steps":[${entries(25)},@]}`), ['PROC_INVALID_JSON']);
  // exactly 25 followed by truncation is malformed, not "too many"
  assert.deepEqual(codes(`{"steps":[${entries(25)}`), ['PROC_INVALID_JSON']);
  // strings with escaped quotes/brackets inside entries
  const tricky = Array.from({ length: 25 }, () => '"a\\"],[\\\\"').join(',');
  assert.equal(codes(`{"steps":[${tricky}]}`).includes('PROC_TOO_MANY_STEPS'), false);
  assert.equal(parseStrictJson(`{"steps":[${tricky}]}`).ok, true);
  for (const bad of ['{"steps":', '{"steps":[', '{"steps":[1,', '{"steps"', '{"a":[[[[[[[[[[[[[[[[[[', '{"steps":[{"x":[']) {
    assert.doesNotThrow(() => validateProcedure(bad));
  }
});

test('N-10 limit findings are stable, constant-path, and never echo input', () => {
  const secret = 'SECRET-9f3a-limit';
  const big = validateProcedure(docOfBytes(MAX_PROCEDURE_BYTES + 1).replace('"x', `"${secret}`));
  assert.deepEqual(big, { ok: false, findings: [{ code: 'PROC_BODY_TOO_LARGE', path: '' }] });
  const deep = validateProcedure(`{"${secret}":`.repeat(20));
  assert.deepEqual(deep, { ok: false, findings: [{ code: 'PROC_TOO_DEEP', path: '' }] });
  const many = validateProcedure(`{"steps":[${Array.from({ length: 26 }, () => `"${secret}"`).join(',')}]}`);
  assert.deepEqual(many, { ok: false, findings: [{ code: 'PROC_TOO_MANY_STEPS', path: '/steps' }] });
  for (const r of [big, deep, many]) assert.equal(JSON.stringify(r).includes(secret), false);
});

test('N-10 limit-bearing duplicates/forbidden keys: limit failure is the only finding (fail-fast)', () => {
  const r = validateProcedure(`{"__proto__":1,"a":1,"a":2,"steps":[${Array.from({ length: 26 }, () => '1').join(',')}]}`);
  assert.deepEqual(r, { ok: false, findings: [{ code: 'PROC_TOO_MANY_STEPS', path: '/steps' }] });
});

test('N-10 in-contract documents: canonical hash and lowering unchanged by the limits', () => {
  const r = validateProcedure(chain(MAX_PROCEDURE_STEPS));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.procedureHash, procedureHash(JSON.parse(chain(MAX_PROCEDURE_STEPS))));
  const spaced = validateProcedure(JSON.stringify(JSON.parse(chain(MAX_PROCEDURE_STEPS)), null, 2));
  assert.ok(spaced.ok && spaced.procedureHash === r.procedureHash);
  const g = lowerToWorkflowGraph(r.definition);
  assert.equal(g.nodes.length, MAX_PROCEDURE_STEPS + 2);
  assert.equal(g.edges.length, MAX_PROCEDURE_STEPS + 1);
});

// ---- schema reconciliation (owner decisions 3, 4, 5 of 2026-10-18) ----

test('`next` is sequence-by-edge: validated (string, existing step, no decision `next`) and lowered to one edge or to __end', () => {
  const mk = (steps: unknown[]) => JSON.stringify({ schema: 'xo.procedure/1', procedureId: 'p', version: 1, steps });
  const cap = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'capability', capabilityId: 'c', ...extra });
  assert.ok(codes(mk([cap('a', { next: 5 })])).includes('PROC_INVALID_FIELD'));
  assert.ok(codes(mk([cap('a', { next: '' })])).includes('PROC_INVALID_FIELD'));
  assert.ok(codes(mk([cap('a', { next: 'ghost' })])).includes('PROC_DANGLING_EDGE'));
  assert.ok(codes(mk([cap('a', { next: 'a' })])).some((c) => c === 'PROC_GRAPH_CYCLE' || c === 'PROC_AMBIGUOUS_ORDER'));
  const dec = { id: 'd', kind: 'decision', condition: { path: 'input.x', op: 'truthy' }, then: 'a', else: 'b', next: 'a' };
  assert.ok(codes(mk([dec, cap('a'), cap('b')])).includes('PROC_UNKNOWN_FIELD'));
  const r = validateProcedure(mk([cap('a', { next: 'b' }), cap('b')]));
  assert.ok(r.ok);
  if (!r.ok) return;
  const g = lowerToWorkflowGraph(r.definition);
  const out = (id: string) => g.edges.filter((e) => e.from === id).map((e) => e.to);
  assert.deepEqual(out('a'), ['b']);
  assert.deepEqual(out('b'), ['__end']);
  assert.deepEqual(out('__start'), ['a']);
});

test('malformed conditions / bindings / evidence never crash validation', () => {
  const dec = (condition: unknown) =>
    JSON.stringify({
      schema: 'xo.procedure/1',
      procedureId: 'p',
      version: 1,
      steps: [
        { id: 'd', kind: 'decision', condition, then: 'a', else: 'a' },
        { id: 'a', kind: 'capability', capabilityId: 'c' },
      ],
    });
  for (const c of [
    null,
    5,
    'x',
    [],
    [1],
    {},
    { path: 5 },
    { path: 'input.x' },
    { path: 'input.x', op: 'nope' },
    { path: ['a'], op: 'eq', value: 1 },
    { path: 'input.x', op: 'gt', value: 'a' },
    { path: 'steps.', op: 'exists' },
    { path: '..', op: 'exists' },
  ]) {
    const r = validateProcedure(dec(c));
    assert.equal(r.ok, false, JSON.stringify(c));
  }
  const cap = (extra: unknown) =>
    JSON.stringify({
      schema: 'xo.procedure/1',
      procedureId: 'p',
      version: 1,
      steps: [{ id: 'a', kind: 'capability', capabilityId: 'c', ...(extra as object) }],
    });
  for (const e of [
    { inputBindings: [null] },
    { inputBindings: [{}] },
    { inputBindings: [{ param: 'p', from: null }] },
    { inputBindings: [{ param: 'p', from: {} }] },
    { inputBindings: [{ param: 'p', from: { step: 5 } }] },
    { inputBindings: 'x' },
    { evidence: [null] },
    { evidence: [{}] },
    { evidence: [{ documentPath: 'd', sectionPath: [1] }] },
  ]) {
    assert.equal(validateProcedure(cap(e)).ok, false, JSON.stringify(e));
  }
});

test('inputs / outputs blocks stay rejected in M1 (owner decision 4; discrepancy with Revised Plan example recorded)', () => {
  assert.ok(codes(chain(2, { inputs: { schema: { type: 'object' } } })).includes('PROC_UNKNOWN_FIELD'));
  assert.ok(codes(chain(2, { outputs: { schema: { type: 'object' } } })).includes('PROC_UNKNOWN_FIELD'));
});

test('compilationRef is shape-checked only in M1 (owner decision 5 / O-4)', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  assert.ok(validateProcedure(chain(2, { compilationRef: { compilationId: 'cmp_1', graphHash: hash } })).ok);
  assert.ok(codes(chain(2, { compilationRef: { compilationId: 'cmp_1', graphHash: 'nope' } })).includes('PROC_INVALID_FIELD'));
  assert.ok(codes(chain(2, { compilationRef: { compilationId: 'cmp_1' } })).includes('PROC_MISSING_FIELD'));
});
