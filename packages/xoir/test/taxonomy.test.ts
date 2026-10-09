import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import {
  LEGACY_NODE_KIND_MIGRATION,
  isLegacyNodeKind,
  migrateLegacyNodeKind,
  type CanonicalXoirNodeKind,
} from '../src/node-kinds.js';
import { isCoreXoirEdgeKind, type CoreXoirEdgeKind, type ExtendedXoirEdgeKind } from '../src/edge-kinds.js';
import { validateGraph } from '../src/validation.js';

const CANONICAL_NODE_KINDS: readonly CanonicalXoirNodeKind[] = [
  'concept',
  'fact',
  'heuristic',
  'decision_node',
  'reasoning_step',
  'preference',
  'risk_policy',
  'escalation_rule',
  'failure_case',
  'success_pattern',
  'capability',
  'constraint',
  'safety_policy',
  'memory_unit',
  'evaluation_artifact',
];

const MINIMAL_PROPS_BY_CANONICAL_KIND: Readonly<Record<CanonicalXoirNodeKind, Record<string, unknown>>> = {
  concept: { definition: 'A thing.' },
  fact: { statement: 'It is so.', domain: 'general' },
  heuristic: { condition: 'if x', action: 'do y' },
  decision_node: { question: 'q', outcome: 'o', rationale: 'r' },
  reasoning_step: { premise: 'p', conclusion: 'c' },
  preference: { dimension: 'tone', value: 'formal' },
  risk_policy: { domain: 'privacy', toleranceLevel: 'low' },
  escalation_rule: { triggerCondition: 't', escalationTarget: 'human' },
  failure_case: { scenario: 's', rootCause: 'rc' },
  success_pattern: { scenario: 's' },
  capability: { name: 'Draft NDA', description: 'Drafts an NDA.' },
  constraint: { rule: 'must cite jurisdiction', severity: 'blocking' },
  safety_policy: { policy: 'no unauthorized advice', trigger: 'legal advice request', action: 'block' },
  memory_unit: { content: 'client prefers formal tone', scope: 'long_term' },
  evaluation_artifact: { input: 'draft an nda', expectedBehavior: 'produces valid nda' },
};

test('every canonical node kind can be created, added, and passes validation', () => {
  const graph = XoirGraph.create(XoirGraphId('g-taxonomy'));
  for (const kind of CANONICAL_NODE_KINDS) {
    const result = graph.createAndAddNode({
      id: XoirNodeId(`n-${kind}`),
      kind,
      properties: MINIMAL_PROPS_BY_CANONICAL_KIND[kind],
    });
    assert.ok(result.ok, `expected ${kind} to be constructible`);
  }
  const report = validateGraph(graph);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test('every canonical node kind missing its required property is flagged by validation', () => {
  for (const kind of CANONICAL_NODE_KINDS) {
    const graph = XoirGraph.create(XoirGraphId(`g-missing-${kind}`));
    const added = graph.createAndAddNode({ id: XoirNodeId('n1'), kind, properties: {} });
    assert.ok(added.ok);
    const report = validateGraph(graph);
    assert.equal(report.valid, false, `expected ${kind} with empty properties to be invalid`);
    assert.ok(report.issues.some((i) => i.kind === 'missing_required_property'));
  }
});

test('custom:<name> node kinds remain valid and unconstrained', () => {
  const graph = XoirGraph.create(XoirGraphId('g-custom'));
  const result = graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'custom:jurisdiction-profile', properties: { anything: 'goes' } });
  assert.ok(result.ok);
  assert.equal(validateGraph(graph).valid, true);
});

