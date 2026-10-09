# XO Benchmark — Evaluation Self-Test

**P0.9C Step 8.** Can the evaluation system itself be trusted? Every mutation below is a deliberately injected defect, applied to a **clone** of a real observation, definition or report (or, for the evaluator-internal set, to a
source file that is restored byte-for-byte), and pushed through the **whole** pipeline: `observation → evaluateCase → buildReport → compareReports → classifyDifferences`. A mutation counts as *detected* only if a number moved in the expected
direction **and** (for degrading mutations) the report comparator and the baseline protocol both flagged it. No production code, baseline, golden expectation or evaluation version was changed.

> **Conclusion.** The evaluation system **survived the tested adversarial mutations**, with the remaining limitations explicitly documented below. This is sensitivity to selected classes of defects; it is **not** a proof that the evaluator is correct.

Machine-checkable: `test/self-test.test.ts` (31 tests) and `test-tools/evaluator-mutations.mjs` (test-only; never imported by the library).

## 1. Model

A mutation has an id, a target, a description, an expected metric movement, an expected classification and an observability status:

| Status | Meaning |
|---|---|
| **detected** | a number moved as expected and the pipeline flagged it |
| **not_detected** | a defect the evaluation does not catch — an *evaluation limitation*, always explained (§5) |
| **not_observable** | the dimension does not exist for that case (the metric is absent, never a pass) |
| **not_applicable** | a change the golden model intentionally permits (open-world extras); nothing should fire |

The mutation score never counts `not_observable` or `not_applicable` as detected, and it is **not** reduced to one number: the matrix below is the evidence.

## 2. Pipeline audited (what can be mutated, observed and not observed)

* **Mutable:** observation nodes / capabilities / workflows / executions / provenance / path views; the case definition; built reports; the manifest context; evaluator source.
* **Observed by metrics:** capability, fact and workflow identity and assertions, resolution, execution class, execution outcome, producer attribution, provenance chain, execution provenance agreement, cross-path agreement, comparator and baseline classification.
* **Not observable:** open-world extras (no precision metric exists); ExperienceUnit existence; the API / CLI / installed paths; compile-side chain, producer and cross-path dimensions of a hand-built case; run-specific values *inside a hashed observation field*.
* **Real fixtures used:** `synthetic-claim-rules`, `structured-operation-data-flow`, `commercial-property-policy`, `runtime-mechanics` (observed once; every mutation works on a clone).

## 3. Mutation matrix

**49 rows · detected 45 · not_detected 2 · not_observable 1 · not_applicable 1 · detection rate 45/47 = 95.7% of judged.**

