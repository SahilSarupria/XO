import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';
import { significantTokens } from '../../src/xoir/semantic-link.js';
import { RULE_DERIVED_METADATA_KEY, RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY } from '../../src/xoir/rule-capability-linking.js';
import type { XoirGraph } from '@xo/xoir';

/**
 * Problem B / B.1 — permanent regression coverage against the real
 * policy fixture (`XO_Commercial_Property_Test_Policy_Compatible.pdf`),
 * the same fixture and entry point (`compileSources`) used to diagnose
 * both issues: Problem B — bare clause/section-numbering digits
 * (`"3"`, `"7"`, `"10"`, ...) counting as sufficient
 * `same_unit_term_overlap` linking evidence on their own; Problem B.1 —
 * a single shared, but corpus-ambiguous, textual term (`"claim"`,
 * `"policy"`, ...) doing the same. Mirrors
 * `../document/real-policy-quality.test.ts`'s convention of proving
 * real-data behavior permanently rather than via ad-hoc manual
 * diagnostic scripts.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const TARGET_CAPABILITY_ID = 'cap_rule_2a15163541fa80841ee32ba0602c07b4';

async function compileRealFixture() {
  const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
  const result = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) throw new Error('unreachable');
  return result.value.graph;
}

function isPurelyNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

/**
 * Recomputes the exact same candidate-pool document-frequency map
 * `rule-capability-linking.ts#buildCandidateTermFrequency` computes in
 * production (non-minted capability + concept nodes, `name`+`description`
 * or `definition` as text) — reimplemented here rather than imported
 * since it's a private, unexported helper; this test independently
 * verifies the OUTCOME (no surviving edge violates the rule) using its
 * own computation of the same well-defined population, which is a
 * stronger check than asserting against the production function's own
 * internal state would be.
 */
function candidatePoolTermFrequency(graph: XoirGraph): ReadonlyMap<string, number> {
  const candidateNodes = graph.allNodes().filter((n) => {
    if (n.kind === 'concept') return true;
    if (n.kind !== 'capability') return false;
    const metadata = (n.properties as { metadata?: Record<string, string> }).metadata;
    return metadata?.[RULE_DERIVED_METADATA_KEY] !== 'true';
  });
  const frequency = new Map<string, number>();
  for (const n of candidateNodes) {
    const text =
      n.kind === 'capability'
        ? (() => {
            const props = n.properties as { name?: string; description?: string };
            const label = props.name ?? '';
            const description = (props.description ?? '').trim();
            return description.length > 0 ? `${label} ${description}` : label;
          })()
        : ((n.properties as { definition?: string }).definition ?? '');
    if (text.trim().length === 0) continue;
    for (const term of significantTokens(text)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  return frequency;
}

test('real policy fixture: no same_unit_term_overlap REQUIRES edge has sharedTerms that are ONLY numeric', async () => {
  const graph = await compileRealFixture();
  const sameUnitEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'same_unit_term_overlap');

  assert.ok(sameUnitEdges.length > 0, 'sanity: the real fixture must still produce some same_unit_term_overlap edges (this is not a test that the tier stopped firing)');

  const numericOnly = sameUnitEdges.filter((e) => {
    const terms = (e.metadata.custom as { sharedTerms?: readonly string[] } | undefined)?.sharedTerms ?? [];
    return terms.length > 0 && terms.every(isPurelyNumeric);
  });
  assert.deepEqual(
    numericOnly.map((e) => e.id),
    [],
    'every same_unit_term_overlap edge on the real fixture must have at least one non-numeric shared term',
  );
});

test('real policy fixture: legitimate numeric+textual same-unit links (a clause number corroborating shared real vocabulary) are preserved, not collateral damage', async () => {
  const graph = await compileRealFixture();
  const sameUnitEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'same_unit_term_overlap');

  const mixedNumericAndTextual = sameUnitEdges.filter((e) => {
    const terms = (e.metadata.custom as { sharedTerms?: readonly string[] } | undefined)?.sharedTerms ?? [];
    return terms.some(isPurelyNumeric) && terms.some((t) => !isPurelyNumeric(t));
  });
  assert.ok(mixedNumericAndTextual.length > 0, 'at least one real same-unit link legitimately combining a clause number with real shared vocabulary (e.g. a shared digit alongside "deductible" or "claim") must survive the fix');
});

