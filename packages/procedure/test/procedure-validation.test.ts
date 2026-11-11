import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateProcedure, procedureHash, canonicalJson, lowerToWorkflowGraph, parseStrictJson } from '../src/index.js';

// Hand-built corpus (labelled as such: no compiler-proven fixture exists yet; O-9/M3).
const base = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'xo.procedure/1',
    procedureId: 'claim-threshold-review',
    version: 1,
    steps: [
      { id: 's1', kind: 'capability', capabilityId: 'cap_a', basis: 'author_asserted', next: 'd1' },
      { id: 'd1', kind: 'decision', condition: { path: 'steps.s1.output.matched', op: 'eq', value: true }, then: 's2', else: 's3' },
      {
        id: 's2',
        kind: 'capability',
        capabilityId: 'cap_b',
        inputBindings: [{ param: 'matched', from: { step: 's1', output: 'matched' }, bindingStatus: 'proven' }],
      },
      { id: 's3', kind: 'capability', capabilityId: 'cap_c', effectIntent: 'write' },
    ],
    unknowns: ['Who may review is not defined.'],
    ...over,
  });
const codes = (raw: string | Uint8Array): string[] => {
  const r = validateProcedure(raw);
  return r.ok ? [] : r.findings.map((f) => f.code);
};
const withStep = (extra: Record<string, unknown>): string => {
  const d = JSON.parse(base());
  Object.assign(d.steps[0], extra);
  return JSON.stringify(d);
};

test('positive: valid corpus accepted; unknowns and basis preserved', () => {
  const r = validateProcedure(base());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.definition.unknowns, ['Who may review is not defined.']);
  assert.equal(r.definition.steps[0]?.kind === 'capability' && r.definition.steps[0].basis, 'author_asserted');
  assert.match(r.procedureHash, /^sha256:[0-9a-f]{64}$/);
});

test('positive: hash determinism across key order and whitespace; changes with content', () => {
  const a = validateProcedure(base());
  const reordered = JSON.stringify(JSON.parse(base()), null, 4).replace(/"schema": "xo.procedure\/1",/, '"schema":   "xo.procedure/1",');
  const obj = JSON.parse(base());
  const shuffled = JSON.stringify({
    steps: obj.steps,
    unknowns: obj.unknowns,
    version: 1,
    procedureId: obj.procedureId,
    schema: obj.schema,
  });
  const b = validateProcedure(reordered);
  const c = validateProcedure(shuffled);
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) {
    assert.equal(a.procedureHash, b.procedureHash);
    assert.equal(a.procedureHash, c.procedureHash);
  }
  const d = validateProcedure(base({ version: 2 }));
  assert.ok(d.ok && a.ok && d.procedureHash !== a.procedureHash);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  // no Unicode normalisation: NFC vs NFD differ
  assert.notEqual(procedureHash({ t: '\u00e9' }), procedureHash({ t: 'e\u0301' }));
});

test('positive: lowering produces the expected WorkflowGraph; nothing executes', () => {
  const r = validateProcedure(base());
  assert.ok(r.ok);
  if (!r.ok) return;
  const g = lowerToWorkflowGraph(r.definition);
  assert.equal(g.graphId, 'claim-threshold-review');
  assert.equal(g.startNodeId, '__start');
  assert.deepEqual(
    g.nodes.map((n) => `${n.id}:${n.type}`),
    ['__start:start', '__end:end', 's1:capability', 'd1:decision', 's2:capability', 's3:capability'],
  );
  const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('d1', 's2')?.condition, { kind: 'expression', field: 's1.matched', operator: 'eq', value: true });
  assert.equal(edge('d1', 's3')?.condition, undefined);
  assert.ok(edge('__start', 's1') && edge('s2', '__end') && edge('s3', '__end'));
  assert.ok(g.edges.every((e) => e.condition === undefined || e.condition.kind === 'expression'));
  assert.deepEqual(JSON.parse(JSON.stringify(g)), g); // plain serialisable data
});

test('N-1 / O-2: authority-bearing fields rejected (permissions, humanGate, responsibility, effectKey, limits, effect, ...)', () => {
  for (const f of [
    'requiredPermissions',
    'permissions',
    'humanGate',
    'responsibility',
    'effectKey',
    'effect',
    'effectClass',
    'approvedBy',
    'approvalState',
    'bindingId',
    'trustLevel',
    'executable',
    'validated',
    'principal',
  ]) {
    assert.ok(codes(withStep({ [f]: f === 'humanGate' ? true : [] })).includes('PROC_AUTHORITY_FIELD'), f);
  }
  assert.ok(codes(base({ limits: { maxSteps: 99 } })).includes('PROC_AUTHORITY_FIELD'), 'client limits rejected');
  assert.ok(codes(base({ capabilities: [] })).includes('PROC_AUTHORITY_FIELD'));
});

