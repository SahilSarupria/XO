# XO Benchmark — Evaluation Model

**P0.9C Step 2.** This document is the normative statement of what the benchmark measures, what counts as correct, what the
denominators are, what is unknown, and how to read the results. It **describes** the 20 historical metrics exactly as they behave; it does
**not** redefine, rename, re-scope or re-score any of them. The machine-checkable shadow of this document is
`src/evaluation-model.ts`; `test/evaluation-model.test.ts` pins the two together and pins the evaluator's behavior where this document
says a behavior is a *limitation* (§12) rather than a design.

Companion documents: `README.md` (package overview, definition data model), `CHANGELOG.md` (dated ground-truth / baseline changes).
Step 1 (configuration attribution, `src/attribution.ts`) is implemented and is **not** repeated here.

---

## 1. What the benchmark answers

| Question | Answer lives in |
|---|---|
| What exactly is being measured? | §4 (dimensions), §11 (per-metric reference) |
| What constitutes a correct result? | §3 (vocabulary), §11 (numerator column) |
| What is the denominator? | §5 |
| What is unknown / unmeasured / not observable? | §3.3, §8 |
| How should results be interpreted? | §6–§10, §13 |

The benchmark is an **evaluation** layer. It contains no extractor, resolver, composer or executor, and it never applies a threshold.
There is **no combined score**: every metric stands alone, with its own numerator, denominator and the exact items behind the gap.

## 2. The evaluation cycle (pure)

```
observe            observeCase(def)            runs the REAL pipeline, records what each stage produced   (impure: the pipeline)
   │
   ▼
compare            evaluateCase(def, obs)      observation vs. declared expectations                        ┐
classify           item outcomes (§3.1)        found / incorrect / missing / unexpected / spurious …        │ PURE
calculate          MetricBuilder               numerator / denominator / ratio, sorted lists                ┘
   │
   ▼
aggregate          buildReport(cases)          micro-average (§7)
compare runs       compareReports(base, cur)   item-aware verdicts, findings (§9)
```

`(definition, observation) → CaseEvaluation` is a pure function. It must not, and does not: modify XOIR, capabilities, workflows or
runtime state; alter compiler output; repair an observation; or infer missing evidence. Every list is sorted before use, so no number
depends on list order; there are no timestamps, so a report is byte-deterministic. `interpretCase` and every helper in
`evaluation-model.ts` are read-only in the same sense. (Pinned by the *purity* and *deterministic* tests, which run the evaluator on
deeply frozen inputs.)

## 3. Vocabulary

### 3.1 Item outcomes — what happened to one expected or observed thing

| Outcome | Meaning |
|---|---|
| `found` | expected, located, and every assertion about it holds |
| `incorrect` | expected and **located**, but at least one assertion fails (wrong class, wrong resolution, wrong content …) |
| `missing` | expected, **not located** at all |
| `unexpected` | observed, in a **closed-world** scope, and claimed by no expectation |
| `spurious` | observed, and explicitly **forbidden** by the definition |
| `passed` / `failed` / `not_run` | execution requests: outcome equals the expectation / differs / the request never ran |

"Located" is *identity* (`identify` predicates, a name matcher, an exact step set); "correct" is *assertion*. `incorrect` and `missing` are
different failures and are never merged.

### 3.2 The six accounting states

Every result the benchmark can report falls into exactly one of these. They are **not** collapsed into one number.

| State | Meaning | Where it is visible |
|---|---|---|
| **correct** | expected, located, assertions hold | metric `numerator`; item `found` / `passed` |
| **incorrect** | located but wrong | metric `mismatched[]`; item `incorrect` / `failed` |
| **missing** | expected but absent (or not run) | metric `missing[]`; item `missing` / `not_run` |
| **unexpected** | observed and not claimed (closed world) **or** forbidden-and-present | metric `unexpected[]`; item `unexpected` / `spurious` |
| **unmeasured** | the metric exists for this case but nothing could be evaluated | metric present, `denominator: 0`, `ratio: null`, `measured: false` |
| **not applicable** | no expectation of that kind was declared / produced any assertion | metric **absent** from the result |

`measurementState(metric)` returns `'not_applicable' | 'unmeasured' | 'measured'` for the last three rows.

**`0/0`, `0/N` and "unknown" are three different facts.** `0/N` (N > 0) is *measured and entirely failing* — ratio `0`. `0/0` is *unmeasured*
— ratio `null`, never `0` and never `1`. "Unknown / N" — an assertion that could not be evaluated because its upstream item was never located —
is **not counted** (see L4): the report shows the upstream miss (recall) but not how many assertions went unevaluated.

### 3.3 Observation states — what could be observed at all

These describe the *input* to evaluation. They are never scored: not a failure, not a success.

| State | Meaning | Examples |
|---|---|---|
| `observed` | the stage ran (`ok`) or ran and failed (`failed`); either is a real observation | — |
| `not_observable` | the layer cannot show it, or the stage was skipped | compile stage on a serialized-XOIR entry; `experienceUnit` links at XOIR level; stages after a failed stage |
| `not_exercised` | nothing asked for it | `ai: not_exercised` (AI belongs to P1.5); execution stage `not_requested`; the package / installed path (only the live graph is benchmarked) |
| *(absent)* | a value that is legitimately not there | `producedBy` on node kinds P0.9A leaves unattributed; `qualityState` for source types the quality pass never runs on |

