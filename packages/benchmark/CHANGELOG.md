# Benchmark changelog

Dated record of every change to committed ground truth (`suites/*.suite.json`) and to committed baselines
(`baselines/*.report.json`), with the reasoning — per the README's "known gaps are recorded, not tuned away"
rule, a metric change against a suite/baseline edit here must always be traceable to one of these entries.

## P0.9 Beta — Layer 0 (PDF text-integrity fix)

**Context.** The P0.9 Aastha audit found character-level corruption in extracted text from `Aastha.pdf` (e.g.
`"Identify \"Actual\" brokerage..."` extracting as `"ICdReMnt.ify \"Actual\" brokerage..."`). Root cause: this
PDF's generator lays each line out in its own `q`/`cm`/`BT…ET`/`Q` block; two genuinely unrelated lines can
transform to the exact same absolute page `y` when the block's `cm` offset and the line's local `Td` offset
both land on the same line-height quantum (confirmed by instrumenting the real content-stream interpreter
against the real fixture — not a hypothesis). `document/line-grouper.ts`'s `groupRunsIntoLines` bucketed
same-`y` runs together and sorted by `x`, so a coincidentally-colliding, unrelated run got character-interleaved
into the middle of the real line. Fixed by rejecting a same-`y` merge when the incoming run's `x` falls
meaningfully behind the bucket's running max `x` — a real line's glyphs never go backward; a coincidental
collision restarts at its own (unrelated) block's `x`. The identical root cause reappeared one stage up, in
`document/block-builder.ts`'s paragraph-continuation merge (a near-zero y-gap between two *different*,
coincidentally-colliding lines was being accepted as a genuine wrapped continuation); fixed the same way — a
real paragraph continuation always steps strictly downward, so a near-zero gap can only be a coincidental
collision, never fixed to belong to the same paragraph.

**Ground truth change — `vertical-fixtures.suite.json`, case `aastha-operations`:**