test('real policy fixture (Problem B.1): no surviving same_unit_term_overlap edge rests on a single textual term whose candidate-pool document frequency is >= 2', async () => {
  const graph = await compileRealFixture();
  const frequency = candidatePoolTermFrequency(graph);
  const sameUnitEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'same_unit_term_overlap');

  const violations = sameUnitEdges.filter((e) => {
    const terms = (e.metadata.custom as { sharedTerms?: readonly string[] } | undefined)?.sharedTerms ?? [];
    // The ambiguity gate only ever applies when the TOTAL shared-term
    // count is exactly 1 (a lone textual term — a lone numeric term is
    // already rejected by the separate, unchanged Problem B rule and
    // can't reach this point). A numeric+textual pair like ["3","deductible"]
    // has a total count of 2 and is correctly exempt regardless of
    // "deductible"'s own frequency — see scoreLink's doc comment.
    if (terms.length !== 1) return false;
    const soleTerm = terms[0]!;
    return !isPurelyNumeric(soleTerm) && (frequency.get(soleTerm) ?? 0) >= 2;
  });
  assert.deepEqual(
    violations.map((e) => e.id),
    [],
    'every remaining single-textual-term same_unit_term_overlap edge must be supported by a candidate-unique term (frequency <= 1)',
  );
});

test('real policy fixture (Problem B.1): multi-term same_unit_term_overlap links remain present after the ambiguity gate', async () => {
  const graph = await compileRealFixture();
  const sameUnitEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'same_unit_term_overlap');

  const multiTerm = sameUnitEdges.filter((e) => {
    const terms = (e.metadata.custom as { sharedTerms?: readonly string[] } | undefined)?.sharedTerms ?? [];
    return terms.length >= 2;
  });
  assert.ok(multiTerm.length > 0, 'multi-term same-unit links (e.g. combining "insurer" and "loss") must survive the ambiguity gate — it only ever applies to single-term matches');
});

test(`real policy fixture: target capability ${TARGET_CAPABILITY_ID} is discovered, minted, and linked to its originating rule, unaffected by the numeric-evidence and corpus-frequency fixes`, async () => {
  const graph = await compileRealFixture();

  const targetNode = graph.getNode(TARGET_CAPABILITY_ID as never);
  assert.ok(targetNode.ok, 'target capability must be present in the compiled graph');
  if (!targetNode.ok) return;
  assert.equal(targetNode.value.kind, 'capability');

  const metadata = (targetNode.value.properties as { metadata?: Readonly<Record<string, string>> }).metadata;
  assert.equal(metadata?.[RULE_DERIVED_METADATA_KEY], 'true', 'target capability must still be recognized as M1.1-minted');
  const sourceNodeId = metadata?.[RULE_DERIVED_SOURCE_NODE_ID_METADATA_KEY];
  assert.ok(sourceNodeId, 'minted capability must still record its originating rule node id');

  // Minted capabilities are linked via linkMintedRuleCapabilities's
  // dedicated structural edge (evidenceKind: 'rule_capability_derivation'),
  // never via the same_unit_term_overlap tier either fix touches — see
  // rule-capability-linking.ts's own doc comment on why minted
  // capabilities are excluded from that generic pool. This assertion is
  // what proves neither fix could have affected this capability's own
  // linking even in principle, not just that it happens not to have.
  const edgesToTarget = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.toId as unknown as string) === TARGET_CAPABILITY_ID);
  assert.equal(edgesToTarget.length, 1);
  assert.equal((edgesToTarget[0]!.metadata.custom as { evidenceKind?: string }).evidenceKind, 'rule_capability_derivation');
  assert.equal((edgesToTarget[0]!.fromId as unknown as string), sourceNodeId);
});

