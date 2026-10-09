# P0.9C — Final Report

**Status: P0.9C is CLOSED / FROZEN** (all closure criteria passed — see §7).
Evaluation version `p0.9c-1` (unchanged). Refresh timestamp `2026-10-09T06:28:35Z`.

## 1. Executive Summary

The final evaluation ran end-to-end on both suites (8 cases: 7 vertical + 1 runtime-mechanics), was byte-identical across repeated separate-process runs, and was compared to the Step 7 historical baselines with every difference classified: **0 semantic regressions, 0 not-comparable, 0 unexplained differences**. Both baselines were then refreshed **together** under a validated refresh record, the predecessors were retained unchanged, and the refreshed baselines reproduce exactly. The Step 8 self-test results are intact.

The evaluator survived the selected adversarial self-tests and is accepted as the P0.9C evaluation baseline, subject to the documented limitations.

This is not a claim that the evaluator is proven correct. The benchmark still reports genuine implementation gaps unchanged (e.g. `spuriousCapabilityAvoidance` 0/10) — P0.9C measured them; it did not tune them away.

## 2. Final Evaluation Results

### 2.1 Aggregate (micro-averaged; num/den, "—" = not emitted, never zero)

**vertical-fixtures** (7 cases)

| metric | stage | num/den | ratio |
|---|---|---|---|
| capabilityPrecision | capabilities | 21/22 | 95.5% |
| capabilityRecall | capabilities | 41/46 | 89.1% |
| compileOutcomeAccuracy | compile | 7/7 | 100.0% |
| crossPathConsistency (descriptive) | capabilities | 355/355 | 100.0% |
| dataFlowCorrectness | workflows | 3/3 | 100.0% |
| executionClassAccuracy | capabilities | 33/37 | 89.2% |
| executionCorrectness | execution | 29/30 | 96.7% |
| executionProvenanceAgreement (descriptive) | execution | 18/18 | 100.0% |
| observedSourceRefCoverage (descriptive) | compile | 484/484 | 100.0% |
| producerAttributionCorrectness | capabilities | 4/4 | 100.0% |
| producerAttributionCoverage (descriptive) | compile | 413/413 | 100.0% |
| provenanceChainCoverage (descriptive) | capabilities | 71/71 | 100.0% |
| provenanceCompleteness | compile | 59/59 | 100.0% |
| resolutionAccuracy | capabilities | 33/34 | 97.1% |
| semanticCorrectness | compile | 28/29 | 96.6% |
| semanticPrecision | compile | 22/24 | 91.7% |
| semanticRecall | compile | 28/30 | 93.3% |
| spuriousCapabilityAvoidance | capabilities | 0/10 | 0.0% (known genuine gap, retained) |
| spuriousFactAvoidance | compile | 7/8 | 87.5% |
| structuredIoAccuracy | capabilities | 18/18 | 100.0% |
| workflowExecutabilityAccuracy | workflows | 7/7 | 100.0% |
| workflowPrecision | workflows | 3/3 | 100.0% |
| workflowRecall | workflows | 7/8 | 87.5% |
| workflowStructureAccuracy | workflows | 10/10 | 100.0% |

**runtime-mechanics** (1 case): all 15 emitted metrics 100% (capabilityPrecision/Recall 8/8, executionCorrectness 9/9, executionProvenanceAgreement 10/10, runtimeDataFlowTransfer 2/2, workflowRecall/Precision 4/4, observedSourceRefCoverage 15/15, …). `crossPathConsistency`, producer and provenance-chain metrics are not emitted for this hand-built XOIR case (no comparable paths / no producer expectations): absent, not zero.

No combined score is computed.

### 2.2 Per-suite / per-case (vertical-fixtures; num/den, "—" = not emitted for that case)