`stageObservability(status)` implements the stage rows. Absence of `producedBy` is **never** treated as incorrect here; whether it is *wrong*
is Step 4's question, answered against golden expectations.

## 4. Evaluation dimensions

| Dimension | Status | Metrics / owner |
|---|---|---|
| **Semantic quality** | measured | `compileOutcomeAccuracy` · `semanticRecall` · `semanticCorrectness` · `semanticPrecision` · `spuriousFactAvoidance` · `capabilityRecall` · `capabilityPrecision` · `spuriousCapabilityAvoidance` · `structuredIoAccuracy` · `workflowRecall` · `workflowPrecision` |
| **Resolution** | measured | `resolutionAccuracy`. "Unresolved outcomes" are both an *expectation* (`resolution: unresolved | ambiguous | denied`) and an *expectation-free distribution* (`observed.capabilities.byResolution`), so unresolved results stay visible even when nothing was expected |
| **Execution** | measured | `executionClassAccuracy` (deterministic / HITL / not_executable, with an expected→actual `breakdown`) · `workflowExecutabilityAccuracy` · `workflowStructureAccuracy` · `dataFlowCorrectness` · `executionCorrectness` (expected execution outcome) · `runtimeDataFlowTransfer` |
| **Evidence / provenance** | measured (source references only); expanded in **Step 5** | `provenanceCompleteness` · `observedSourceRefCoverage` |
| **Configuration / path attribution** | implemented (**Step 1**) | `CaseAttribution`; descriptive, feeds no metric |
| **Cross-path consistency** | defined here (§13), implemented in **Step 6** | — |

Grouping metrics under a dimension is interpretive; it does not affect any computation. Semantic quality and execution are deliberately
not blended.

## 5. Denominators are first-class

### 5.1 Universal rules

* Every metric result carries `numerator`, `denominator`, `ratio`, `measured`, and the item lists.
* `ratio = round(numerator / denominator, 6 decimals)` and is **`null` iff `denominator == 0`**. `measured` ⇔ `denominator > 0`.
* Failed units are `denominator − numerator`. The item lists **explain** them; they are not a partition of them (L6).

### 5.2 The population a denominator counts

| Population | Counts | Metrics |
|---|---|---|
| `compile_expectation` | 1 per case declaring `expect.compile` | `compileOutcomeAccuracy` |
| `expected_items` | every expected item; a miss **stays** in the denominator | `semanticRecall` · `capabilityRecall` · `workflowRecall` |
| `located_expected_items` | expected items that were **located** | `semanticCorrectness` · `resolutionAccuracy` · `executionClassAccuracy` · `workflowExecutabilityAccuracy` |
| `located_assertions` | assertions attached to located items | `structuredIoAccuracy` · `provenanceCompleteness` · `workflowStructureAccuracy` · `dataFlowCorrectness` |
| `observed_items` | every **observed** item in a closed scope (precision), or every observed node (descriptive) | `semanticPrecision` · `capabilityPrecision` · `workflowPrecision` · `observedSourceRefCoverage` |
| `forbidden_specs` | 1 per forbidden spec (not per hit) | `spuriousFactAvoidance` · `spuriousCapabilityAvoidance` |
| `execution_requests` | every requested execution, run or not | `executionCorrectness` |
| `expected_injections` | every expected producer→consumer injection, run or not | `runtimeDataFlowTransfer` |

### 5.3 Conditional vs unconditional

* **Compile-side assertions are conditional on the upstream item being located.** A missing capability is one `capabilityRecall` miss; the
  class / resolution / I/O / data-flow assertions attached to it are *not* additionally counted as failures. This avoids double-penalising
  one root cause, at the price of L4.
* **Execution-side requests are unconditional.** A request that could not run is a failure of *that request*, attributed (via
  `attributedStage`) to the stage that caused it. `runtimeDataFlowTransfer` counts expected injections even when their workflow never ran,
  whereas the same binding asserted by `dataFlowCorrectness` is not counted when its workflow was not found.

### 5.4 Presence: unmeasured vs not applicable

| Emission | Rule | Metrics |
|---|---|---|
| `when_declared` | present whenever the case declares that *kind* of expectation, even if nothing could be evaluated (then **unmeasured**: `0/0`, `null`) | `compileOutcomeAccuracy` · `semanticRecall` · `semanticCorrectness` · `semanticPrecision` · `spuriousFactAvoidance` · `capabilityRecall` · `capabilityPrecision` · `spuriousCapabilityAvoidance` · `workflowRecall` · `workflowPrecision` · `executionCorrectness` |
| `when_measured` | present only if the denominator is > 0; otherwise **absent** (not applicable) | `provenanceCompleteness` · `resolutionAccuracy` · `executionClassAccuracy` · `structuredIoAccuracy` · `workflowExecutabilityAccuracy` · `workflowStructureAccuracy` · `dataFlowCorrectness` · `runtimeDataFlowTransfer` |
| `descriptive` | present when the graph is observable | `observedSourceRefCoverage` |