// ---------------------------------------------------------------------------
// Problem C — structural containment + lexical corroboration. Cross-domain
// fixtures embedded inline (rather than as new repo files) since
// `compileSources`'s `{kind: 'document'}` input takes text directly and
// "where practical" favors a self-contained test over adding new example
// documents to the repository. Same documents used in the Problem C
// investigation's own measurement.
// ---------------------------------------------------------------------------

const API_REFERENCE_FIXTURE = `# Payments API Reference

## Overview

The Payments API lets you create charges, manage customers, and issue refunds against a merchant account. All requests must include a valid API key in the Authorization header. Responses are returned as JSON.

## Create a Charge

Creates a new charge and attempts to collect payment from a customer's payment method. A charge cannot be created for an amount below the minimum charge threshold of 50 cents.

### Parameters

- \`amount\` (required): A positive integer representing the amount to charge in the smallest currency unit. The amount must be at least 50 cents and no more than 999999.99 in the specified currency.
- \`currency\` (required): A three-letter ISO currency code, in lowercase. The currency must be one of the currencies supported by the merchant account.
- \`customer\` (optional): The ID of an existing customer to charge. If the customer ID does not exist, the request will be rejected.
- \`capture\` (optional): Whether to immediately capture the charge. Defaults to true. When capture is false, the charge is authorized but not captured until a separate capture request is made.

### Response

Returns a charge object if the charge succeeded, or an error if the charge failed. If the amount is below the minimum threshold, the API returns a validation error. If the customer does not have a valid payment method on file, the API returns a payment method error. If the customer ID does not exist, the API returns a not-found error.

## Retrieve a Charge

Retrieves the details of a charge that was previously created.

### Parameters

- \`charge_id\` (required): The identifier of the charge to retrieve.

## Errors

Requests that fail validation return a 400 status with an error code and a human-readable message.
`;

const CLINICAL_PROTOCOL_FIXTURE = `# Standard Operating Procedure: Blood Culture and Respiratory Specimen Collection

## 1. Purpose and Scope

This procedure describes the steps laboratory and clinical staff must follow when collecting blood culture sets and upper respiratory specimens for microbiological testing.

## 2. Safety Precautions

All specimen handling must comply with Biosafety Level 2 (BSL2) containment practices. Staff must wear appropriate personal protective equipment at all times during collection.

## 3. Blood Culture Collection

### 3.1 Preparation

1. Verify the patient's identity using two identifiers before beginning collection.
2. Select the venipuncture site. The antecubital fossa is the preferred site.

### 3.2 Collection

4. Collect one aerobic bottle and one anaerobic bottle to form the first blood culture set.
7. If a second blood culture set is required, use a separate venipuncture site from the first set.

## 4. Upper Respiratory Specimen Collection

### 4.2 Collection

16. If viral transport medium is unavailable, sterile saline may be substituted only if the assay's instructions for use confirm saline is an acceptable transport medium for that specific assay.

## 5. Specimen Rejection Criteria

The receiving laboratory must reject a specimen if the specimen container is unlabeled, if the specimen was collected using an unapproved swab or transport medium, or if the specimen shows visible leakage.

## 6. Documentation

Each specimen must be logged with the collector's identity, the collection date and time, and the specimen type. If any deviation from this procedure occurs, the collector must document the deviation.
`;