test('N-4: inline capability definition / implementationClass rejected; unknown fields rejected', () => {
  assert.ok(codes(withStep({ implementationClass: 'deterministic_rule' })).includes('PROC_AUTHORITY_FIELD'));
  assert.ok(codes(withStep({ inputSchema: {} })).includes('PROC_AUTHORITY_FIELD'));
  assert.ok(codes(withStep({ surprise: 1 })).includes('PROC_UNKNOWN_FIELD'));
  assert.ok(codes(base({ surprise: 1 })).includes('PROC_UNKNOWN_FIELD'));
});

test('effectIntent is advisory only: read|write accepted, anything else rejected, no authority conferred', () => {
  assert.ok(validateProcedure(withStep({ effectIntent: 'read' })).ok);
  assert.ok(validateProcedure(withStep({ effectIntent: 'write' })).ok);
  assert.ok(codes(withStep({ effectIntent: 'none' })).includes('PROC_INVALID_FIELD'));
  const r = validateProcedure(withStep({ effectIntent: 'read' }));
  assert.ok(r.ok);
  if (r.ok)
    assert.equal(
      lowerToWorkflowGraph(r.definition).nodes.some((n) => n.config && 'effectIntent' in n.config),
      false,
    );
});

test('schema version and node kind allowlists', () => {
  assert.ok(codes(base({ schema: 'xo.procedure/2' })).includes('PROC_UNSUPPORTED_SCHEMA'));
  assert.ok(codes(base({ schema: undefined })).includes('PROC_MISSING_FIELD'));
  const kinds = ['loop', 'parallel', 'merge', 'delay', 'subworkflow', 'predicate', 'custom:x'];
  for (const k of kinds) {
    const d = JSON.parse(base());
    d.steps[0].kind = k;
    assert.ok(codes(JSON.stringify(d)).includes('PROC_UNSUPPORTED_NODE'), k);
  }
  for (const k of ['model', 'ai_provider', 'hybrid']) {
    const d = JSON.parse(base());
    d.steps[0].kind = k;
    assert.ok(codes(JSON.stringify(d)).includes('PROC_AI_STEP_DISABLED'), k);
  }
  const p = JSON.parse(base());
  p.steps[1].condition = { kind: 'predicate', evaluate: 'x' };
  assert.ok(codes(JSON.stringify(p)).includes('PROC_UNKNOWN_FIELD'));
});

test('N-5: cycle / unreachable / dangling else / ambiguous order / duplicate ids / empty', () => {
  const mk = (steps: unknown[]) => JSON.stringify({ schema: 'xo.procedure/1', procedureId: 'p', version: 1, steps });
  const cap = (id: string, next?: string) => ({ id, kind: 'capability', capabilityId: 'c', ...(next ? { next } : {}) });
  assert.ok(codes(mk([cap('a', 'b'), cap('b', 'a')])).some((c) => c === 'PROC_GRAPH_CYCLE' || c === 'PROC_AMBIGUOUS_ORDER'));
  assert.ok(codes(mk([cap('e', 'a'), cap('a', 'b'), cap('b', 'a')])).includes('PROC_GRAPH_CYCLE'));
  assert.ok(codes(mk([cap('a'), cap('b')])).includes('PROC_AMBIGUOUS_ORDER'));
  assert.ok(codes(mk([cap('a', 'zzz')])).includes('PROC_DANGLING_EDGE'));
  assert.ok(
    codes(mk([{ id: 'd', kind: 'decision', condition: { path: 'input.x', op: 'truthy' }, then: 'a' }, cap('a')])).includes(
      'PROC_MISSING_FIELD',
    ),
  );
  assert.ok(
    codes(mk([{ id: 'd', kind: 'decision', condition: { path: 'input.x', op: 'truthy' }, then: 'a', else: 'nope' }, cap('a')])).includes(
      'PROC_DANGLING_EDGE',
    ),
  );
  assert.ok(codes(mk([cap('a'), cap('a')])).includes('PROC_DUPLICATE_ID'));
  assert.ok(codes(mk([])).includes('PROC_EMPTY'));
});

test('reference integrity (local): bindings and condition paths reference real, upstream steps', () => {
  const d = JSON.parse(base());
  d.steps[2].inputBindings[0].from.step = 'ghost';
  assert.ok(codes(JSON.stringify(d)).includes('PROC_DANGLING_REFERENCE'));
  const e = JSON.parse(base());
  e.steps[0].inputBindings = [{ param: 'x', from: { step: 's3', output: 'y' } }]; // s3 is downstream of s1
  assert.ok(codes(JSON.stringify(e)).includes('PROC_BINDING_NOT_UPSTREAM'));
  const f = JSON.parse(base());
  f.steps[1].condition.path = 'steps.ghost.output.matched';
  assert.ok(codes(JSON.stringify(f)).includes('PROC_DANGLING_REFERENCE'));
  const g = JSON.parse(base());
  g.steps[2].inputBindings[0].bindingStatus = 'author_asserted'; // requires reason
  assert.ok(codes(JSON.stringify(g)).includes('PROC_MISSING_FIELD'));
});