test('subtype is a metadata-level classification distinct from kind', () => {
  const graph = XoirGraph.create(XoirGraphId('g-subtype'));
  const result = graph.createAndAddNode({
    id: XoirNodeId('n1'),
    kind: 'concept',
    properties: { definition: 'A company.' },
    subtype: 'organization',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.kind, 'concept');
  assert.equal(result.value.metadata.subtype, 'organization');
});

test('every legacy node kind has a documented migration entry (possibly ambiguous/undefined)', () => {
  const legacyKinds = Object.keys(LEGACY_NODE_KIND_MIGRATION);
  assert.deepEqual(
    legacyKinds.sort(),
    [
      'knowledge',
      'reasoning',
      'decision',
      'memory',
      'evaluation',
      'benchmark',
      'prompt_strategy',
      'case_study',
      'metadata',
      'provenance',
      'license',
      'identity',
      'version',
    ].sort(),
  );
});

test('unambiguous legacy kinds migrate to their canonical successor', () => {
  assert.equal(migrateLegacyNodeKind('reasoning'), 'reasoning_step');
  assert.equal(migrateLegacyNodeKind('decision'), 'decision_node');
  assert.equal(migrateLegacyNodeKind('memory'), 'memory_unit');
  assert.equal(migrateLegacyNodeKind('evaluation'), 'evaluation_artifact');
  assert.equal(migrateLegacyNodeKind('benchmark'), 'evaluation_artifact');
});

test('ambiguous legacy kinds (content-dependent) migrate to undefined rather than guessing', () => {
  assert.equal(migrateLegacyNodeKind('knowledge'), undefined);
  assert.equal(migrateLegacyNodeKind('case_study'), undefined);
});

test('package/registry-layer legacy kinds migrate to undefined (they leave semantic XOIR entirely)', () => {
  for (const kind of ['metadata', 'provenance', 'license', 'identity', 'version'] as const) {
    assert.equal(migrateLegacyNodeKind(kind), undefined);
  }
});

test('isLegacyNodeKind distinguishes legacy from canonical/custom kinds', () => {
  assert.equal(isLegacyNodeKind('knowledge'), true);
  assert.equal(isLegacyNodeKind('capability'), false); // canonical, not legacy
  assert.equal(isLegacyNodeKind('custom:foo'), false);
});

test('legacy node kinds already covered by an equivalent canonical kind (capability/constraint/safety_policy) are unchanged, not duplicated', () => {
  // These three were already canonical pre-reconciliation; there is exactly one of each, not a legacy+canonical pair.
  assert.equal(('capability' as CanonicalXoirNodeKind) === 'capability', true);
  assert.equal(Object.prototype.hasOwnProperty.call(LEGACY_NODE_KIND_MIGRATION, 'capability'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(LEGACY_NODE_KIND_MIGRATION, 'constraint'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(LEGACY_NODE_KIND_MIGRATION, 'safety_policy'), false);
});

test('old graphs built purely from legacy node kinds still validate (backward compatibility)', () => {
  const graph = XoirGraph.create(XoirGraphId('g-legacy'));
  const added = graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  assert.ok(added.ok);
  assert.equal(validateGraph(graph).valid, true);
});

const CORE_EDGE_KINDS: readonly CoreXoirEdgeKind[] = [
  'REQUIRES',
  'CONTRADICTS',
  'SUPPORTS',
  'REFINES',
  'SUPERSEDES',
  'ESCALATES_TO',
  'TRIGGERED_BY',
  'CO_OCCURS_WITH',
  'DERIVED_FROM',
  'COMPOSES_INTO',
];

test('every canonical core edge kind can connect two generic nodes and validates', () => {
  for (const kind of CORE_EDGE_KINDS) {
    const graph = XoirGraph.create(XoirGraphId(`g-edge-${kind}`));
    graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'capability', properties: { name: 'A', description: 'a' } });
    graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'capability', properties: { name: 'B', description: 'b' } });
    const edgeResult = graph.createAndAddEdge({ id: XoirEdgeId(`e-${kind}`), kind, fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
    assert.ok(edgeResult.ok, `expected ${kind} edge to be constructible`);
    assert.equal(validateGraph(graph).valid, true, `expected ${kind} edge between two capabilities to validate: ${JSON.stringify(validateGraph(graph).issues)}`);
  }
});

test('isCoreXoirEdgeKind distinguishes the 10 canonical relationships from extended/domain ones', () => {
  for (const kind of CORE_EDGE_KINDS) {
    assert.equal(isCoreXoirEdgeKind(kind), true);
  }
  const extended: readonly ExtendedXoirEdgeKind[] = ['DEPENDS_ON', 'DEFINES', 'PART_OF', 'PRODUCES', 'CONSUMES', 'USES'];
  for (const kind of extended) {
    assert.equal(isCoreXoirEdgeKind(kind), false);
  }
});

test('COMPOSES_INTO is constrained to capability -> capability; an incompatible endpoint fails validation', () => {
  const graph = XoirGraph.create(XoirGraphId('g-composes-into'));
  graph.createAndAddNode({ id: XoirNodeId('cap'), kind: 'capability', properties: { name: 'Cap', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('fact'), kind: 'fact', properties: { statement: 's', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'COMPOSES_INTO', fromId: XoirNodeId('cap'), toId: XoirNodeId('fact') });
  const report = validateGraph(graph);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.kind === 'incompatible_edge_endpoint'));
});

test('ESCALATES_TO must terminate at an escalation_rule or capability node', () => {
  const graph = XoirGraph.create(XoirGraphId('g-escalates-to'));
  graph.createAndAddNode({ id: XoirNodeId('rule'), kind: 'risk_policy', properties: { domain: 'd', toleranceLevel: 'low' } });
  graph.createAndAddNode({ id: XoirNodeId('bad-target'), kind: 'fact', properties: { statement: 's', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'ESCALATES_TO', fromId: XoirNodeId('rule'), toId: XoirNodeId('bad-target') });
  const report = validateGraph(graph);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.kind === 'incompatible_edge_endpoint'));

  const graph2 = XoirGraph.create(XoirGraphId('g-escalates-to-2'));
  graph2.createAndAddNode({ id: XoirNodeId('rule'), kind: 'risk_policy', properties: { domain: 'd', toleranceLevel: 'low' } });
  graph2.createAndAddNode({ id: XoirNodeId('target'), kind: 'escalation_rule', properties: { triggerCondition: 't', escalationTarget: 'human' } });
  graph2.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'ESCALATES_TO', fromId: XoirNodeId('rule'), toId: XoirNodeId('target') });
  assert.equal(validateGraph(graph2).valid, true);
});