async function compileDocumentFixture(text: string, sourcePath: string, title: string) {
  const result = await compileSources([{ kind: 'document', text, sourcePath, title }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) throw new Error('unreachable');
  return result.value.graph;
}

test('Problem C — API fixture: "Create a Charge" gains structurally nested reasoning nodes that were previously invisible to the linker', async () => {
  const graph = await compileDocumentFixture(API_REFERENCE_FIXTURE, 'api-reference.md', 'API');
  // Anchored by section path ("## Create a Charge"), not by capability-name wording — this
  // sentence ("Creates a new charge and attempts to collect payment...") describes two
  // legitimate actions, and the extractor only ever returns the first verb match per
  // sentence. Layer 2B (P0.9 Beta, see benchmark/CHANGELOG.md) taught the rule-based
  // extractor to recognize active-voice "Creates" (previously unrecognized, so the scan
  // fell through to "collect" and that incidental wording became this capability's name);
  // "Creates" is in fact the better match — it's the verb the section's own heading
  // ("Create a Charge") names — but it means a name-substring anchor of "collect payment"
  // no longer locates it. sectionPath is the robust anchor already used for this same
  // purpose two tests below (the clinical-fixture root-capability lookup).
  const capNode = graph.allNodes().find((n) => n.kind === 'capability' && (n.metadata.sourceRefs[0]?.sectionPath ?? []).some((p) => p.includes('Create a Charge')));
  assert.ok(capNode, 'the "Create a Charge" capability must still be discovered — this is not a Problem C concern');
  if (!capNode) return;

  const structuralEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.toId as unknown as string) === (capNode.id as unknown as string) && (e.metadata.custom as { evidenceKind?: string }).evidenceKind === 'structural_containment');
  assert.ok(structuralEdges.length > 0, 'at least one previously-invisible, structurally-nested reasoning node must now be linked via structural_containment');

  // Per the task: do not require the capability to fully RESOLVE — the
  // Problem C investigation and the domain-bias experiment both
  // established that resolution for these particular conditions is
  // separately blocked by the structured-comparison grammar's lack of
  // existence/state-condition coverage, which is explicitly out of scope
  // here. This test only proves the LINKAGE gap is closed.
});

test('Problem C — clinical fixture: the document-root capability does NOT absorb reasoning nodes via structural_containment', async () => {
  const graph = await compileDocumentFixture(CLINICAL_PROTOCOL_FIXTURE, 'clinical-protocol.md', 'Clinical');
  const rootCap = graph.allNodes().find((n) => n.kind === 'capability' && (n.metadata.sourceRefs[0]?.sectionPath ?? []).length <= 1);
  if (!rootCap) return; // no root-level capability discovered in this run — nothing to absorb, trivially satisfies the assertion below anyway
  const structuralEdgesToRoot = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && (e.toId as unknown as string) === (rootCap.id as unknown as string) && (e.metadata.custom as { evidenceKind?: string }).evidenceKind === 'structural_containment');
  assert.equal(structuralEdgesToRoot.length, 0, 'a document-root-level capability must never receive a structural_containment edge, regardless of how many reasoning nodes exist beneath it');
});