A `when_declared` metric can be unmeasured only if its denominator can be 0: `semanticCorrectness` (nothing located), and the three
closed-world precision metrics (nothing observed). The other `when_declared` metrics always have a positive denominator when present. The
split is not uniform by design history (L9); both forms mean "no evidence", and neither may be read as 0% or 100%.

## 6. Open world vs closed world

Open/closed world is **declared by the author** and preserved exactly as the suites declare it: `semantics.closedWorldKinds[]`,
`capabilities.closedWorld`, `workflows.closedWorld`, and `workflows[].dataFlow.closedWorld`. Nothing is inferred and no fixture is
promoted to closed-world to make a precision computable.

| | Closed world (author declared the list complete) | Open world (default; the golden list is partial) |
|---|---|---|
| Observed item claimed by no expectation | `unexpected` — a false positive; counts in the precision denominator | ignored: absence from a partial list says nothing |
| Precision metric | emitted (`semanticPrecision`, `capabilityPrecision`, `workflowPrecision`) | **not emitted** — never a silent 100% |
| Recall (expected → found) | unchanged | unchanged — recall never needs a complete list |
| `forbidden[]` traps | judged | **still judged**: an explicit trap is a known false positive, valid in any world |
| Scope | only the declared kinds / lists: a node of a kind not in `closedWorldKinds` is never judged | — |
| Data flow | extra **proven** bindings fail only when that workflow's `dataFlow.closedWorld` is true | extra proven bindings are not judged |

Consequently, "unmeasured precision" in an open-world case means "no closed scope was declared", not "no false positives".

## 7. Micro-averaging

* **Per case:** each metric is computed from that case's own assertions.
* **Aggregate:** `numerator = Σ case numerators`, `denominator = Σ case denominators`, `ratio = numerator / denominator` (rounded as above).
  A case with more expected items weighs proportionally more; this is the intended semantics ("each assertion counts once").
* **Not a mean of ratios.** Two cases at 1/2 and 3/4 aggregate to 4/6 (0.666667), not 0.625.
* **Unmeasured cases** (present, `0/0`) add nothing to either sum. If *every* contributing case is `0/0`, the aggregate is `0/0` — still
  unmeasured, `null`.
* **Cases where the metric is absent** contribute nothing and cannot dilute it.
* **Item lists** are concatenated, each item tagged with its `caseId`; `breakdown` counts are summed.
* `report.measured` is true iff at least one **non-descriptive** metric has a positive aggregate denominator; `observedSourceRefCoverage`
  never makes an otherwise expectation-free suite count as measured.
* `harness_error` cases are excluded from every metric and counted separately (`harnessErrorCount`): neither an XO pass nor an XO failure.
* Macro-averaging is **not** implemented and does not replace this. It is a possible future *additional* view (per-case-weighted-equally),
  useful when one large fixture dominates; it would need its own name and would not change any existing metric.

## 8. Unknown, unmeasured, not observable

The evaluator must not fabricate evidence, so each of these stays what it is:

| Situation | Reported as | Never |
|---|---|---|
| Nothing declared / nothing evaluable for a metric | absent (not applicable) or `0/0` `null` (unmeasured) | `0%`, `100%` |
| AI-enabled extraction | `attribution.configuration.ai = "not_exercised"`; no AI metric, no AI variant (P1.5) | a failed or passed AI check |
| Execution stage not requested | stage `not_requested` → `not_exercised`; no execution metric | an execution failure |
| Package / installed path | not represented (`graphForm: live_graph` only) | a passing "package" check |
| Compile stage on a serialized-XOIR entry | stage `skipped` → `not_observable` | evidence that compilation worked (but see L1) |
| Link not visible at the observed layer (e.g. `experienceUnit` at XOIR level) | reserved for Step 5 as `not_observable` | a missing link |
| `producedBy` absent | counted in `producerDistribution.unattributed` | an error (Step 4 decides against goldens) |

`interpretCase(evaluation)` returns advisory notes for the data-dependent cases (`compile_outcome_not_observable`, `metric_unmeasured`). It
never alters, drops or reclassifies a metric.

## 9. Metrics vs. warnings

* A **metric** is a numerical statement about correctness or coverage. A **warning** is an important *change* that does not by itself mean
  behavior is incorrect. Warnings never change a metric, a verdict or the classification.