| metric | aastha-operations | burglary-policy-schedule | commercial-property-policy | multidoc-burglary-claims | openapi-operation-data-flow | structured-operation-data-flow | synthetic-claim-rules |
|---|---|---|---|---|---|---|---|
| capabilityPrecision | 15/16 | — | — | — | 2/2 | 2/2 | 2/2 |
| capabilityRecall | 15/15 | 1/1 | 16/18 | 3/6 | 2/2 | 2/2 | 2/2 |
| compileOutcomeAccuracy | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| crossPathConsistency | 79/79 | 34/34 | 181/181 | 28/28 | 7/7 | 7/7 | 19/19 |
| dataFlowCorrectness | — | — | 1/1 | — | 1/1 | 1/1 | — |
| executionClassAccuracy | 14/15 | 1/1 | 12/12 | 0/3 | 2/2 | 2/2 | 2/2 |
| executionCorrectness | 2/3 | — | 17/17 | — | 2/2 | 2/2 | 6/6 |
| executionProvenanceAgreement | 2/2 | — | 13/13 | — | — | — | 3/3 |
| observedSourceRefCoverage | 83/83 | 217/217 | 144/144 | 26/26 | 4/4 | 4/4 | 6/6 |
| producerAttributionCorrectness | — | — | — | — | 2/2 | 2/2 | — |
| producerAttributionCoverage | 83/83 | 208/208 | 84/84 | 26/26 | 4/4 | 4/4 | 4/4 |
| provenanceChainCoverage | 16/16 | 7/7 | 33/33 | 9/9 | 2/2 | 2/2 | 2/2 |
| provenanceCompleteness | 15/15 | — | 31/31 | 6/6 | 2/2 | 2/2 | 3/3 |
| resolutionAccuracy | 14/15 | 1/1 | 12/12 | — | 2/2 | 2/2 | 2/2 |
| semanticCorrectness | — | 2/2 | 21/22 | 3/3 | — | — | 2/2 |
| semanticPrecision | — | — | 21/23 | — | — | — | 1/1 |
| semanticRecall | — | 2/2 | 21/22 | 3/4 | — | — | 2/2 |
| spuriousCapabilityAvoidance | — | 0/3 | 0/6 | 0/1 | — | — | — |
| spuriousFactAvoidance | — | — | 0/1 | 4/4 | — | — | 3/3 |
| structuredIoAccuracy | — | — | 8/8 | — | 4/4 | 4/4 | 2/2 |
| workflowExecutabilityAccuracy | 2/2 | — | 2/2 | — | 1/1 | 1/1 | 1/1 |
| workflowPrecision | — | — | — | — | 1/1 | 1/1 | 1/1 |
| workflowRecall | 2/3 | — | 2/2 | — | 1/1 | 1/1 | 1/1 |
| workflowStructureAccuracy | 4/4 | — | 2/2 | — | 2/2 | 2/2 | — |

### 2.3 Attribution, configuration and evaluation identity

* Evaluation version `p0.9c-1` in both reports. AI: `not_exercised` in every configuration.
* Producer attribution: coverage 413/413 over attributable nodes; correctness 4/4 on the two structured/OpenAPI cases (the only cases with unambiguous producer ground truth); other cases remain unmeasured by design.
* Provenance: chain coverage 71/71 (connectedness, not correctness of evidence); execution-provenance agreement 18/18 + 10/10 (compares two derivations).
* Cross-path: 355/355 comparable in-process path pairs agree; API/CLI/installed paths not exercised.
* Configuration ids: aastha `cfg_98e08887156d2f71`, burglary `cfg_16cd4f9f0545f53e`, commercial `cfg_889c8bc8f21c0fb9`, multidoc `cfg_9eaf4efcca458878`, openapi `cfg_1acb6dca566d3a11`, structured `cfg_0fd1e4f4cee16037`, synthetic `cfg_6b0e7ca77c84c10d`, runtime-mechanics `cfg_471dc8723842e880`.
* Workflow/execution: workflowRecall 7/8 (aastha 2/3 is the one shortfall); executionCorrectness 29/30; workflowExecutabilityAccuracy 7/7.
* Determinism: 3 separate-process runs before the refresh and 3 after, all byte-identical (sha256 below).

## 3. Step 8 Results (unchanged)

* Mutation matrix: 49 rows → **45/47 = 95.7% detected** (47 detectable rows), **0 unexpected false-pass** across 7 false-pass attempts, **12/12 evaluator-internal mutations killed**.
* Not detected (documented): **M-greedy** (greedy matching, limitation L3) and **M-runspecific-hashed** (run-specific values inside hashed observation properties).
* 1 mutation **not observable** and 1 **not applicable**, recorded as such (neither counted as detected nor as failure).
* No semantic evaluator change was made after Step 8.

## 4. Baseline Refresh

| | runtime-mechanics | vertical-fixtures |
|---|---|---|
| Predecessor | `baselines/archive/runtime-mechanics.p0.9c-1.1b98f1acd213.report.json` | `baselines/archive/vertical-fixtures.unversioned.ea4d33081f6b.report.json` |
| Old sha256 | `1b98f1acd213e7503e180f0d6bb86698d791ef5da323b770da6981cf140680e4` | `ea4d33081f6b990e373afc592554c5918a4a493fc29ca36abf0fe39508540406` |
| **New sha256** | `4d9ac4acf2b317db6a60a17e42459238b58bd6387886550f0241bc565b5e79f9` | `5e741c155cc8f7c6183349cc01bafe33620830930335076e8b2706c22101687e` |
| Evaluation version | p0.9c-1 → p0.9c-1 | (none) → p0.9c-1 |
| Metric-definitions hash | `84470fdbc31e4ef9…` | `1791bd2a93410b1c…` |