test('Problem C — insurance fixture: existing behavior does not regress', async () => {
  const graph = await compileRealFixture();
  const requiresEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES');
  const sameUnitEdges = requiresEdges.filter((e) => (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'same_unit_term_overlap');
  const exactLabelEdges = requiresEdges.filter((e) => (e.metadata.custom as { evidenceKind?: string } | undefined)?.evidenceKind === 'exact_label');

  // Exact counts established by the Problem B.1 delivery. `resolvedCount`
  // is re-asserted here unchanged — Problem C must add new
  // (structural_containment) edges only, never alter the count or
  // membership of these existing tiers.
  //
  // `exactLabelEdges` moved from 113 (Problem B.1 baseline, held through
  // Layer 2B) to 108 under Layer 3 (P0.9 Beta, see benchmark/CHANGELOG.md):
  // `capitalized-run-detector.ts` previously minted a standalone "entity"
  // concept node for any lone capitalized word, including closed-class
  // function words capitalized only because they open a sentence (e.g.
  // "Before", "This", "It" — verified directly, not just a count change:
  // all 5 removed edges had `matchedLabel: "Before"`). Because
  // `exact_label` matching is an unscoped substring check against the
  // referenced node's own label, a bare common word like "Before" matches
  // almost any nearby reasoning-node text purely because the English word
  // "before" appears in it — five spurious links on this fixture, not five
  // genuine ones. Layer 3 restricts the false-positive: a *single-word*
  // capitalized run is no longer reported when that word is a closed-class
  // function word (a *multi-word* run, e.g. "State Farm", is untouched —
  // multi-word capitalization remains strong proper-noun evidence). This
  // is a precision fix, not a capability/action/process change: no
  // multi-word entity, capability name, or genuine domain concept on this
  // fixture is affected (see `capitalized-run-detector.test.ts`'s new
  // regression coverage for the exact word-level behavior).
  //
  // `sameUnitEdges` moved from 12 (Problem B.1 baseline) to 21 as a direct,
  // verified consequence of a prior bug-fix pass's capability-extraction
  // improvements on this same real PDF (wider object-window instead of a
  // hardcoded 3-word cutoff, plus new `map`/`request` lexicon verbs and
  // scoped passive-voice matching) discovering more/fuller candidate
  // capability nodes, which increases the pool `same_unit_term_overlap`
  // draws shared-term evidence from — and then to 25 under Layer 2B (P0.9
  // Beta, see benchmark/CHANGELOG.md): active-voice verb-inflection
  // recognition ("must be recorded", previously invisible because bare
  // "be" after a modal isn't a conjugated passive auxiliary) discovering
  // two more genuine capabilities on this fixture — "Record in the claim
  // file" (6.6) and "Record before payment authorization" (9.5) — both
  // verified directly against the source PDF text, correctly attributed to
  // their sections, sourceConfidence 0.5, no corruption. `exactLabelEdges`
  // (113) is unchanged by either pass — neither adds new exact-label
  // evidence on this fixture.
  assert.equal(sameUnitEdges.length, 25, 'same_unit_term_overlap edge count reflects Layer 2B\'s active-voice verb-inflection improvements on this fixture (see comment above); verified via controlled revert to be free of corruption');
  assert.equal(exactLabelEdges.length, 108, 'exact_label edge count reflects Layer 3\'s removal of 5 spurious "Before"-substring links (see comment above); verified to be a false-positive-only change, not a loss of genuine evidence');

  // Human-in-the-Loop Execution Class Lowering milestone: `resolvedCount`
  // moved from 17 (this test's original Problem B.1/C baseline) to 18 (+1
  // `human_in_the_loop`, see below), then to 20 under Layer 2B: the same
  // two new "Record..." capabilities noted above (sameUnitEdges comment)
  // both resolve as `deterministic_rule` (simple record-keeping
  // obligations with no ambiguity requiring human judgment), so
  // `deterministicRuleCount` moves from 17 to 19 while `humanInTheLoopCount`
  // stays exactly 1 — Layer 2B added zero new human_in_the_loop
  // resolutions on this fixture.
  const lowered = lowerCapabilitiesToManifest(graph);
  const resolvedCount = lowered.outcomes.filter((o) => o.status === 'resolved').length;
  assert.equal(resolvedCount, 20, 'total resolved capability count reflects the Human-in-the-Loop milestone (+1) and Layer 2B (+2 deterministic_rule) on top of the Problem B.1 baseline (17)');

  const deterministicRuleCount = lowered.declarations.filter((d) => d.execution?.mode === 'deterministic_rule').length;
  const humanInTheLoopCount = lowered.declarations.filter((d) => d.execution?.mode === 'human_in_the_loop').length;
  assert.equal(deterministicRuleCount, 19, 'the deterministic_rule resolution count is the Problem B.1 baseline (17) plus Layer 2B\'s two new "Record..." capabilities, both deterministically resolvable');
  assert.equal(humanInTheLoopCount, 1, 'human_in_the_loop count is unchanged by Layer 2B — still exactly the one capability from the Human-in-the-Loop milestone');
});