| Finding | List | Drives `classification` / CLI exit? |
|---|---|---|
| `metric_regression` (verdict `regressed` or `mixed`) | `regressions` | **yes** |
| `case_removed` (measurements lost) | `regressions` | **yes** |
| `tradeoff` (recall up, precision partner down, or vice-versa) | `tradeoffs` | **yes** |
| `metric_improvement` | `improvements` | yes (`improved` / `mixed`) |
| `coverage_reduced` (a metric's denominator shrank) | `warnings` | **no** |
| `case_added` | `warnings` | no |
| `configuration_changed` (Step 1) | `warnings` | no |
| `harness_error` (a case the harness could not run, or a suite-id mismatch) | `warnings` | no in `compareReports`; the CLI `run` command separately exits 1 on any harness error |

Verdicts are **item-aware**: a change that fixes one item and breaks another is `mixed`, never `unchanged`, even at an identical ratio.
Classification is `regressed`/`mixed` ⇒ CLI exit 1; `no_change`/`improved` ⇒ 0. Descriptive metrics are compared like any other; being
descriptive only excludes them from `report.measured`.

## 10. Population change vs. measurement coverage

Two different things can shrink a denominator:

| | **Measurement coverage reduced** | **Evaluation population intentionally changed** |
|---|---|---|
| What happened | assertions that used to be evaluated no longer are (an upstream item vanished, a case was removed) | the compiler now *produces* a different set of items (e.g. P0.9A table quarantine removed table nodes) |
| Denominator affected | conditional metrics (`located_*`), `expected_items` never | `observed_items` metrics (`semanticPrecision`, `capabilityPrecision`, `workflowPrecision`, `observedSourceRefCoverage`) |
| Is it a regression? | Yes when it is a loss (a missing item is a `capabilityRecall` regression) | **No** — items that disappeared from the output are `resolved`, not `newlyFailing` |
| What the comparator emits today | `coverage_reduced` warning (+ the recall regression that caused it) | the same `coverage_reduced` warning, **and** a verdict from the items (typically `improved` or `unchanged`) |

The comparator today **cannot tell these apart** (L10): both are one `coverage_reduced` warning on the metric, and a denominator *increase*
emits no finding. This document defines the semantics; the mechanism (an explicit population-change record and an approved-change protocol)
belongs to **Step 7** and is deliberately not built here. Until then: read a `coverage_reduced` warning together with the metric's
`resolved` / `newlyFailing` items. Shrinkage with `resolved` items and no `newlyFailing` ones is a population change; shrinkage
accompanied by a recall regression is a loss.

The committed `vertical-fixtures` baseline predates P0.9A quarantine and carries known, intentional drift. Measured against a current run
(Step 1 state): the aggregate classification is `no_change`; the only metric-level effect is one `coverage_reduced` warning on
`observedSourceRefCoverage` in `burglary-policy-schedule` (aggregate 495 → 484 observed nodes, ratio 1 → 1); three cases show changed
*stage fingerprints* with no metric movement (`burglary-policy-schedule`: compile; `openapi-operation-data-flow` and
`structured-operation-data-flow`: compile + capabilities). That is exactly the population-change signature above. The baseline is preserved
until Step 7.

---

## 11. Reference: the 20 historical metrics

Each entry below is generated from `METRIC_MODEL` (`src/evaluation-model.ts`) and the *verbatim* definition text committed in the baselines.
None was renamed or redefined in Step 2. Every metric shares this classification behavior (§9): its regression **verdict** is derived from
the ratio's direction *and* the sets of failing items (`newlyFailing` / `resolved`), so a swap of one failure for another is `mixed`; a
shrinking denominator adds a `coverage_reduced` warning; unmeasured → measured (or the reverse) is a change in coverage, not a change in
correctness.

#### `compileOutcomeAccuracy`

| | |
|---|---|
| Stage · dimension · role | compile · semantic_quality · graded |
| Definition (historical, verbatim) | compile outcome (succeeds / fails with the expected code) equals the expected outcome / 1 |
| Numerator | 1 if the compile outcome (succeeds / fails with the expected code) equals the expectation |
| Denominator | 1 per case that declares expect.compile |
| Denominator population | `compile_expectation` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (denominator is always 1 when present) |
| Counts toward suite `measured` | yes |
| Limitations | L1, L11 |

#### `observedSourceRefCoverage`

| | |
|---|---|
| Stage · dimension · role | compile · evidence_provenance · descriptive |
| Definition (historical, verbatim) | observed XOIR nodes carrying at least one source reference / observed XOIR nodes (descriptive; no expectation involved) |
| Numerator | observed nodes carrying at least one source reference |
| Denominator | all observed nodes (only when compile did not fail and at least one node exists) |
| Denominator population | `observed_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `descriptive` |
| Unmeasured / unknown | absent when compile failed or no node was observed |
| Counts toward suite `measured` | **no** (descriptive) |
| Limitations | L8 |

#### `provenanceCompleteness`

| | |
|---|---|
| Stage · dimension · role | compile · evidence_provenance · graded |
| Definition (historical, verbatim) | expected evidence specs satisfied by the located item / evidence specs on located items (facts and capabilities) |
| Numerator | evidence specs satisfied by the located item (min refs / document / pages) |
| Denominator | evidence specs attached to LOCATED facts and capabilities |
| Denominator population | `located_assertions` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no located item carries an evidence spec |
| Counts toward suite `measured` | yes |
| Limitations | L4, L7 |

#### `semanticCorrectness`

| | |
|---|---|
| Stage · dimension · role | compile · semantic_quality · graded |
| Definition (historical, verbatim) | expected facts located and correct / expected facts located (identity matched) — isolates "wrong" from "absent" |
| Numerator | located expected facts whose assertions all hold |
| Denominator | expected facts that were located (identity matched) |
| Denominator population | `located_expected_items` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | facts are declared but none was located (0/0) |
| Counts toward suite `measured` | yes |
| Limitations | L4, L6, L9 |

#### `semanticPrecision`

| | |
|---|---|
| Stage · dimension · role | compile · semantic_quality · graded |
| Definition (historical, verbatim) | observed nodes (of closed-world kinds) matched by a correct expected fact / all observed nodes of those kinds |
| Numerator | observed nodes of closed-world kinds chosen by a CORRECT expected fact |
| Denominator | all observed nodes of the closed-world kinds |
| Denominator population | `observed_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | **closed-world only** — emitted only when the author declared the list complete |
| Emitted | `when_declared` |
| Unmeasured / unknown | closedWorldKinds is declared but no node of those kinds was observed (0/0) |
| Counts toward suite `measured` | yes |
| Limitations | L2, L3, L9 |

#### `semanticRecall`

| | |
|---|---|
| Stage · dimension · role | compile · semantic_quality · graded |
| Definition (historical, verbatim) | expected semantic facts located AND correct / expected semantic facts |
| Numerator | expected facts located AND every assertion holds |
| Denominator | expected facts |
| Denominator population | `expected_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when facts are declared) |
| Counts toward suite `measured` | yes |
| Limitations | L3 |

#### `spuriousFactAvoidance`

| | |
|---|---|
| Stage · dimension · role | compile · semantic_quality · avoidance |
| Definition (historical, verbatim) | forbidden facts absent from the output / forbidden facts |
| Numerator | forbidden fact specs with no matching observed node |
| Denominator | forbidden fact specs |
| Denominator population | `forbidden_specs` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when forbidden facts are declared) |
| Counts toward suite `measured` | yes |
| Limitations | L5, L6 |

#### `capabilityPrecision`

| | |
|---|---|
| Stage · dimension · role | capabilities · semantic_quality · graded |
| Definition (historical, verbatim) | discovered capabilities matched by an expectation / all discovered capabilities (closed-world suites only) |
| Numerator | discovered capabilities claimed by an expectation (identity only) |
| Denominator | all discovered capabilities |
| Denominator population | `observed_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | **closed-world only** — emitted only when the author declared the list complete |
| Emitted | `when_declared` |
| Unmeasured / unknown | capabilities.closedWorld is true but nothing was discovered (0/0) |
| Counts toward suite `measured` | yes |
| Limitations | L2, L3, L9 |

#### `capabilityRecall`

| | |
|---|---|
| Stage · dimension · role | capabilities · semantic_quality · graded |
| Definition (historical, verbatim) | expected capabilities discovered (identity matched) / expected capabilities |
| Numerator | expected capabilities whose name matcher located a discovered capability (identity only) |
| Denominator | expected capabilities |
| Denominator population | `expected_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when capabilities are declared) |
| Counts toward suite `measured` | yes |
| Limitations | L3 |

#### `executionClassAccuracy`

| | |
|---|---|
| Stage · dimension · role | capabilities · execution · graded |
| Definition (historical, verbatim) | discovered capabilities whose execution class equals the expected one / discovered capabilities with an expected class (deterministic_rule \| human_in_the_loop \| not_executable) |
| Numerator | located capabilities whose execution class equals the expected one |
| Denominator | located capabilities that declare an expected execution class |
| Denominator population | `located_expected_items` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no located capability declares an expected class |
| Counts toward suite `measured` | yes |
| Limitations | L4, L9 |

#### `resolutionAccuracy`

| | |
|---|---|
| Stage · dimension · role | capabilities · resolution · graded |
| Definition (historical, verbatim) | discovered capabilities whose binding resolution equals the expected one / discovered capabilities with an expected resolution |
| Numerator | located capabilities whose binding resolution equals the expected one |
| Denominator | located capabilities that declare an expected resolution |
| Denominator population | `located_expected_items` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no located capability declares an expected resolution |
| Counts toward suite `measured` | yes |
| Limitations | L4, L9 |

#### `spuriousCapabilityAvoidance`

| | |
|---|---|
| Stage · dimension · role | capabilities · semantic_quality · avoidance |
| Definition (historical, verbatim) | forbidden capabilities absent / forbidden capabilities |
| Numerator | forbidden capability specs with no matching discovered capability |
| Denominator | forbidden capability specs (one per trap, not per hit) |
| Denominator population | `forbidden_specs` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when forbidden capabilities are declared) |
| Counts toward suite `measured` | yes |
| Limitations | L5 |

#### `structuredIoAccuracy`

| | |
|---|---|
| Stage · dimension · role | capabilities · semantic_quality · graded |
| Definition (historical, verbatim) | declared input/output parameter sets exactly equal to the expected sets / expected parameter-set assertions |
| Numerator | declared input/output parameter sets exactly equal to the expected set |
| Denominator | input/output set assertions on located capabilities |
| Denominator population | `located_assertions` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no located capability declares expected inputs/outputs |
| Counts toward suite `measured` | yes |
| Limitations | L4, L6, L9 |

#### `dataFlowCorrectness`

| | |
|---|---|
| Stage · dimension · role | workflows · execution · graded |
| Definition (historical, verbatim) | data-flow assertions satisfied (proven bindings present, not_proven bindings absent, no extra proven bindings in closed-world workflows) / data-flow assertions, over found workflows |
| Numerator | binding assertions satisfied (proven present, not_proven absent, no extra proven when the workflow is closed-world) |
| Denominator | binding assertions on found workflows (+ one failing unit per unclaimed extra proven binding, closed-world workflows only) |
| Denominator population | `located_assertions` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no found workflow declares data-flow expectations |
| Counts toward suite `measured` | yes |
| Limitations | L4, L9 |

#### `workflowExecutabilityAccuracy`

| | |
|---|---|
| Stage · dimension · role | workflows · execution · graded |
| Definition (historical, verbatim) | found workflows whose audit status equals the expected executability / found workflows with an expected executability |
| Numerator | found workflows whose audit status equals the expected executability |
| Denominator | found workflows that declare an expected executability |
| Denominator population | `located_expected_items` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no found workflow declares an expected executability |
| Counts toward suite `measured` | yes |
| Limitations | L4, L9 |

#### `workflowPrecision`

| | |
|---|---|
| Stage · dimension · role | workflows · semantic_quality · graded |
| Definition (historical, verbatim) | observed workflows matched by an expectation / all observed workflows (closed-world suites only) |
| Numerator | observed workflows claimed by an expectation (identity only) |
| Denominator | all observed workflows |
| Denominator population | `observed_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | **closed-world only** — emitted only when the author declared the list complete |
| Emitted | `when_declared` |
| Unmeasured / unknown | workflows.closedWorld is true but no workflow was observed (0/0) |
| Counts toward suite `measured` | yes |
| Limitations | L2, L3, L9 |

#### `workflowRecall`

| | |
|---|---|
| Stage · dimension · role | workflows · semantic_quality · graded |
| Definition (historical, verbatim) | expected workflows found (steps match exactly, any order) / expected workflows |
| Numerator | expected workflows found (exact step set, any order) |
| Denominator | expected workflows |
| Denominator population | `expected_items` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when workflows are declared) |
| Counts toward suite `measured` | yes |
| Limitations | L3 |