* Refreshed **together**, `2026-10-09T06:28:35Z`, record `baselines/refresh/p09c-final.refresh.json` (validated by `validateRefreshRecord`; every difference has a disposition and reason).
* **Reason:** the historical baselines predate Steps 1–6 (vertical-fixtures also predates evaluation versioning), so every candidate needed review; the accepted baseline is now the reviewed final evaluation.
* Suite fingerprints/golden: expectations fingerprints — synthetic `e3f18bb648927dce`, commercial `fc7333250a689842`, aastha `bbcc3cdac2c9a97c`, burglary `2384164b83638c58`, multidoc `6eb147408d795389`, structured & openapi `b294e8d762ce826c`, runtime-mechanics `3667e1c4ec1d46ed` — all unchanged. Fixture hashes recorded per case in `BASELINES.json` and verified against the files.
* Preserved: predecessor identity/hashes/evaluation version/fixture hashes/fingerprints/metric-definition hashes/golden fingerprints, all 6 `known_historical_drift` records and 3 declared golden changes (as `historical` manifest entries), Step 8 success, "no semantic evaluator changes", known limitations, Step 7 predecessor.
* **Policy change (Decision C):** future declared population changes classify as `population_change` (`declaredPopulationChanges`), not `known_historical_drift`; historical records not rewritten; no evaluation-version change, no report byte change.
* **Deferred (locked decisions):** A — observation-level run-specific guard not implemented (post-P0.9C hardening). B — L3 greedy matching not fixed (accepted known limitation).

## 5. Regression Status (candidate vs the historical Step 7 baselines)

| class | runtime-mechanics | vertical-fixtures |
|---|---|---|
| semantic_regression | 0 | **0** |
| semantic_improvement | 0 | 0 |
| expected_metric_addition | 1 (executionProvenanceAgreement) | 26 |
| golden_expectation_change | 0 | 3 (declared in Steps 3/4) |
| population_change | 0 | 0 |
| configuration_change | 0 | 0 |
| evaluation_version_change | 0 | 1 (baseline predates versioning) |
| representation_only | 0 | 7 (attribution metadata) |
| known_historical_drift | 0 | 6 (P0.9A/P0.9B intentional changes) |
| not_comparable | 0 | 0 |
| **decision** | compatible | review_required (all explained) |

Post-refresh: candidate vs accepted baseline → **identical** for both suites.

## 6. Test Status

| suite | result |
|---|---|
| @xo/benchmark | **228/228** (221 Step 8 + 7 closure tests) |
| CLI benchmark tests | 6/6 |
| API benchmark equivalence | 3/3 |
| Full CLI | 260/262 — the 2 failures are the known real decision-rule pinned-count tests (the 9 adm-zip failures of the earlier sandbox did not occur here because the dependency installed) |
| Full API | 191/191 |
| @xo/compiler | 894/895 — the 1 failure is the known M1.1 shape-6 test |
| Full monorepo (`npm test --workspaces`) | every package passes except the two known failures above |
| `npm run build` | exit 0, 0 TypeScript errors |

Known failures were not fixed (out of scope). Nothing outside `packages/benchmark` and one CLI test file was changed (verified by directory diff); suites and ground-truth files are byte-identical to Step 8.

## 7. Closure criteria

Final evaluation completed ✔ · no unexplained semantic regression ✔ · both baselines refreshed together ✔ · historical baselines preserved ✔ · refreshed baselines reproduce exactly ✔ · deterministic ✔ · Step 8 intact ✔ · benchmark / CLI / API benchmark tests pass ✔ · monorepo/build match the known baseline ✔ · report written ✔ · limitations documented ✔.

**After this point (freeze):** no new metrics, evaluator redesign, golden changes, additional mutation testing, protocol changes, L3 fix, observation guard or population expansion within P0.9C.

## 8. Remaining Limitations

1. **L3 — greedy matching:** two expectations could in principle be satisfied by one observed item (no current case triggers it; mutation M-greedy is not detected).
2. **Run-specific values inside hashed observation properties** are not detected (M-runspecific-hashed); the observation-level guard is deferred.
3. **Selected, not exhaustive, mutation coverage** — and only four of the eight cases were directly mutated.
4. **API, CLI and installed-package paths are not exercised** by the cross-path evaluation (L16); agreement metrics compare two derivations (L15).
5. **ExperienceUnit link is not observable** at the XOIR level; provenance chain coverage measures connectedness, not correctness of evidence (L14).
6. Also: AI path not exercised (L13); some producer paths unstamped (L12); several metrics are descriptive, not graded; open-world cases are partial by design; the `spuriousCapabilityAvoidance` 0/10 is a real implementation gap.

## 9. Next Phase: P1.0 — Enterprise Trust

P1.0 — Enterprise Trust begins only after P0.9C closure. It is **not** implemented or started here, and the frozen roadmap is unchanged.
