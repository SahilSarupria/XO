import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';
import { computeSemanticQualityReport } from '../../src/pipeline/quality-metrics.js';
import { packageXoirGraph } from '../../src/pipeline/packager.js';
import { PackageValidator } from '@xo/package-sdk';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/synthetic-property-policy.txt', import.meta.url));

/**
 * A small, hand-labeled semantic-quality benchmark (Problem B §11): for
 * one representative, realistic-shaped policy document, this pins down
 * exactly which capability names a correct extractor should and should
 * not produce. This is an evaluation fixture only — nothing in
 * `rule-based-extractor.ts` or `candidate-plausibility.ts` was written
 * by looking at this specific word list; every rejection signal there is
 * justified on its own structural terms (see that module's doc
 * comments). This benchmark exists to catch a *regression* in either
 * direction — a real capability silently disappearing, or an artifact
 * silently creeping back in — not to define correctness after the fact.
 *
 * M1.1 update: `'Reject The Claim'` was added to this list once
 * `../../src/capabilities/rule-capability-minter.ts` shipped. This
 * fixture's one clean, single-comparison decision rule ("If the claim
 * assessment amount exceeds 5000, then reject the claim.") is exactly
 * the shape that module mints a dedicated capability for — the same
 * mechanism that makes the real insurance-policy `> INR 100,000` rule
 * independently executable now also fires here, which is the intended,
 * document-agnostic behavior, not a fixture-specific special case. The
 * pre-existing `'Claim Assessment'` title-derived capability (which
 * this same rule was already linked to before M1.1, via the ordinary
 * same-unit evidence linker) is unchanged and still present.
 *
 * Bug-fix pass update: `'Contact the claims department'` and `'Send a
 * confirmation notice'` became `'Contact the claims department within 30
 * days'` and `'Send a confirmation notice to the policyholder'`. This is
 * `rule-based-extractor.ts`'s object-window widening (previously a
 * hardcoded 3-word cutoff truncated every name after exactly 3 words,
 * regardless of where the sentence's actual content ended) — verified
 * against the fixture's own source sentences ("Contact the claims
 * department within 30 days of any loss event.", "Send a confirmation
 * notice to the policyholder upon issuance of this policy.") that these
 * are the accurate, un-truncated object phrases, not new or different
 * capabilities. Same 4 genuine names, same counts throughout this file —
 * only the two previously-truncated names changed.
 *
 * Human-in-the-Loop Execution Class Lowering milestone update: the two
 * imperative-obligation capabilities above ("Contact the claims
 * department...", "Send a confirmation notice...") were always
 * *discovered* but, before this milestone, stayed *unresolved* — they
 * have no linked decision_node/heuristic rule, but ARE linked (via
 * `REQUIRES`) to Stage 4's own action-shaped knowledge nodes for exactly
 * these two imperative sentences, giving them `actionKnowledgeRefs`.
 * `ActionEscalationBindingResolver` (Action Capability Binding v1,
 * unmodified) has always resolved contracts in that shape to
 * `human_in_the_loop`; what changed is that `capability-lowering.ts` now
 * (a) includes that resolver in its default list and (b) knows how to
 * lower a `human_in_the_loop` outcome into a manifest declaration — so
 * both obligations now resolve and lower, alongside the two
 * `deterministic_rule` capabilities that were already resolving. This is
 * not new extraction, linking, or resolution behavior; it is the
 * previously-missing last step finally reaching capabilities this
 * fixture already legitimately produced.
 */
const EXPECTED_GENUINE_CAPABILITY_NAMES = ['Claim Assessment', 'Contact the claims department within 30 days', 'Send a confirmation notice to the policyholder', 'Reject The Claim'];

/** Every one of these was deliberately planted as PDF/table-extraction-style noise in the fixture (see its own comments); none should ever produce a capability, under any name containing these fragments. */
const PLANTED_ARTIFACT_FRAGMENTS = ['Region', 'Renewal', 'PlanOpted', 'and8827461093', 'Contact and'];

async function compileFixture() {
  const text = await readFile(FIXTURE_PATH, 'utf8');
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'synthetic-property-policy.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('quality benchmark: discovers exactly the genuine capabilities, zero planted artifacts', async () => {
  const compiled = await compileFixture();
  const lowered = lowerCapabilitiesToManifest(compiled.graph);
  const names = lowered.outcomes.map((o) => o.name).sort();

  assert.deepEqual(names, [...EXPECTED_GENUINE_CAPABILITY_NAMES].sort());

  for (const fragment of PLANTED_ARTIFACT_FRAGMENTS) {
    assert.ok(
      names.every((n) => !n.includes(fragment)),
      `no discovered capability name should contain the planted artifact fragment "${fragment}", got: ${JSON.stringify(names)}`,
    );
  }
});