test('O-4: registry-dependent checks are NOT performed in M1 (documented by test)', () => {
  const d = JSON.parse(base());
  d.compilationRef = { compilationId: 'cmp_1', graphHash: `sha256:${'0'.repeat(64)}` };
  d.steps[0].capabilityId = 'cap_does_not_exist_anywhere';
  assert.ok(validateProcedure(JSON.stringify(d)).ok, 'unknown capability / drifted hash cannot be detected without the server registry');
});

test('N-11 / boundary: __proto__, constructor, prototype keys rejected at any depth; duplicate keys detected on raw text', () => {
  assert.ok(codes('{"__proto__":{"x":1},"schema":"xo.procedure/1"}').includes('PROC_FORBIDDEN_KEY'));
  const nested = base().replace('"basis":"author_asserted"', '"basis":"author_asserted","constructor":{"prototype":{}}');
  assert.ok(codes(nested).includes('PROC_FORBIDDEN_KEY'));
  assert.ok(codes(withStep({ prototype: 1 })).includes('PROC_FORBIDDEN_KEY'));
  assert.ok(codes('{"schema":"xo.procedure/1","schema":"xo.procedure/1"}').includes('PROC_DUPLICATE_KEY'));
  assert.ok(codes('{"a":{"b":1,"b":2}}').includes('PROC_DUPLICATE_KEY'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('boundary: __proto__/constructor/prototype path SEGMENTS rejected in conditions, bindings, when/then', () => {
  for (const seg of ['__proto__', 'constructor', 'prototype']) {
    const a = JSON.parse(base());
    a.steps[1].condition.path = `steps.s1.output.${seg}`;
    assert.ok(codes(JSON.stringify(a)).includes('PROC_FORBIDDEN_KEY'), `decision ${seg}`);
    const b = JSON.parse(base());
    b.when = [{ path: `input.${seg}`, op: 'exists' }];
    assert.ok(codes(JSON.stringify(b)).includes('PROC_FORBIDDEN_KEY'), `when ${seg}`);
    const c = JSON.parse(base());
    c.then = [{ path: `input.a.${seg}.b`, op: 'exists' }];
    assert.ok(codes(JSON.stringify(c)).includes('PROC_FORBIDDEN_KEY'), `then ${seg}`);
    const d = JSON.parse(base());
    d.steps[2].inputBindings[0].from = { input: `x.${seg}` };
    assert.ok(codes(JSON.stringify(d)).includes('PROC_FORBIDDEN_KEY'), `binding ${seg}`);
    const e = JSON.parse(base());
    e.steps[2].inputBindings[0].from = { step: 's1', output: seg };
    assert.ok(codes(JSON.stringify(e)).includes('PROC_FORBIDDEN_KEY'), `binding-output ${seg}`);
    const f = JSON.parse(base());
    f.steps[0].id = seg;
    assert.ok(codes(JSON.stringify(f)).length > 0, `step id ${seg}`);
  }
});

test('invalid encodings and malformed JSON: stable codes, never throw', () => {
  assert.deepEqual(codes(new Uint8Array([0xff, 0xfe, 0x00])), ['PROC_INVALID_ENCODING']);
  assert.deepEqual(codes(`\uFEFF${base()}`), ['PROC_INVALID_ENCODING']);
  assert.deepEqual(codes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), ['PROC_INVALID_ENCODING']);
  for (const bad of ['', '{', '{"a":}', '[1,]', '{"a":1,}', '{"a" 1}', 'nul', '01', '"\\x"', '{"a":1} x', "{'a':1}"])
    assert.deepEqual(codes(bad), ['PROC_INVALID_JSON'], JSON.stringify(bad));
  assert.ok(parseStrictJson('{"a":[1,2,{"b":null}],"c":"\\u00e9\\n"}').ok);
});

test('N-14 (local half): findings contain only code + JSON pointer, never submitted values', () => {
  const secret = 'SECRET-VALUE-9f3a';
  const raw = withStep({ permissions: [secret], surprise: secret, capabilityId: undefined });
  const r = validateProcedure(raw);
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r).includes(secret), false);
});

test('fuzz (seeded, fixed): only stable codes, never throws or hangs', () => {
  let s = 1234567;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = '{}[]":,.-0123456789abtrunfsl\\ \n_';
  const known = new Set([
    'PROC_BODY_TOO_LARGE',
    'PROC_TOO_DEEP',
    'PROC_TOO_MANY_STEPS',
    'PROC_INVALID_ENCODING',
    'PROC_INVALID_JSON',
    'PROC_DUPLICATE_KEY',
    'PROC_FORBIDDEN_KEY',
    'PROC_NOT_AN_OBJECT',
    'PROC_UNKNOWN_FIELD',
    'PROC_AUTHORITY_FIELD',
    'PROC_MISSING_FIELD',
    'PROC_INVALID_FIELD',
    'PROC_UNSUPPORTED_SCHEMA',
    'PROC_UNSUPPORTED_NODE',
    'PROC_AI_STEP_DISABLED',
    'PROC_DUPLICATE_ID',
    'PROC_INVALID_PATH',
    'PROC_INVALID_CONDITION',
    'PROC_DANGLING_EDGE',
    'PROC_DANGLING_REFERENCE',
    'PROC_BINDING_NOT_UPSTREAM',
    'PROC_GRAPH_CYCLE',
    'PROC_UNREACHABLE',
    'PROC_AMBIGUOUS_ORDER',
    'PROC_EMPTY',
  ]);
  const seed = base();
  for (let n = 0; n < 3000; n++) {
    let t = n % 2 === 0 ? seed : '';
    const edits = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < edits; k++) {
      const pos = Math.floor(rnd() * (t.length + 1));
      const ch = alphabet[Math.floor(rnd() * alphabet.length)] as string;
      t = rnd() < 0.5 ? t.slice(0, pos) + ch + t.slice(pos) : t.slice(0, pos) + t.slice(pos + 1);
    }
    const r = validateProcedure(t);
    if (!r.ok) for (const f of r.findings) assert.ok(known.has(f.code), f.code);
  }
});

