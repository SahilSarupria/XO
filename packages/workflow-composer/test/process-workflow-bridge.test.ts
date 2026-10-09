import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { composeWorkflows } from '../src/compose.js';
import {
  buildReconciliationSectionFixtureGraph,
  buildMixedEvidenceFixtureGraph,
  buildProcessWithNoCapabilitiesFixtureGraph,
} from './fixtures/reconciliation-fixture.js';
import { buildCorporateLawyerFixtureGraph } from './fixtures/corporate-lawyer-fixture.js';

test('process realization -> workflow composition bridge', async (t) => {
  await t.test('a realized process (shared section, COMPLEMENTS-only evidence) composes into one candidate workflow', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    const [wf] = result.value;
    assert.equal(wf.steps.length, 3);
    assert.deepEqual(
      wf.steps.map((s) => s.capabilityId).sort(),
      ['cap_compare_expected_actual', 'cap_obtain_statement', 'cap_reconcile_records'].sort(),
    );
  });

  await t.test('ordering within COMPLEMENTS-only process falls back to tie-break without false dependency', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [wf] = result.value;
    const middle = wf.steps.find((s) => s.capabilityId === 'cap_reconcile_records')!;
    assert.deepEqual(middle.rationale.orderedAfter, []); // no real dependency evidence
    assert.equal(middle.rationale.tieBroken, true); // ambiguous precedence resolved by tie-break
  });

  await t.test('ambiguous_precedence gap is recorded when only COMPLEMENTS evidence exists', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [wf] = result.value;
    const kinds = wf.gaps.map((g) => g.kind).sort();
    assert.deepEqual(kinds, ['ambiguous_precedence']);
  });

  await t.test('process identity (sectionPath) is preserved on the composed workflow, verbatim from source provenance', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [wf] = result.value;
    assert.deepEqual(wf.processGrouping?.sectionPath, ['Reconciliation Operations Manual', '3. Brokerage Reconciliation']);
    assert.equal(wf.processGrouping?.processConceptNodeId, 'kn_section_heading');
    assert.equal(wf.processGrouping?.capabilityCount, 3);
  });

  await t.test('a real dependency edge still outranks tie-break when present', () => {
    const graph = buildMixedEvidenceFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const dependencyWorkflow = result.value.find((wf) => wf.steps.some((s) => s.capabilityId === 'cap_verify_brokerage'))!;
    const verify = dependencyWorkflow.steps.find((s) => s.capabilityId === 'cap_verify_brokerage')!;
    assert.deepEqual(
      verify.rationale.orderedAfter.map((o) => o.capabilityId),
      ['cap_map_records'],
    );
    assert.equal(verify.rationale.tieBroken, false);
  });

  await t.test('a capability from an unrelated document section is never composed into the same workflow', () => {
    const graph = buildMixedEvidenceFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 2); // {map_records, verify_brokerage} and {unrelated_section} — never merged
    const unrelatedWorkflow = result.value.find((wf) => wf.steps.length === 1)!;
    assert.equal(unrelatedWorkflow.steps[0]!.capabilityId, 'cap_unrelated_section');
    assert.deepEqual(unrelatedWorkflow.processGrouping?.sectionPath, ['Manual', '4. Financial Accounting']); // a single-step workflow trivially "agrees" with its own section path
  });

  await t.test('cross-unit / cross-section capabilities never share one processGrouping', () => {
    const graph = buildMixedEvidenceFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sectionPaths = result.value.map((wf) => wf.processGrouping?.sectionPath);
    assert.deepEqual(sectionPaths, [['Manual', '3. Brokerage Reconciliation'], ['Manual', '4. Financial Accounting']]);
  });

  await t.test('a process concept node with no associated capabilities produces no workflow at all', () => {
    const graph = buildProcessWithNoCapabilitiesFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, []); // no hallucinated workflow from the process concept alone
  });

  await t.test('composition remains deterministic across repeated runs on the same graph', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const first = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    const second = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);
  });

  await t.test('pre-existing capability-graph composition (no section/COMPLEMENTS evidence at all) is unaffected', () => {
    const graph = buildCorporateLawyerFixtureGraph();
    const result = composeWorkflows(graph, { now: () => '2026-01-01T00:00:00.000Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Same two components as before this change: the six-capability review pipeline, and the standalone citation_lookup.
    assert.equal(result.value.length, 2);
    const mainWorkflow = result.value.find((wf) => wf.steps.length === 6)!;
    assert.ok(mainWorkflow);
    assert.equal(mainWorkflow.processGrouping, undefined); // this fixture's nodes carry no sectionPath at all
  });
});