test('quality benchmark: false-positive capability rate is 0 against the planted-noise/genuine ratio (4 noise items, 4 genuine — 3 surface forms + 1 M1.1 rule-minted capability from the same clean rule —, 4 discovered)', async () => {
  const compiled = await compileFixture();
  const lowered = lowerCapabilitiesToManifest(compiled.graph);
  // 4 deliberately-planted artifacts (Region(E), Renewal(s), PlanOpted(Yes / No), the digit-mashed partner-contact line) + 3 genuine action sentences/headings + 1 M1.1-minted rule-level capability (see EXPECTED_GENUINE_CAPABILITY_NAMES' doc comment) = a correct extractor discovers exactly the 4 genuine ones.
  assert.equal(lowered.discoveredCount, 4);
  const falsePositives = lowered.outcomes.filter((o) => !EXPECTED_GENUINE_CAPABILITY_NAMES.includes(o.name));
  assert.equal(falsePositives.length, 0);
});

test('quality benchmark: rule extraction finds the genuine numeric threshold rule and resolves it — as part of "Claim Assessment", as its own M1.1-minted "Reject The Claim" capability, and (Human-in-the-Loop Execution Class Lowering milestone) the two non-numeric obligations now resolve too, as human_in_the_loop', async () => {
  const compiled = await compileFixture();
  const lowered = lowerCapabilitiesToManifest(compiled.graph);
  assert.equal(lowered.resolvedCount, 4);
  assert.deepEqual(
    lowered.declarations.map((d) => d.name).sort(),
    ['Claim Assessment', 'Contact the claims department within 30 days', 'Reject The Claim', 'Send a confirmation notice to the policyholder'],
  );
  assert.deepEqual(
    lowered.declarations.map((d) => ({ name: d.name, mode: d.execution?.mode })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'Claim Assessment', mode: 'deterministic_rule' },
      { name: 'Contact the claims department within 30 days', mode: 'human_in_the_loop' },
      { name: 'Reject The Claim', mode: 'deterministic_rule' },
      { name: 'Send a confirmation notice to the policyholder', mode: 'human_in_the_loop' },
    ],
  );

  const unresolved = lowered.outcomes.filter((o) => o.status === 'unresolved').map((o) => o.name).sort();
  assert.deepEqual(unresolved, [], 'no capability in this fixture remains unresolved now that human_in_the_loop bindings are lowerable');
});

test('quality benchmark: exclusions and warranties are discovered as constraint-kind XOIR nodes, not lost and not miscategorized as capabilities', async () => {
  const compiled = await compileFixture();
  const report = computeSemanticQualityReport(compiled.graph);
  // 2 exclusions + 2 warranties + 1 "subject to" conditional obligation = 5 from this fixture's reasoning patterns (a 6th may come from this compiler's separate, pre-existing knowledge-side constraint extraction — this assertion only pins the floor this task's own reasoning-pattern work is responsible for).
  assert.ok(report.constraintNodes >= 5, `expected at least 5 constraint nodes, got ${report.constraintNodes}`);
  assert.equal(report.decisionNodes, 1);
});

test('quality benchmark: provenance coverage is complete (every node traces back to source text)', async () => {
  const compiled = await compileFixture();
  const report = computeSemanticQualityReport(compiled.graph);
  assert.equal(report.provenanceCoverage, 1);
});

test('quality benchmark: determinism — compiling the fixture twice produces identical capability discovery, resolution, and quality metrics', async () => {
  const first = await compileFixture();
  const second = await compileFixture();
  const firstLowered = lowerCapabilitiesToManifest(first.graph);
  const secondLowered = lowerCapabilitiesToManifest(second.graph);
  assert.deepEqual(firstLowered, secondLowered);
  assert.deepEqual(computeSemanticQualityReport(first.graph, firstLowered), computeSemanticQualityReport(second.graph, secondLowered));
});

// --- End-to-end regression: source -> XOIR -> contracts -> binding -> lowering -> package -> validation ---

test('end-to-end: the fixture packages into a valid .xo with all four manifest capabilities now lowered (Human-in-the-Loop Execution Class Lowering milestone: the two deterministic_rule capabilities from before, plus the two obligations now resolving as human_in_the_loop)', async () => {
  const compiled = await compileFixture();
  const packaged = packageXoirGraph(compiled.graph, {
    identity: { name: 'synthetic_property_policy', version: '0.1.0', creatorDid: 'did:xo:quality-benchmark-test' },
    metadata: { domain: 'insurance', description: 'Synthetic property policy quality-benchmark fixture', scope: [], limitations: [] },
  });
  assert.ok(packaged.ok);
  if (!packaged.ok) return;

  assert.equal(packaged.value.capabilities.discoveredCount, 4);
  assert.equal(packaged.value.capabilities.resolvedCount, 4);
  assert.equal(packaged.value.manifest.capabilities?.length, 4);
  assert.deepEqual(
    packaged.value.manifest.capabilities?.map((c) => c.name).sort(),
    ['Claim Assessment', 'Contact the claims department within 30 days', 'Reject The Claim', 'Send a confirmation notice to the policyholder'],
  );

  const validation = new PackageValidator().validateAll({ manifest: packaged.value.manifest, components: packaged.value.bundle.components, ancillary: packaged.value.bundle.ancillary });
  assert.deepEqual(
    validation.issues.filter((i) => i.severity === 'error'),
    [],
  );
});
