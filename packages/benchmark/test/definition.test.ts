import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSuiteDefinition } from '../src/definition.js';
import { loadSuiteFile } from '../src/load.js';

const validCase = (over: Record<string, unknown> = {}) => ({ caseId: 'c1', sources: [{ kind: 'document', path: 'a.txt' }], expect: {}, ...over });
const suite = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, suiteId: 's', cases: [validCase()], ...over });

function issuesOf(raw: unknown): string[] {
  const r = validateSuiteDefinition(raw);
  assert.equal(r.ok, false, 'expected the definition to be rejected');
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

test('a minimal and a rich definition are accepted and normalized', () => {
  assert.equal(validateSuiteDefinition(suite()).ok, true);
  const rich = validateSuiteDefinition(
    suite({
      description: 'd',
      sourceRoot: '../..',
      cases: [
        validCase({
          domainHint: 'insurance',
          expect: {
            compile: { outcome: 'succeeds' },
            semantics: { closedWorldKinds: ['heuristic'], facts: [{ id: 'f', kind: 'heuristic', identify: [{ path: 'condition', contains: 'x' }], assert: [{ path: 'action', equals: 'y' }], evidence: { pages: [1], minSourceRefs: 1, documentPath: 'a.txt' } }], forbidden: [{ id: 'nf', kind: 'concept', identify: [{ path: 'definition', equals: 'It' }] }] },
            capabilities: { closedWorld: true, items: [{ id: 'k', name: { equals: 'A' }, resolution: 'resolved', executionClass: 'deterministic_rule', inputs: ['a'], outputs: [] }], forbidden: [{ id: 'nk', name: { contains: 'Junk' } }] },
            workflows: { closedWorld: true, items: [{ id: 'w', steps: [{ equals: 'A' }, { equals: 'B' }], ordered: true, executability: 'executable_candidate', stepClasses: ['deterministic_rule', 'human_in_the_loop'], dataFlow: { closedWorld: true, bindings: [{ producer: { equals: 'A' }, output: 'o', consumer: { equals: 'B' }, input: 'i', status: 'proven' }] } }] },
          },
          execution: [
            { id: 'e1', kind: 'capability', target: { equals: 'A' }, input: { a: 1 }, expect: { outcome: 'succeeded', output: { matched: true } } },
            { id: 'e2', kind: 'workflow', steps: [{ equals: 'A' }], expect: { status: 'waiting_for_human', steps: [{ capability: { equals: 'A' }, outputStatus: 'escalation_required' }], injections: [{ producer: { equals: 'A' }, output: 'o', consumer: { equals: 'B' }, input: 'i' }] } },
          ],
        }),
      ],
    }),
  );
  assert.equal(rich.ok, true, JSON.stringify(rich));
});

test('an EMPTY suite (no cases) is valid — it simply measures nothing', () => {
  const r = validateSuiteDefinition(suite({ cases: [] }));
  assert.equal(r.ok && r.value.cases.length, 0);
});

test('malformed definitions are rejected with precise JSON paths, never partially accepted', () => {
  const cases: [string, unknown, RegExp][] = [
    ['not an object', [], /^\$: must be an object/],
    ['null', null, /^\$: must be an object/],
    ['wrong schemaVersion', suite({ schemaVersion: 2 }), /\$\.schemaVersion: must be 1/],
    ['missing suiteId', { schemaVersion: 1, cases: [] }, /\$\.suiteId: must be a non-empty string/],
    ['cases not an array', suite({ cases: {} }), /\$\.cases: must be an array/],
    ['unknown top-level field', suite({ extra: 1 }), /\$\.extra: unknown field/],
    ['case without id', suite({ cases: [{ sources: [{ kind: 'document', path: 'a' }], expect: {} }] }), /\$\.cases\[0\]\.caseId: must be a non-empty string/],
    ['case with neither sources nor xoir', suite({ cases: [{ caseId: 'c', expect: {} }] }), /exactly one of "sources" or "xoir"/],
    ['case with both sources and xoir', suite({ cases: [validCase({ xoir: 'g.json' })] }), /exactly one of "sources" or "xoir"/],
    ['empty sources', suite({ cases: [validCase({ sources: [] })] }), /\$\.cases\[0\]\.sources: must contain at least 1 item/],
    ['unknown source kind', suite({ cases: [validCase({ sources: [{ kind: 'docx', path: 'a' }] })] }), /sources\[0\]\.kind: must be one of/],
    ['structured source without format', suite({ cases: [validCase({ sources: [{ kind: 'structured', path: 'a.json' }] })] }), /sources\[0\]\.format: is required when kind is "structured"/],
    ['format on a non-structured source', suite({ cases: [validCase({ sources: [{ kind: 'pdf', path: 'a.pdf', format: 'json' }] })] }), /format: is only valid when kind is "structured"/],
    ['path traversal', suite({ cases: [validCase({ sources: [{ kind: 'pdf', path: '../secret.pdf' }] })] }), /must be a relative path without "\.\." segments/],
    ['absolute path', suite({ cases: [validCase({ sources: [{ kind: 'pdf', path: '/etc/passwd' }] })] }), /must be a relative path/],
    ['duplicate case ids', suite({ cases: [validCase(), validCase()] }), /\$\.cases\[1\]\.caseId: duplicate caseId "c1"/],
    ['fact without identify predicates', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'concept', identify: [] }] } } })] }), /identify: must contain at least 1 item/],
    ['predicate with two operators', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'concept', identify: [{ path: 'a', equals: 1, contains: 'x' }] }] } } })] }), /exactly one of "equals", "contains", "exists"/],
    ['predicate with no operator', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'concept', identify: [{ path: 'a' }] }] } } })] }), /exactly one of "equals", "contains", "exists"/],
    ['predicate with unknown field', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'concept', identify: [{ path: 'a', equals: 1, regex: '.*' }] }] } } })] }), /identify\[0\]\.regex: unknown field/],
    ['duplicate fact ids', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'k', identify: [{ path: 'a', exists: true }] }, { id: 'f', kind: 'k', identify: [{ path: 'a', exists: true }] }] } } })] }), /facts\[1\]\.id: duplicate id "f"/],
    ['bad enum: resolution', suite({ cases: [validCase({ expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, resolution: 'maybe' }] } } })] }), /resolution: must be one of: resolved, unresolved, ambiguous, denied/],
    ['bad enum: executionClass', suite({ cases: [validCase({ expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, executionClass: 'model' }] } } })] }), /executionClass: must be one of/],
    ['contradictory resolution/class', suite({ cases: [validCase({ expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A' }, resolution: 'unresolved', executionClass: 'deterministic_rule' }] } } })] }), /incompatible with executionClass/],
    ['name matcher with both operators', suite({ cases: [validCase({ expect: { capabilities: { items: [{ id: 'k', name: { equals: 'A', contains: 'B' } }] } } })] }), /must have exactly one of "equals" or "contains"/],
    ['stepClasses without ordered', suite({ cases: [validCase({ expect: { workflows: { items: [{ id: 'w', steps: [{ equals: 'A' }], stepClasses: ['deterministic_rule'] }] } } })] }), /stepClasses: requires "ordered": true/],
    ['stepClasses of the wrong length', suite({ cases: [validCase({ expect: { workflows: { items: [{ id: 'w', ordered: true, steps: [{ equals: 'A' }, { equals: 'B' }], stepClasses: ['deterministic_rule'] }] } } })] }), /must have one class per step \(2\)/],
    ['workflow without steps', suite({ cases: [validCase({ expect: { workflows: { items: [{ id: 'w', steps: [] }] } } })] }), /steps: must contain at least 1 item/],
    ['data-flow status not in the enum', suite({ cases: [validCase({ expect: { workflows: { items: [{ id: 'w', steps: [{ equals: 'A' }], dataFlow: { bindings: [{ producer: { equals: 'A' }, output: 'o', consumer: { equals: 'B' }, input: 'i', status: 'suggestive' }] } }] } } })] }), /status: must be one of: proven, not_proven/],
    ['evidence with a non-positive page', suite({ cases: [validCase({ expect: { semantics: { facts: [{ id: 'f', kind: 'k', identify: [{ path: 'a', exists: true }], evidence: { pages: [0] } }] } } })] }), /pages\[0\]: must be a positive integer page number/],
    ['execution case of unknown kind', suite({ cases: [validCase({ execution: [{ id: 'e', kind: 'shell', expect: {} }] })] }), /execution\[0\]\.kind: must be one of: capability, workflow/],
    ['execution outcome not in the enum', suite({ cases: [validCase({ execution: [{ id: 'e', kind: 'capability', target: { equals: 'A' }, expect: { outcome: 'ok' } }] })] }), /expect\.outcome: must be one of/],
    ['execution input not an object', suite({ cases: [validCase({ execution: [{ id: 'e', kind: 'capability', target: { equals: 'A' }, input: [1], expect: { outcome: 'succeeded' } }] })] }), /execution\[0\]\.input: must be an object/],
    ['duplicate execution ids', suite({ cases: [validCase({ execution: [{ id: 'e', kind: 'capability', target: { equals: 'A' }, expect: { outcome: 'succeeded' } }, { id: 'e', kind: 'capability', target: { equals: 'A' }, expect: { outcome: 'succeeded' } }] })] }), /execution\[1\]\.id: duplicate id "e"/],
    ['unknown compile outcome', suite({ cases: [validCase({ expect: { compile: { outcome: 'explodes' } } })] }), /compile\.outcome: must be one of: succeeds, fails/],
    ['unknown field inside expect', suite({ cases: [validCase({ expect: { vibes: 'good' } })] }), /expect\.vibes: unknown field/],
  ];
  for (const [label, raw, pattern] of cases) {
    const issues = issuesOf(raw);
    assert.ok(issues.some((i) => pattern.test(i)), `${label}: expected an issue matching ${pattern}; got:\n  ${issues.join('\n  ')}`);
  }
});

test('all problems in a definition are reported together (not just the first)', () => {
  const issues = issuesOf(suite({ suiteId: '', cases: [validCase({ sources: [{ kind: 'nope', path: '' }] }), validCase({ caseId: 'c2', xoir: '../x' })] }));
  assert.ok(issues.length >= 4, issues.join('\n'));
});

test('loadSuiteFile: unreadable file, invalid JSON and invalid definition are distinct, structured failures; a valid file resolves its sourceRoot against its own directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-bm-def-'));
  try {
    const missing = await loadSuiteFile(join(dir, 'nope.json'));
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.message : '', /cannot read suite file/);

    await writeFile(join(dir, 'bad.json'), '{ not json');
    const notJson = await loadSuiteFile(join(dir, 'bad.json'));
    assert.match(!notJson.ok ? notJson.message : '', /is not valid JSON/);

    await writeFile(join(dir, 'invalid.json'), JSON.stringify({ schemaVersion: 1, suiteId: 's', cases: [{ caseId: 'c' }] }));
    const invalid = await loadSuiteFile(join(dir, 'invalid.json'));
    assert.equal(invalid.ok, false);
    assert.ok(!invalid.ok && invalid.issues.length > 0);
    assert.match(!invalid.ok ? invalid.message : '', /not a valid benchmark definition/);

    await writeFile(join(dir, 'ok.json'), JSON.stringify(suite({ sourceRoot: 'sub' })));
    const ok = await loadSuiteFile(join(dir, 'ok.json'));
    assert.equal(ok.ok && ok.sourceRoot, join(dir, 'sub'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