| Mutation | Target | Expected | Actual | Status | Classification |
|---|---|---|---|---|---|
| M01 | capabilities / recall | capabilityRecall decrease | capabilityRecall 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M02 | capabilities / precision | capabilityPrecision decrease | capabilityPrecision 2/2 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| M02b | capabilities / forbidden | spuriousCapabilityAvoidance decrease | spuriousCapabilityAvoidance 1/1 -> 0/1 ¦ report regressed/regression | **detected** | regressed/regression |
| M02c | capabilities / open world | capabilityRecall unchanged | capabilityRecall 16/18 -> 16/18 | **not_applicable** | - |
| M03 | semantics / recall | semanticRecall decrease | semanticRecall 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M04 | semantics / precision | semanticPrecision decrease | semanticPrecision 1/1 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M05 | execution class | executionClassAccuracy decrease | executionClassAccuracy 12/12 -> 11/12 ¦ report regressed/regression | **detected** | regressed/regression |
| M06a | resolution | resolutionAccuracy decrease | resolutionAccuracy 12/12 -> 11/12 ¦ report regressed/regression | **detected** | regressed/regression |
| M06b | resolution | resolutionAccuracy decrease | resolutionAccuracy 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M07a | execution | executionCorrectness decrease | executionCorrectness 17/17 -> 16/17 ¦ report regressed/regression | **detected** | regressed/regression |
| M07b | execution | executionCorrectness decrease | executionCorrectness 17/17 -> 16/17 ¦ report regressed/regression | **detected** | regressed/regression |
| M08 | producer / correctness | producerAttributionCorrectness decrease | producerAttributionCorrectness 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M09 | producer / coverage | producerAttributionCoverage decrease | producerAttributionCoverage 4/4 -> 3/4 ¦ report regressed/regression | **detected** | regressed/regression |
| M10 | provenance / chain | provenanceChainCoverage decrease | provenanceChainCoverage 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| M11-contractContentHash | provenance / execution agreement | executionProvenanceAgreement decrease | executionProvenanceAgreement 3/3 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| M11-bindingId | provenance / execution agreement | executionProvenanceAgreement decrease | executionProvenanceAgreement 3/3 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| M11-contractId | provenance / execution agreement | executionProvenanceAgreement decrease | executionProvenanceAgreement 3/3 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| M11-masked | provenance / execution agreement | executionProvenanceAgreement decrease | executionProvenanceAgreement 3/3 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| M12 | cross-path / capability | crossPathConsistency decrease | crossPathConsistency 19/19 -> 16/18 ¦ report regressed/regression | **detected** | regressed/regression |
| M13 | cross-path / contract | crossPathConsistency decrease | crossPathConsistency 19/19 -> 18/19 ¦ report regressed/regression | **detected** | regressed/regression |
| M14a | cross-path / execution | crossPathConsistency decrease | crossPathConsistency 19/19 -> 18/19 ¦ report regressed/regression | **detected** | regressed/regression |
| M14b | cross-path / execution provenance | crossPathConsistency decrease | crossPathConsistency 19/19 -> 18/19 ¦ report regressed/regression | **detected** | regressed/regression |
| M14c | cross-path / chain / producer on hand-built XOIR | no metric exists | metrics absent | **not_observable** | not_observable |
| M15 | workflows / recall | workflowRecall decrease | workflowRecall 1/1 -> 0/1 ¦ report regressed/regression | **detected** | regressed/regression |
| M16 | workflows / execution | executionCorrectness decrease | executionCorrectness 17/17 -> 16/17 ¦ report regressed/regression | **detected** | regressed/regression |
| M17 | baseline metric | not identical; a metric-level difference | review_required: semantic_improvement | **detected** | review_required |
| M18a | candidate metric | lost measurement, no improvement credit | regression; improvements 0 | **detected** | regression |
| M18b | baseline metric | explicit: not an expected addition | not_comparable: not_comparable | **detected** | not_comparable |
| M19 | baseline fingerprint | not identical; review/not_comparable | review_required: output¦runtime-mechanics¦capabilities | **detected** | review_required |
| M20 | configuration id | configuration_change, not identical | review_required: configuration_change | **detected** | review_required |
| M21 | evaluation version | evaluation_version_change and no semantic regression claim | review_required: evaluation_version_change | **detected** | review_required |
| M22 | golden expectation | not_comparable (never an improvement or ordinary regression) | not_comparable | **detected** | not_comparable |
| M23 | golden expectation | golden_expectation_change; no semantic_regression | review_required: golden_expectation_change,golden_expectation_change | **detected** | review_required |
| M24 | population | semantic_regression | regression | **detected** | regression |
| M25 | population | only the named metric is explained (Step 7 classifies a declared drift as known_historical_drift) | named=known_historical_drift; unrelated=semantic_regression; decision=regression | **detected** | regression |
| ACC-correct-incorrect | accounting | resolutionAccuracy 1/1 -> 0/1 | resolutionAccuracy 1/1 -> 0/1 | **detected** | accounting |
| ACC-correct-missing | accounting | capabilityRecall 4/4 -> 3/4 | capabilityRecall 4/4 -> 3/4 | **detected** | accounting |
| ACC-unexpected | accounting | capabilityPrecision 4/4 -> 4/6 | capabilityPrecision 4/4 -> 4/6 | **detected** | accounting |
| M-micro | aggregation | aggregate 8/10 (0.8), not 0.5 | aggregate 8/10 | **detected** | micro-average |
| M-greedy | identity matching | detected as ambiguous or not credited twice | recall 2/2 from ONE capability (over-credit); precision 1/2 (under-credit) | **not_detected** | evaluation limitation L3 (recorded, not fixed; the committed suites contain no colliding m |
| M-runspecific | report determinism | rejected by the guard | flagged by findRunSpecificFields and verifyManifestEntry | **detected** | guard |
| M-runspecific-hashed | report determinism | rejected before it reaches a fingerprint | only findRunSpecificFields(observation) sees it; nothing in the pipeline calls it | **not_detected** | evaluation limitation (recorded) |
| FP1 | capabilities | capabilityRecall decrease | capabilityRecall 2/2 -> 1/2 ¦ report regressed/regression | **detected** | regressed/regression |
| FP2 | capabilities | capabilityPrecision decrease | capabilityPrecision 2/2 -> 2/3 ¦ report regressed/regression | **detected** | regressed/regression |
| FP3 | provenance | provenanceChainCoverage decrease | provenanceChainCoverage 33/33 -> 32/33 ¦ report regressed/regression | **detected** | regressed/regression |
| FP4 | execution provenance | executionProvenanceAgreement decrease | executionProvenanceAgreement 13/13 -> 12/13 ¦ report regressed/regression | **detected** | regressed/regression |
| FP5 | cross-path | crossPathConsistency decrease | crossPathConsistency 181/181 -> 180/181 ¦ report regressed/regression | **detected** | regressed/regression |
| FP6 | producer | producerAttributionCorrectness decrease | producerAttributionCorrectness 2/2 -> 0/2 ¦ report regressed/regression | **detected** | regressed/regression |
| FP7 | execution class | executionClassAccuracy decrease | executionClassAccuracy 12/12 -> 11/12 ¦ report regressed/regression | **detected** | regressed/regression |

## 4. False-pass attempts (mandatory)

Seven deliberate attempts to make something wrong and still obtain a passing evaluation: remove an expected capability, inject a spurious capability, break provenance, alter execution provenance, corrupt a cross-path result,
change the producer, change the execution class. For each the metric fell **and** the report was classified `regressed` with baseline decision `regression`. **Unexpected passes: 0** (a blocker if non-zero).

## 5. Not detected — explained (never hidden)

| Mutation | Why it is not detected | Disposition |
|---|---|---|
| **M-greedy** | Two expectations whose matchers both match **one** observed capability are both credited (recall 2/2 from one capability), and a perfect assignment's second candidate is reported unexpected (precision 1/2). This is limitation **L3**, now *realized* by a deterministic fixture. | Recorded, **not fixed** (matching was not redesigned). The committed suites contain no colliding matchers (Step 3 audited all 8 cases; `auditExpectationIntegrity` guards duplicates and contradictions). |
| **M-runspecific-hashed** | A run-specific value (timestamp, run id…) inside a **hashed observation property** changes the stage fingerprint; the report guard (`findRunSpecificFields`) inspects the report, not the hashed observation. Only a test that calls it on the observation sees it; nothing in the pipeline does. | Recorded. All four real observations were checked and carry none in their hashed fields. A pipeline-level observation guard is a decision for you (§9). |

## 6. Accounting, aggregation, matching, determinism

* **Accounting states** (Step 2): correct→incorrect lowers correctness (not recall); correct→missing lowers recall; incorrect→correct improves; an unexpected item is a false positive only in a closed world; a stage that was not requested is `not_observable`, not a failure; an absent metric never enters a denominator; an absent *new* metric never becomes zero and never fails a candidate; a *removed* metric earns no improvement credit.
* **Micro-average:** a 2-item case and an 8-item case; corrupting only the small one gives aggregate **8/10 = 0.8**, not the mean of per-case percentages (0.5).
* **Matching:** see M-greedy; disjoint matchers behave exactly.
* **Determinism:** three evaluations of one observation give identical metrics, items, warnings and report bytes. Injected `timestamp`, `runId`, `hostname`, `createdAt`, `graphHash` or an absolute path in a report are each flagged by the guard and rejected by the manifest check.

## 7. Evaluator-internal mutations

Twelve source mutations of the evaluator itself (numerator +1, denominator −1, pass/fail inverted, `0/0` as 100%, empty-metric-as-measured, ratio over denominator+1, micro→macro average, descriptive metrics counted as measured, a metric diffed against nothing, a dropped evaluation-version difference, any explained difference called "compatible", a graph hash compared across lowering), each run against the full benchmark suite and restored by sha256:

**12 / 12 killed** (the existing suite catches a lying evaluator; between 2 and 104 tests fail per mutation). One additional mutation (E07) was first *not applied* because my pattern named the wrong file; it was fixed and re-run rather than counted.

## 8. Step 7 policy notes the matrix exposed

* A **declared** population change is classified `known_historical_drift` (Step 7's actual policy), not `population_change` (which is reserved for coverage growth / a new case). The declaration explains **only the metric it names**: the unnamed metric stays `semantic_regression`.
* A historical metric absent from a *baseline* is `not_comparable` (not an expected addition); absent from the *candidate* it is a lost measurement.
* An undeclared fingerprint change is `review_required`/`not_comparable`; an undeclared golden change is `not_comparable`; a declared one attributes the metric movement to the golden change.

## 9. Remaining evaluation limitations

1. **L3 greedy matching** can over-credit and under-credit on colliding matchers (§5).
2. Run-specific values inside hashed observation fields are not stopped by any pipeline guard.
3. The mutations are *selected classes*, not exhaustive; open-world extras, ExperienceUnit existence and the unexercised paths are outside what any mutation can reach.
4. Mutation tests exercise the evaluator and protocol on real observations of four cases; the other four cases are covered by the same code paths, not by their own mutations.