test('extended/domain edge kinds carried over from Stage 4/5 (e.g. DEFINES, PRODUCES, CONSUMES) are unconstrained and valid', () => {
  const graph = XoirGraph.create(XoirGraphId('g-extended-edges'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'b' } });
  for (const kind of ['DEFINES', 'PART_OF', 'PRODUCES', 'CONSUMES', 'EXTENDS', 'COMPLEMENTS', 'INVOKES', 'ENABLES', 'CONFLICTS_WITH', 'GOVERNS', 'CAUSES', 'MITIGATES', 'MEASURES', 'OWNED_BY', 'LOCATED_IN', 'BELONGS_TO', 'VERSION_OF'] as const) {
    const result = graph.createAndAddEdge({ id: XoirEdgeId(`e-${kind}`), kind, fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
    assert.ok(result.ok, `expected ${kind} to be constructible`);
  }
  assert.equal(validateGraph(graph).valid, true);
});

test('ALTERNATIVE_TO (Stage 7 addition) is a valid, unconstrained extended edge kind between two decision_node candidates', () => {
  const graph = XoirGraph.create(XoirGraphId('g-alternative-to'));
  graph.createAndAddNode({ id: XoirNodeId('optionA'), kind: 'decision_node', properties: { question: 'q', outcome: 'A', rationale: 'r' } });
  graph.createAndAddNode({ id: XoirNodeId('optionB'), kind: 'decision_node', properties: { question: 'q', outcome: 'B', rationale: 'r' } });
  const result = graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'ALTERNATIVE_TO', fromId: XoirNodeId('optionA'), toId: XoirNodeId('optionB') });
  assert.ok(result.ok);
  assert.equal(validateGraph(graph).valid, true);
});