- **Added** capability expectation `t3.3a-identify-actual-brokerage` (`name.contains: "Identify Actual brokerage"`,
  `resolution: resolved`, `executionClass: human_in_the_loop`, evidence page 1). This capability was previously
  unreachable — its source text was corrupted into `"ICdReMnt.ify..."` and so classified `not_executable`/dropped
  rather than discovered as a real task. Once Layer 0 fixed the corruption, `compileSources` (the same production
  path the benchmark harness calls) discovers it cleanly: capability node name `"Identify Actual brokerage Basic
  Incentives"`, description `"Identify \"Actual\" brokerage (Basic + Incentives)."` — verified to match the source
  PDF exactly via an independent `pdftotext -layout` extraction, and to satisfy this suite's own closed-world
  capability-evidence rules (resolved, human_in_the_loop, correctly attributed to page 1 / section "3. Brokerage
  Reconciliation (Reconciliation Tool)"). This is genuinely newly-supported evidence, not a benchmark-satisfying
  rewrite — no other expectation in this case was altered, weakened, or removed.
- **Not added, and left deliberately unchanged:** a second span was also freed of character-level corruption by
  Layer 0 — `"validated reconciliation data."` (the true second line of item 2, "Partner Payouts: Calculate
  channel-wise revenue share at the policy level based on the validated reconciliation data.") — but it is *not*
  being added to ground truth, because what's actually discovered is **not** that sentence. It's a merge with an
  entirely unrelated bullet from a different numbered item: capability name/description
  `"validated reconciliation data. Channel-wise revenue generation (Referral/Digital/Sales/Associate/POSP)."`
  (verified against independent `pdftotext` ground truth: these two clauses come from different list items,
  separated by other content in between). See "Residual gap" below for the root cause. Adding this text to ground
  truth would be rewriting the benchmark to accept an actual defect as correct, which is exactly what this
  changelog exists to prevent.

**Residual gap — recorded, not fixed, in this pass.** `"validated reconciliation data."` suffers the identical
coincidental-y-collision as the character-corruption case, but one level further up the pipeline: its own
computed page-`y` does not reflect its true reading-order position (it coincides with the unrelated "Channel-wise
revenue generation..." bullet's `y`), so within its section's flat block list it sorts adjacent to that unrelated
bullet rather than to its own true predecessor. `line-grouper.ts` and `block-builder.ts` (both fixed above)
correctly keep these as two separate, individually-clean lines/blocks — but `semantic/unit-builder.ts`'s
`groupBlocks` merges consecutive same-semantic-type, non-list/footnote blocks into one `ExperienceUnit` based on
**sequence position alone**, with no geometric distance check at all (by design — it exists to merge genuinely
sequential prose spanning multiple wrapped lines). Since the two blocks are still adjacent in the (mis-ordered)
sequence, they get glued back into one unit's content (`"...text1...\n\n...text2..."`), and the capability
extractor treats that joined text as one candidate. Correctly fixing this requires deciding how to use
content-stream order as a corrective signal when geometry itself is misleading for a specific line — a materially
larger, riskier change (the P0.9 Beta brief itself flags stream-order tie-breaking as risking regressions to
legitimate multi-column reconstruction elsewhere) than Layer 0's character-corruption scope. Left as an open,
documented gap for separate investigation; downstream effects on this case's metrics are fully attributed to it
below and are expected, not mysterious:
  - `capabilityPrecision`: one unexpected capability (`validated reconciliation data. channel-wise revenue
    generation (referral/digital/sales/associate/posp).`) — the merge artifact itself.
  - `executionCorrectness`: `wf-partner-payouts-escalates` now fails — the merged capability no longer matches the
    workflow step-name matcher `"Calculate channel-wise revenue share"`.
  - `workflowRecall`: `wf-partner-payouts` now fails, same cause.

None of `wf-receipts-and-bookkeeping`'s or `wf-reconciliation-tasks`'s missing-workflow status, nor the other 4
pre-existing unexpected capabilities (`Brokerage Validation:`, `Generate via direct sales referral partners
digital`, `Reconcile invoice amounts vs`, `Reconcile the invoice balance against actual receipts received.`), are
touched by Layer 0 — those are pre-existing, separately-scoped gaps (header/title filtering, `vs.` sentence
splitting) already present in the frozen P0.9 baseline.

**Baseline refreshed:** `baselines/vertical-fixtures.report.json` updated to this Layer 0 state (this is the new
reference every subsequent layer diffs against — see root `CHANGES.md` / the P0.9 Beta brief for the full
before/after metric table).

## P0.9 Beta — Layer 1 (Capability Candidate Quality)

**Layer 1A — headless-title / prose false positives.**

Root cause: `unit-builder.ts` already computed `headingTitle` on its `DraftExperienceUnit` — defined only when a
unit's `title` was borrowed from a genuine authored `section.heading`, `undefined` whenever `title` was instead
synthesized from the unit's own leading content (`synthesizeTitle`, used for every unit but a section's first).
But `relationship-builder.ts`'s draft→final conversion to the canonical `ExperienceUnit` silently dropped that
field, so `capabilities/rule-based-extractor.ts`'s title/category-keyword capability detection had no way to tell
"Brokerage Validation" (a real heading) apart from "Reconcile the invoice balance against actual receipts
received." (ordinary prose whose synthesized title happens to contain the keyword "invoice") — both looked
identical via `unit.title`. Fixed by propagating `headingTitle` through to `ExperienceUnit` and gating the
title-path capability detection on it instead of `unit.title` (`unit.title === unit.headingTitle` whenever the
latter is defined, so this only narrows *which* units are eligible — it changes no other behavior).

Resolved, with source-level verification (not just benchmark-metric improvement): the `Brokerage Validation:`
capability (a bare heading-like label with no actionable content) and the duplicate `Reconcile the invoice
balance against actual receipts received.` title-path candidate (which shadowed the legitimate verb-based
candidate for the same sentence) both stopped being generated. **Bonus, unplanned but verified correct:** this
also fully resolved the Layer 0 residual gap's *observable* effect (see above) — the `validated reconciliation
data. Channel-wise revenue generation (...)."` merged capability was itself generated via this exact false-positive
mechanism (a merged unit's whole content becoming its synthesized, non-authored title), so it stopped being
generated too, and `wf-partner-payouts` now composes and matches correctly — **without any change to
`unit-builder.ts`**. To be precise about what is and isn't fixed: `unit-builder.ts`'s `groupBlocks` still merges
the two unrelated blocks' *content* into one unit (unchanged, still a latent defect for any future consumer that
might rely on that content), but the specific way it was surfacing as a wrong benchmark result is gone.

**Layer 1B — `vs.` sentence-boundary splitting.**

Root cause: `capabilities/sentence-split.ts`'s `splitSentences` had no abbreviation handling at all (by its own
prior doc comment) — it split at any `.`/`!`/`?` followed by whitespace or end-of-string, with zero exceptions, so
"Reconcile invoice amounts vs. receipt amounts against Statement figures." split into two fragments at "vs.",
truncating the capability's `description` (and any downstream reasoning-condition text) at "vs." Fixed with a
narrowly-scoped `SENTENCE_ABBREVIATIONS` set (containing only `vs`, not a general abbreviation parser) consulted
before treating a `.` as a sentence boundary. Shared by both `capabilities/rule-based-extractor.ts` and
`reasoning/rule-based-extractor.ts` (both import `splitSentences`), so both were verified: a capability sentence
containing "vs." is now captured whole, and an IF/THEN reasoning condition containing "vs." is no longer
fragmented.

**Ground truth change — found and fixed as a side effect of implementing Layer 1B, unrelated to the fix's own
correctness:** the existing expectation `t3.4-reconcile-invoice-vs-receipt` (`name.contains: "Reconcile invoice
amounts vs. receipt amounts"`, with a literal period after "vs") could never have matched *any* implementation,
including a fully correct one — every capability name in this system strips punctuation from its object words
(`objectWords.map(stripPunctuation)` in `rule-based-extractor.ts`), so a capability name never contains an
embedded period. Proved independently by comparing to the sibling expectation in the same case,
`t3.4-verify-expected-vs-actual-brokerage`, whose `contains: "Verify Expected Brokerage"` correctly has no
embedded punctuation — the established, consistent convention across every other entry in this suite. Fixed the
one stray period (`"Reconcile invoice amounts vs. receipt amounts"` → `"Reconcile invoice amounts vs receipt
amounts"`), the smallest possible change, restoring `t3.4-reconcile-invoice-vs-receipt` to a correctly-matching
state once Layer 1B's real fix is in place — verified via the capability's `description` field, which now
contains the complete, untruncated source sentence.

**Combined Layer 1 result (vs. Layer-0-complete baseline, `aastha-operations`):** `capabilityPrecision` 80.0%
(20/25) → 95.2% (20/21); `executionCorrectness` 93.3% → 96.7%; `workflowRecall` 62.5% → 87.5% (both
`wf-partner-payouts` and `wf-receipts-and-bookkeeping` now resolve; `wf-reconciliation-tasks` remains missing,
pre-existing and out of scope). `capabilityRecall`, `executionClassAccuracy`, `resolutionAccuracy` all unchanged
at their Layer-0-baseline values (the temporary dip observed mid-layer, after 1A alone, was fully explained by and
resolved together with the 1B fix). No unrelated fixture regressed. The one remaining unexpected capability
(`Generate via direct sales referral partners digital`, a passive-voice-detection question from §9 of the original
P0.9 Beta milestone brief) and the one remaining missing workflow (`wf-reconciliation-tasks`) are both pre-existing
and out of scope for Layer 1.

**Baseline refreshed** to this Layer-1-complete state.

## P0.9 Beta — Layer 2B (Capability Accuracy)

**Section A — active-voice verb inflection.** `CAPABILITY_VERBS` already had base forms for every
example verb the milestone named; the actual gap was that `findCapabilityVerb` only matched a word's
*exact* base form — active-voice inflected forms ("generates", "reconciled") were invisible unless
preceded by a passive auxiliary. Confirmed empirically against real Aastha text: `"The CRM generates a
'Policy Booking Report'..."` was a real, previously-missed capability (the exact §9 gap from the
original P0.9 audit).

Implemented in `rule-based-extractor.ts`:
- **Active past tense ("-ed")**: reuses the existing `-ed`-stripping helper (renamed
  `deriveEdSuffixBaseVerbCandidates`, no longer passive-only).
- **Active present tense ("-s")**: gated behind two context guards (not preceded by a determiner,
  not followed by an auxiliary/copula) since "-s" forms are routinely plural nouns too
  ("records", "matches").
- **Modal + bare "be"** ("must be recorded", "must be configured") reclassified as genuinely passive
  (previously fell through to the unrestricted active branch) — this matters because the passive
  branch's `execution`-category exclusion must still apply; without it, "the system must be
  configured" would have become a false-positive active `Configure` capability.

**Three real false positives found and fixed during verification** (each traced to source, reproduced,
fixed with a targeted, principled — not Aastha-phrase-hardcoded — guard, then regression-tested):
1. **Reduced relative clause + adverb** — "a document created **solely** to exercise..." misread as an
   active event. Guard: an immediately-following "-ly" word is evidence of a participial modifier
   (a transitive verb's object is never separated from it by an adverb).
2. **Reduced relative clause + preposition** — "reports generated **from** the CRM", "data validated
   **by** the auditor". Guard: an immediately-following preposition (`by`/`from`/`via`/`through`/`of`/
   `without`/`with`/`using`) is the same evidence — a transitive verb's object is a noun phrase, never
   a bare preposition.
3. **Quoted label** — `the "Policy **Booked**" reports` (a report's literal name, cited verbatim) misread
   as the verb "book". Guard: a word immediately adjacent to a quotation mark in its raw (unstripped)
   token is a cited label, not prose.
4. **Sentence-initial past-tense participle with no subject** — `"Validated reconciliation data."`
   (itself a symptom of the already-documented Layer 0 residual gap — see below) misread as an
   imperative. Guard: unlike a base-form imperative ("Reconcile the accounts." — a normal instruction),
   a sentence-initial *past-tense* verb with no subject before it is not a grammatical English sentence
   at all, and is far more likely to be a document-reconstruction artifact.

Also found and fixed a real regression exposed by full-suite verification, unrelated to the above:
`Problem C — API fixture` located its target capability by a name-substring anchor ("collect payment")
that happened to be incidental wording from a two-action sentence; the extractor only ever returns the
first verb per sentence, and "creates" (now correctly recognized) legitimately wins that race ahead of
"collect". Fixed by anchoring on `sectionPath` instead (a more robust pattern already used elsewhere in
the same test file) — not a weakened assertion, a corrected one. Separately, `Problem C — insurance
fixture`'s hardcoded `sameUnitEdges`/`resolvedCount`/`deterministicRuleCount` were updated with the same
rigor the test's own prior history establishes (12→21→25, 17→18→20, 17→19): two new genuine
capabilities — "Record in the claim file" and "Record before payment authorization" — both verified
directly against the real Commercial Property PDF's regulatory-obligation sentences ("must be
recorded..."), correctly attributed, no corruption.

**Ground truth change:** added `t2.3-generate-policy-booking-report`
(`name.contains: "Generate a Policy Booking Report"`) to `aastha-operations` — verified end-to-end: real
source text ("The CRM generates a 'Policy Booking Report' for a custom date or period..."), traced to
the raw capability node (clean name, `resolved`/`human_in_the_loop`, correctly attributed to page 1 /
"2. Sales and Policy Lifecycle (CRM)"), matching the existing `t2.x` convention. Its `description` field
carries an unrelated pre-existing paragraph-merge artifact (garbage text prepended from the preceding,
unrelated sentence) — not touched, since ground-truth matching is on `name`, which is clean, and fixing
paragraph-merge boundaries generally is out of Layer 2B's scope.

**Ground truth explicitly NOT changed:** the other candidate this pass surfaced,
`"Validate reconciliation data"` (from `"validated reconciliation data."`), was investigated and found
to be illegitimate — a direct symptom of the Layer 0 residual gap (`unit-builder.ts`'s `groupBlocks`
still merges two unrelated blocks' content; see that entry above), not real source content. Guard #4
above suppresses it at the extraction level instead.

**Aggregate benchmark, Layer-1-complete baseline → Layer 2B:** `capabilityPrecision` 95.2%→95.5%,
`capabilityRecall` 88.9%→89.1%, `executionClassAccuracy` 88.9%→89.2%, `resolutionAccuracy` 97.0%→97.1%.
Every other aggregate metric unchanged. Zero regressions on the final run.

**Baseline refreshed** to this Layer-2B-complete state.

## P0.9C Step 2 — Evaluation Model

**No ground truth, suite, baseline, metric definition, or emitted report byte changed.** Step 2 documents and pins the existing evaluation
semantics: added `EVALUATION_MODEL.md`, `src/evaluation-model.ts` (read-only registry + classifiers; imported by no evaluator/comparator
code), and `test/evaluation-model.test.ts`. `EVALUATION_VERSION` stays `p0.9c-1`. Both baselines are untouched: `runtime-mechanics` still
equals a fresh run byte-for-byte; `vertical-fixtures` keeps its known pre-P0.9A drift (classification `no_change`, one `coverage_reduced`
warning on `observedSourceRefCoverage`) until Step 7. Eleven evaluator properties were recorded as documented limitations (L1–L11), not fixed.

## P0.9C Step 3 — Golden Expectations

Audit of every golden expectation (153 across 8 cases) plus an additive ground-truth register. Full narrative: `GOLDEN_EXPECTATIONS.md`.

**Ground truth change — `vertical-fixtures.suite.json`, case `aastha-operations`, workflow `wf-reconciliation-tasks`, step 3** (the only change):

- **Old:** `{"contains": "Reconcile invoice amounts vs. receipt amounts"}`
- **New:** `{"contains": "Reconcile invoice amounts vs receipt amounts"}`
- **Reason / evidence:** every capability name strips punctuation from its object words (`objectWords.map(stripPunctuation)`, see the Layer 1B
  entry above), so a matcher containing a period can never match any implementation. The discovered capability is
  `"Reconcile invoice amounts vs receipt amounts received"`; `matchesName` on it returns `false` with the period and `true` without. This is the
  same defect fixed in Layer 1B for the sibling capability expectation `t3.4-reconcile-invoice-vs-receipt`; the workflow step was missed. Found by a
  scan of every name matcher in both suites (candidate counts, and "matches 0 now but its punctuation-stripped form matches"): this was the only instance.
- **Affected metric:** none numerically. Run before/after on the real pipeline: every numerator, denominator and ratio in both suites is identical
  (`workflowRecall` for this case stays 2/3; comparison classification `no_change`, no regressions). Report differences are limited to the `workflowRecall`
  miss's `reason` wording and `attributedStage`, which moves from `capabilities` to `workflows` — the defective matcher made a step capability look
  undiscovered, when in fact the capabilities exist and the composer does not emit a workflow with exactly these four steps.
- **Not changed:** the exact-step-set requirement. The composer emits one 7-step workflow (Map, Match, Identify Actual, Identify discrepancies, Verify,
  Reconcile, Validate) containing these four; that is a real composer gap and is preserved as a signal.

**No other golden expectation was changed** — the remaining 152 expectations remain supportable under the Step 2 evaluation model. In particular the 10
forbidden capability traps (`spuriousCapabilityAvoidance` 0/10) are unchanged and retained. No world-model declaration was changed; two are reported as
questionable (commercial `heuristic` facts, aastha capabilities) and await a decision.

**Baselines:** none regenerated. `runtime-mechanics` still equals a fresh run byte-for-byte. `vertical-fixtures` keeps its known pre-P0.9A drift plus the
attribution/wording change above; its comparison classification remains `no_change`. Step 7 owns regeneration.

**Added:** `GOLDEN_EXPECTATIONS.md`; `ground-truth/{vertical-fixtures,runtime-mechanics}.ground-truth.json`; `src/ground-truth.ts` (imported by nothing in
the evaluation path); `test/ground-truth.test.ts`.

## P0.9C Step 4 — Producer Attribution

Full narrative: `PRODUCER_ATTRIBUTION.md`. Audit finding: `producedBy` is an *extractor name* stamped on the knowledge and capability-extractor paths only;
reasoning-derived nodes and rule-minted capabilities have no stamping site (whether they should is not established by the repository). Only two values are ever
observed (`rule-based`, `structured-operation`); `ai` and `hybrid` are not exercised.

**Added (packages/benchmark only; no compiler, XOIR, runtime or contract change):**
- metric `producerAttributionCoverage` (descriptive; population = nodes on a stamping path, classified without reading `producedBy`; not-judged paths reported in `breakdown`);
- metric `producerAttributionCorrectness` (graded; optional golden `producedBy` on capability expectations, with a premise guard);
- optional `producedBy` on `CapabilityExpectation`, `ObservedNode.subtype`, `src/producer.ts`, lint `unknown_expected_producer`, `PRODUCER_ATTRIBUTION.md`, `test/producer.test.ts`.

**Golden expectations added (recorded per Step 3J):** `producedBy: "structured-operation"` on `op-calculate-brokerage` and `op-record-brokerage` in both
`structured-operation-data-flow` and `openapi-operation-data-flow` (4 lines; no existing expectation edited). Evidence: the source format is structured / OpenAPI, which is
consumed only by the structured-operation extractor (`capabilities/hybrid-extractor.ts`); confirmed on the real pipeline. Affected metric: only the new
`producerAttributionCorrectness` (2/2 in each case). The Step 3 register fingerprints for those two cases were updated accordingly (`9a958b11c1dbbf26` → `b294e8d762ce826c`, still
equal to each other).

**Existing metrics:** unchanged. Both suites re-run on the real pipeline: `runtime-mechanics` byte-identical to its baseline; `vertical-fixtures` has zero differences
outside the two new metrics. `EVALUATION_VERSION` stays `p0.9c-1`. The metric count is now 22 (20 historical + 2).

**Earlier-step tests adjusted (intent preserved, scope narrowed):** Step 1 — "producer input never changes any metric / never a failure" now means *any historical metric*
(producer input deliberately feeds the two new metrics); Step 2 — "20 metrics" / reserved Step 4 dimensions updated for the two implemented metrics; Step 3 — the history test
records the Step 4 fingerprint change; one metric-id list in `misc.test.ts`.

**Baselines:** none regenerated (Step 7).

## P0.9C Step 5 — Evidence / Provenance Evaluation

Full narrative: `PROVENANCE_EVALUATION.md`. Audit: the provenance chain is internally connected wherever it is observable (71/71 capabilities); the ExperienceUnit id is carried on every XOIR node ref but
dropped by `ContractSourceRef` and `ObservedSourceRef` and the compile result exposes no unit list, so a unit's existence is `not_observable`; binding -> manifest -> runtime is `not_exercised`; the P0.9B projection
APIs have no production consumer; the existing source-reference metrics cannot see a broken chain.

**Added (packages/benchmark only):** metrics `provenanceChainCoverage` and `executionProvenanceAgreement` (both descriptive; not counted toward `measured`); `ObservedCapabilityProvenance` /
`ObservedExecutionProvenance` observation fields (consuming `projectAllCapabilityProvenance` / `projectExecutionProvenance` unchanged; the runtime's recorded facts are now kept instead of discarded;
excluded from every stage fingerprint); limitations L14, L15; `PROVENANCE_EVALUATION.md`; `test/provenance.test.ts`.

**Existing metrics:** `provenanceCompleteness` and `observedSourceRefCoverage` are unchanged. Re-run on the real pipeline, every pre-existing metric, item and fingerprint of both suites is identical to Step 4;
the only report differences are the two new metrics. `runtime-mechanics` now also reports `executionProvenanceAgreement` (10/10), so it is no longer byte-identical to its committed baseline (not regenerated).
**No golden expectation was changed or added.** `EVALUATION_VERSION` stays `p0.9c-1`; the metric count is 24 (20 + 2 + 2).

**Earlier-step tests adjusted (intent preserved):** the Step 1 runtime-baseline byte guard compares the output minus the Step 5 metrics (historical content still pinned by hash); the Step 1 "unexpected new metric" guard
allows the Step 5 ids; Step 2 metric-count / reserved-dimension assertions updated; one metric-id list in `misc.test.ts`.

## P0.9C Step 6 — Cross-Path Evaluation

Full narrative: `CROSS_PATH_EVALUATION.md`. Measurement only: no path was changed, unified or reconciled.

**Added (packages/benchmark only):** metric `crossPathConsistency` (descriptive; judged states are only match / mismatch); `src/cross-path.ts` (path inventory, pure comparator, view types); `PathView`
observation (live graph, a serialized round trip, and the package boundary built on clones: lowering -> serialization -> `extractContractFromPropertyBag` -> structured-comparison-only binding); an `observeCase`
test seam `lowerCapabilities`; limitation L16; `CROSS_PATH_EVALUATION.md`; `test/cross-path.test.ts` (17 tests).

**Findings:** a freshly compiled graph's `graphHash` is run-specific (node/edge timestamps feed the hashes) so it is comparable only within one graph instance; a lowered graph is a different object from the unlowered one;
the installed path resolves only the structured-comparison binding (19 human-in-the-loop capabilities resolve live but not there; classified `not_comparable` with raw values kept); all 355 judged units agree.

**Existing metrics:** every pre-existing metric, item and fingerprint is identical to Step 5 (verified on both suites); Step 4 and Step 5 metrics unchanged. `runtime-mechanics` is byte-identical to Step 5 (no cross-path metric: hand-built XOIR).
No golden expectation changed; no baseline regenerated; `EVALUATION_VERSION` unchanged. The metric count is 25.

**Earlier-step tests adjusted (intent preserved):** metric-count and reserved-dimension assertions (Step 2), the "unexpected new metric" guard (Step 1), and one aggregate-id list (`misc.test.ts`).

## P0.9C Step 7 — Baseline + Regression Protocol

Full narrative: `BASELINE_PROTOCOL.md`. **Baseline refreshed: NO** — neither committed baseline was modified (md5 verified before and after). No compiler, XOIR, runtime, package, CLI or API change.

**Added (packages/benchmark only):** `src/baseline.ts` (baseline manifest + verification, run-specific-field guard, deterministic change classification, decision, refresh-record validation); `baselines/BASELINES.json` (identity, status, known drift,
declared golden changes and retained history of the two existing baselines); `BASELINE_PROTOCOL.md`; `test/baseline.test.ts` (18 tests); comparator warnings `metric_added`, `metric_removed`, `metric_definition_changed`, `evaluation_version_changed`.

**Comparator, conservative fixes (`compare.ts`):** a metric present on only one side is no longer diffed against nothing — a new metric with failing items is no longer a false regression, and a vanished metric is no longer credited as "improved"; both are surfaced as warnings.
`evaluationVersion` and metric-definition changes are now explicit warnings. All other verdict logic is unchanged; coverage_reduced is not suppressed.

**Audit of the committed baselines:** 0 semantic regressions; `runtime-mechanics` compatible (1 expected addition); `vertical-fixtures` review_required (26 expected metric additions, 3 golden changes, 6 known historical drift, 1 evaluation-version gap, 7 representation-only).

**Correction (Step 6 wording):** the graph hash includes node/edge `createdAt` deliberately (provenance); `updatedAt` is excluded. `CROSS_PATH_EVALUATION.md` and a test comment were corrected; behavior and numbers are unchanged. The graph hash is documented as an instance identity and never enters a report or baseline.

**Earlier-step test adjusted (intent preserved):** the Step 1 test for a pre-attribution baseline now expects exactly one `evaluation_version_changed` warning (the baseline predates versioning) instead of none.

## P0.9C Step 8 — Test the Evaluation Itself

Full narrative and matrix: `EVALUATION_SELF_TEST.md`. **Baseline refreshed: NO.** No production, baseline, golden, manifest or evaluation-version change; every normal report is byte-identical to Step 7 (md5/sha256 verified before and after).

**Added (packages/benchmark, test-only):** `test/self-test.test.ts` (31 tests; a mutation matrix over real observations of four cases, pushed through evaluate -> report -> compare -> baseline classification); `test-tools/evaluator-mutations.mjs` (12 evaluator-internal source mutations, restored by sha256; never imported by the library); `EVALUATION_SELF_TEST.md`.

**Result:** 49 rows · detected 45 · not_detected 2 · not_observable 1 · not_applicable 1 · detection rate 45/47 = 95.7% of judged. 7 false-pass attempts: 0 unexpected passes. 12/12 evaluator-internal mutations killed. The two not-detected rows are recorded evaluation limitations (greedy matching L3; run-specific values inside hashed observation fields).
The system survived the tested mutations; this is not a proof of correctness.

## P0.9C Final Closure — Final evaluation + controlled baseline refresh

**Baselines refreshed: YES — both together** (`vertical-fixtures`, `runtime-mechanics`), via the validated record `baselines/refresh/p09c-final.refresh.json`.

- **Final evaluation** (3 separate-process runs, byte-identical) classified against the historical baselines: 0 `semantic_regression`, 0 `not_comparable`. runtime-mechanics → `compatible` (1 expected_metric_addition). vertical-fixtures → `review_required`, all explained: 26 expected_metric_addition, 3 golden_expectation_change (declared in Steps 3/4), 1 evaluation_version_change, 7 representation_only, 6 known_historical_drift (P0.9A/P0.9B intentional).
- **Reason for refresh:** the historical baselines predate Steps 1–6 (and vertical-fixtures predates evaluation versioning), so every candidate needed review. The accepted baselines are now the reviewed final evaluation; predecessors retained unchanged in `baselines/archive/` (sha256 `1b98f1acd213…` runtime-mechanics, `ea4d33081f6b…` vertical-fixtures), manifest entries kept as `historical`.
- **Evaluation version `p0.9c-1` unchanged; no golden expectation, suite, ground-truth, metric or definition changed.** Step 8 result unchanged (45/47 detected, 0 false-pass, 12/12 evaluator-internal killed).
- **Policy change (Decision C), `src/baseline.ts`:** `declaredPopulationChanges` → `population_change` for future declared population changes; `knownDrift` remains `known_historical_drift`. No report byte changed.
- **Deferred:** observation-level run-specific guard (Decision A); L3 greedy matching accepted as a known limitation (Decision B).
- **Tests:** `test/p09c-closure.test.ts` added; tests that read the old baseline files now read the retained predecessors (intent preserved); `apps/cli/test/benchmark.test.ts` byte guard compares the full output with the accepted baseline.