#### `workflowStructureAccuracy`

| | |
|---|---|
| Stage · dimension · role | workflows · execution · graded |
| Definition (historical, verbatim) | found workflows whose step order / per-step execution classes equal the expected ones / such assertions |
| Numerator | step-order and per-step-class assertions that hold on found workflows |
| Denominator | step-order and step-class assertions on found workflows |
| Denominator population | `located_assertions` (conditional on the upstream item being located) |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no found workflow declares order or step classes |
| Counts toward suite `measured` | yes |
| Limitations | L4, L9 |

#### `executionCorrectness`

| | |
|---|---|
| Stage · dimension · role | execution · execution · graded |
| Definition (historical, verbatim) | execution requests whose observed outcome (status/output/steps) equals the expected one / execution requests |
| Numerator | execution requests whose observed outcome (status / output / steps / error code) equals the expectation |
| Denominator | execution requests (a request that was not run counts, as `not_run`) |
| Denominator population | `execution_requests` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_declared` |
| Unmeasured / unknown | never (emitted only when execution cases are declared) |
| Counts toward suite `measured` | yes |
| Limitations | — |

#### `runtimeDataFlowTransfer`

| | |
|---|---|
| Stage · dimension · role | execution · execution · graded |
| Definition (historical, verbatim) | expected producer->consumer injections the RUNTIME actually performed (consumer received the producer value) / expected injections |
| Numerator | expected producer→consumer injections the runtime actually performed |
| Denominator | expected injections across workflow requests (counted even when the workflow could not be run) |
| Denominator population | `expected_injections` |
| Ratio | `numerator / denominator`, rounded to 6 places; `null` iff denominator = 0 |
| World | open- or closed-world (never requires a complete list) |
| Emitted | `when_measured` |
| Unmeasured / unknown | absent when no workflow request declares injections |
| Counts toward suite `measured` | yes |
| Limitations | L9 |

---

## 12. Known limitations (documented, deliberately not changed)

The audit found the evaluator's behavior internally consistent and found **no defect that justifies changing a historical metric**. It did find
the following properties that a reader must know. Each is recorded in `KNOWN_LIMITATIONS`; those with observable behavior are pinned by a test
so they cannot drift silently. None was "fixed": doing so would silently redefine a historical metric.

| # | Limitation | Disposition |
|---|---|---|
| **L1** | `compileOutcomeAccuracy` (`succeeds`) passes whenever the compile stage did not fail. On a serialized-XOIR entry the stage is `skipped`, so the expectation passes **vacuously**. `runtime-mechanics` reports `compileOutcomeAccuracy = 1/1` with compile `skipped`. | Number unchanged. `interpretCase` flags it. **Decision needed** (see the Step 2 report): keep + flag, or scope the metric to source entries in Step 7 with a deliberate baseline refresh. |
| **L2** | Precision is not uniform: `semanticPrecision` needs the claiming fact to be *correct*; `capabilityPrecision` / `workflowPrecision` count any identity match. | Documented. Wrongness of a located capability is measured by `resolutionAccuracy` / `executionClassAccuracy` / `structuredIoAccuracy`. Revisit in Step 3 only if goldens need it. |
| **L3** | Matching is greedy over id-sorted expectations. When every candidate is claimed the first is reused, so two expectations can be satisfied by one observed item (recall can over-count). | Latent: no committed suite triggers it (checked across all 8 cases). Step 3 goldens should keep matchers unambiguous; a guard belongs to Step 8. |
| **L4** | Conditional-denominator metrics do not count assertions on expected items that were never located; the report does not record how many assertions went unevaluated. | Documented. Step 7 (coverage bookkeeping) / Step 8. |
| **L5** | Avoidance metrics count 1 unit per forbidden spec but list every hit. | Documentation only. |
| **L6** | Item lists explain a gap but do not partition it; `semanticCorrectness` can fail with empty lists (its cause is `semanticRecall.mismatched`). | Documentation only. |
| **L7** | `provenanceCompleteness` pools fact and capability evidence specs, and audits source-reference presence only — not derivation or producer chains. | Step 5. |
| **L8** | `observedSourceRefCoverage`'s denominator is the observed node population, so compiler changes move it. | Documented (§10). |
| **L9** | Emission is not uniform: some metrics are present-`0/0` when declared-but-empty, others absent. | Documented. Uniformizing changes report bytes and both baselines; out of scope. |
| **L10** | The comparator cannot distinguish an intentional population change from lost coverage; a denominator increase emits nothing. | Step 7. |
| **L11** | Stage status `skipped` means both "entry bypasses the stage" and "an earlier stage failed". | Documented; `stageObservability` maps both to `not_observable`. A distinct status value is a schema change for later. |

`spuriousCapabilityAvoidance` deserves an explicit note. It measures **avoidance of explicitly forbidden capability traps** — nothing more.
A value of `0/10` means all ten listed traps are present in the output. That is a genuine quality gap and is recorded, not tuned: the
forbidden list was not weakened and extraction was not touched. It must not be read as the overall false-positive rate (which is measured,
where a closed world is declared, by `capabilityPrecision`).

## 13. Reserved evaluation semantics (Steps 4–6) — defined, not implemented

Step 2 adds **no** `MetricId`. A new metric is justified only if no existing metric can represent the requirement; the table gives each
candidate's denominator so later steps implement it consistently. All treat `not_applicable`, `not_observable` and `not_exercised` as
*excluded from the denominator*, never as failures or successes. These are exported as `RESERVED_DIMENSIONS`.

| Candidate | Owner | Existing metric that could carry it? | Denominator unit | Correct means | Not measured |
|---|---|---|---|---|---|
| `producerAttributionCoverage` | Step 4 | none (`producedBy` is descriptive only) | observed nodes whose kind the goldens say **must** carry a producer | `producedBy` present | kinds with no golden producer expectation are `not_applicable` (P0.9A leaves some unattributed by design) |
| `producerAttributionCorrectness` | Step 4 | none | observed nodes that carry `producedBy` **and** have a golden expected producer | observed producer = expected producer | nodes without `producedBy` are counted by *coverage*, not here |
| `provenanceChainCoverage` | Step 5 | `provenanceCompleteness` covers source-ref presence only (L7) | located items for which a derivation chain is expected | the chain reaches a source reference through every required link | a link not representable at the observed layer (e.g. `experienceUnit` at XOIR level) is `not_observable` |
| `contractBindingLinkage` | Step 5 | none (`resolutionAccuracy` / `executionClassAccuracy` observe the *outcome*, not the link) | located capabilities with an expected contract/binding link | linked to the expected contract and binding | graph forms that hide the link are `not_observable` |
| `executionProvenanceAgreement` | Step 5 | none | executed requests that record provenance | recorded provenance agrees with the capability's compile-side declaration | un-run requests are `not_exercised`; requests recording no provenance are `not_observable` |
| `crossPathConsistency` | Step 6 | none — it is a *relation* between two results | (case, observable property) pairs for which **both** compared paths were exercised | property equal across the paths | a path not exercised (package / installed, AI) makes the pair `not_exercised` and excludes it; zero comparable pairs is `unmeasured` |

`MetricResult` (`numerator` / `denominator` / `ratio` / `measured` / item lists) can already represent each of these, and the three
non-scored states already have a home in §3.3, so **no shared primitive was required in Step 2**.

## 14. Interpreting a report

1. **Read the fraction, not the percentage.** `28/30` and `2/3` are different evidence. `null` is *no evidence*, not 0% and not 100%.
2. **Recall, correctness and precision answer different questions.** Recall: was it found? Correctness: given found, is it right? Precision
   (closed world only): is everything produced expected? A metric moving alone is informative; a recall/precision pair moving in opposite
   directions is reported as a `tradeoff`.
3. **Conditional metrics inherit the recall miss.** Low `executionClassAccuracy` on few located items may sit next to a large recall gap
   (L4). Read them together.
4. **Warnings are prompts to look, not failures.** Look at `resolved` vs `newlyFailing` before deciding whether a `coverage_reduced` is a
   loss or a population change (§10).
5. **Compile-side vs execution-side.** Each item carries `attributedStage`; an execution failure caused by an undiscovered capability is
   attributed to `capabilities`. `executionOnlyRegression` means the compile-side output was unchanged while execution regressed.
6. **`not_exercised` / `not_observable` are scope statements.** The benchmark says nothing about AI extraction, the package / installed
   path, or links the observed layer cannot show.
7. **Baselines are regression references, not claims of correctness.** They record known gaps (e.g. `spuriousCapabilityAvoidance` 0/10).

## 15. Change control

* No metric is renamed or redefined. A change to a definition, denominator population, emission rule or closed-world requirement is a
  change of *evaluation meaning* and must bump `EVALUATION_VERSION` (see `attribution.ts`), update this document and `METRIC_MODEL` together,
  and refresh baselines deliberately, with a `CHANGELOG.md` entry.
* `EVALUATION_VERSION` is **unchanged** by Step 2 (`p0.9c-1`): Step 2 documents and pins existing meaning; it changes no emitted byte.
* `METRIC_MODEL` ↔ evaluator drift is caught by `test/evaluation-model.test.ts`; definition text drift by `test/attribution.test.ts`.

## 16. Addendum — P0.9C Step 4 (producer attribution)

Step 4 adds **two** metrics (22 in total) and leaves the 20 historical definitions untouched (`HISTORICAL_METRIC_IDS`). They belong to a separate dimension,
`producer_attribution`, not to evidence/provenance. Sections 4, 11 and 13 above describe the Step 2 state; read them with this addendum:

| Metric | Role | Population | Emission | Notes |
|---|---|---|---|---|
| `producerAttributionCoverage` | descriptive (no golden expectation; does not count toward `measured`) | `stamping_path_nodes`: nodes created through a knowledge- or capability-extractor path, classified without reading `producedBy` | `when_measured` | absent when compile did not run, when AI is exercised, or when the population is empty; not-judged paths reported in `breakdown` (L12) |
| `producerAttributionCorrectness` | graded | `located_assertions`: located capabilities with a golden `producedBy`, created by a capability extractor, carrying a producer | `when_measured` | conditional on the upstream item (L4); values outside the premise are excluded, never forced (L13) |

The two reserved Step 4 candidates in §13 (`producerAttributionCoverage`, `producerAttributionCorrectness`) are therefore **implemented**, with the denominators
refined from the reserved wording ("nodes the goldens say MUST carry a producer") to architecture-defined populations, for the reasons in `PRODUCER_ATTRIBUTION.md` §4–5.
Two limitations are added: **L12** (un-stamped paths not judged) and **L13** (single-extractor assumption, AI not exercised). Accounting states are unchanged: an absent
producer metric is *not applicable*, never `0%`.

## 17. Addendum — P0.9C Step 5 (evidence / provenance)

Step 5 adds **two** descriptive metrics (24 in total); the 20 historical definitions are untouched and `provenanceCompleteness` / `observedSourceRefCoverage` keep their meaning (see `PROVENANCE_EVALUATION.md` §3).

| Metric | Role | Population | Emission | Notes |
|---|---|---|---|---|
| `provenanceChainCoverage` | descriptive | `observed_capabilities` of a case whose compile ran | `when_measured` | structural connectedness of source -> node -> capability -> contract; binding state observed, not required (L14) |
| `executionProvenanceAgreement` | descriptive | `executed_capabilities` where agreement is determinable | `when_measured` | `unknown` / `not_exercised` / `not_observable` reported, never counted (L15) |

The reserved candidates `provenanceChainCoverage` and `executionProvenanceAgreement` (§13) are therefore **implemented**, with populations defined by architecture and independent structure rather than by golden expectations.
`contractBindingLinkage` stays reserved (deferred). New limitations: **L14** (connectedness, not correctness; ExperienceUnit existence not observable; manifest / runtime not exercised) and **L15** (two derivations of the same graph; live-graph path only).

## 18. Addendum — P0.9C Step 6 (cross-path)

Step 6 adds **one** descriptive metric (25 in total); no earlier definition changes.

| Metric | Role | Population | Emission | Notes |
|---|---|---|---|---|
| `crossPathConsistency` | descriptive | `cross_path_units`: (pair x dimension x subject) on which two in-process paths were both observed and comparable | `when_measured` | only match / mismatch enter the denominator; unknown, not_comparable, not_exercised, not_observable are reported in the breakdown; absent for serialized-XOIR entries; never 100% when empty (L16) |

The reserved candidate `crossPathConsistency` (§13) is therefore **implemented**; its Step 2 denominator ("pairs for which both compared paths were exercised") is realized as the judged units, and a path that was not
built makes the pair `not_exercised`. Only `contractBindingLinkage` remains reserved. **L16:** only in-process paths are compared (live, serialized, package boundary); API, CLI, the installed package and workflow-vs-direct are not.

## 19. Addendum — P0.9C Step 7 (baselines)

No metric is added or redefined. Comparison semantics gain two rules: (1) a metric present on only one side is *absent* (never 0, never "improved"): `metric_added` / `metric_removed` warnings, and a new metric never fails a candidate against a baseline that predates it; (2) `evaluationVersion` and metric-definition
differences are explicit warnings. Accounting states are unchanged; `not_measured` for a baseline is expressed as an absent metric. A change of metric semantics requires an evaluation-version change (§15). See `BASELINE_PROTOCOL.md` for identity, taxonomy and refresh.