test('no-side-effect proof: spies; fetch/net/http stubbed to throw during parse, validate, lower', () => {
  const g = globalThis as unknown as { fetch: unknown };
  const realFetch = g.fetch;
  const realConnect = net.connect;
  const realRequest = http.request;
  let calls = 0;
  const boom = (): never => {
    calls++;
    throw new Error('I/O attempted');
  };
  g.fetch = boom;
  (net as { connect: unknown }).connect = boom;
  (http as { request: unknown }).request = boom;
  try {
    const r = validateProcedure(base());
    assert.ok(r.ok);
    if (r.ok) lowerToWorkflowGraph(r.definition);
    validateProcedure(withStep({ permissions: [] }));
  } finally {
    g.fetch = realFetch;
    (net as { connect: unknown }).connect = realConnect;
    (http as { request: unknown }).request = realRequest;
  }
  assert.equal(calls, 0);
});

test('no-side-effect proof: src/** imports no I/O, runtime execution entry points, or provider packages', () => {
  const dir = new URL('../src/', import.meta.url).pathname;
  const banned =
    /from\s+['"](node:(fs|http|https|net|dns|child_process|worker_threads|tls|dgram)|fs|http|https|net|child_process|@xo\/(registry|registry-core|ai-core|storage)|openai|@anthropic-ai\/[^'"]+)['"]/;
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.equal(banned.test(src), false, f);
    assert.equal(/\bfetch\s*\(/.test(src), false, `${f} calls fetch`);
    for (const m of src.matchAll(/from\s+['"]@xo\/runtime['"]/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      assert.match(line, /^import type /, `${f}: @xo/runtime may only be imported type-only`);
    }
  }
});

test('reference integrity (local, M1 re-audit): decisions produce no output; `when` cannot read step outputs; decision conditions must read upstream steps', () => {
  const a = JSON.parse(base());
  a.steps[2].inputBindings[0].from = { step: 'd1', output: 'matched' }; // d1 is a decision
  assert.ok(codes(JSON.stringify(a)).includes('PROC_DANGLING_REFERENCE'));
  const b = JSON.parse(base());
  b.when = [{ path: 'steps.s1.output.matched', op: 'truthy' }];
  assert.ok(codes(JSON.stringify(b)).includes('PROC_INVALID_PATH'));
  const c = JSON.parse(base());
  c.steps[1].condition.path = 'steps.s3.output.settled'; // s3 is downstream of d1
  assert.ok(codes(JSON.stringify(c)).includes('PROC_BINDING_NOT_UPSTREAM'));
  const d = JSON.parse(base());
  d.then = [{ path: 'steps.d1.output.x', op: 'exists' }];
  assert.ok(codes(JSON.stringify(d)).includes('PROC_DANGLING_REFERENCE'));
  const e = JSON.parse(base());
  e.then = [{ path: 'steps.s3.output.settled', op: 'eq', value: true }];
  assert.ok(validateProcedure(JSON.stringify(e)).ok, 'postcondition on a capability step is accepted');
});
