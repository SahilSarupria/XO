# XO Benchmark — Baseline + Regression Protocol

**P0.9C Step 7.** How to create, compare, accept and retain benchmark baselines so that a change in results can be attributed to a real regression, an intentional change, an evaluation change or mere
representation. Governing rule: **a baseline is evidence of a reviewed state, not a mechanism for making the current implementation look correct.** Nothing here changes the compiler, XOIR, runtime, package system,
CLI or API; no baseline was regenerated. Machine-checkable: `src/baseline.ts`, `baselines/BASELINES.json`, `src/compare.ts` (conservative fixes), `test/baseline.test.ts`.

## 1. What a baseline is

| Term | Meaning |
|---|---|
| **Historical baseline** | the committed result from a known repository state. Evidence, not authority. Status `historical`. |
| **Current candidate** | the result of a fresh run. Never written to a baseline path by a normal run. |
| **Updated (accepted) baseline** | a candidate deliberately accepted through a *refresh record* after every difference was classified. Status `accepted`. |
| **Evaluation baseline** | a baseline whose `evaluationVersion` and metric definitions equal the current ones (`verifyManifestEntry`); an older one is still evidence but its comparison carries an `evaluation_version_change`. |

No committed file is automatically authoritative: both current baselines are `historical`.

## 2. Baseline identity

A report alone is not enough to say *what a baseline is*, so `baselines/BASELINES.json` records, per baseline (deterministic; no timestamps or machine-local values):

| Field | Why |
|---|---|
| `suiteId`, `reportFile`, `reportSha256` | the exact bytes. A regenerated file cannot keep this hash, so **silent regeneration fails verification** |
| `evaluationVersion`, `metricIds`, `metricDefinitionsSha256` | the evaluation semantics it was produced under |
| per case: `configurationId`, fixture paths + `sha256`, `expectationsFingerprint` (Step 3), `goldenState` | configuration, fixture and golden-expectation state. `goldenState: unrecoverable` (with a `null` fingerprint) when the state at generation time cannot be known — nothing is invented |
| `knownDrift` | explained historical differences (strictly scoped: an entry explains only the metric / stage it names) |
| `declaredGoldenChanges` | reviewed golden changes since the baseline: old / new fingerprint, reason, evidence, affected metrics, acceptance point |
| `history`, `predecessor` | retained history |

Report-level identity already exists and is unchanged: suite id, `evaluationVersion`, per-case `configurationId`, stage fingerprints. `findRunSpecificFields` forbids `graphHash`, timestamps, run ids, host names and absolute paths anywhere in a report.

## 3. Graph-hash policy (mandatory)

`XoirGraph.contentHash()` is an **instance / provenance identity by design**: `hashing.ts` documents that `createdAt` "is treated as part of a node's provenance" and hashes it, while `updatedAt` and `reviewStatus` are excluded. Two
compilations of an identical fixture therefore have different graph hashes (demonstrated below). No content-only graph identity exists, and **none was invented**.

| | Instance identity (`graphHash`) | Semantic identity |
|---|---|---|
| What | the hash of one graph instance, including node / edge `createdAt` | content-derived `capabilityId`, `contractContentHash`, binding id |
| Stable across independent compiles | **no** | **yes** (demonstrated) |
| Stable across serialization of the same instance | yes | yes |
| Allowed use | within-instance provenance agreement (Step 5); live ↔ serialized copy (Step 6) | cross-run and cross-path semantic comparison |
| In a report, fingerprint or baseline | **never** (enforced by `findRunSpecificFields` and by the manifest check) | yes |
| Evidence that two compiles differ semantically | **no** | n/a |

Step 6's wording said both node timestamps feed the hash; the accurate statement is `createdAt` only (corrected in `CROSS_PATH_EVALUATION.md`). Whether a timestamp should participate in a graph's identity is an architecture question; it is documented here, not changed.

## 4. Change taxonomy and the decision procedure

Every difference between a baseline and a candidate gets exactly one class (`classifyDifferences`, first match wins; the questions are asked in this order):

| Question | Class |
|---|---|
| different suite, harness error, undeclared metric, undeclared definition change, undeclared golden change | `not_comparable` |
| evaluation version differs (incl. "baseline predates versioning"), or a definition / removal at a new version | `evaluation_version_change` |
| configuration id differs (metrics **and** stage outputs of that case) | `configuration_change` |
| a declared golden change names the case / metric | `golden_expectation_change` |
| metric absent from the baseline and registered in `METRIC_INTRODUCED_IN` | `expected_metric_addition` |
| only metadata the baseline predates (attribution) | `representation_only` |
| a declared **population change** (`declaredPopulationChanges`, P0.9C closure) names this exact metric / stage | `population_change` |
| a declared drift names this exact metric / stage | `known_historical_drift` |
| coverage grew / new case, nothing failing | `population_change` |
| otherwise, direction improvement | `semantic_improvement` (an extension of the requested list: an unexplained improvement is neither a regression nor explained) |
| otherwise (regression, coverage loss, a lost metric / case, or an observable output change with no moved metric) | `semantic_regression` |

**Decision** (`assessCandidate` semantics in `BaselineAssessment.decision`): `identical` · `compatible` (only expected metric additions and representation-only) · `review_required` (every difference explained, but a human must review) ·
`regression` (an unexplained regression or lost measurement) · `not_comparable`. **There is no outcome that says "no regression" for a regenerated baseline**: only `identical` and `compatible` carry no review obligation.

## 5. Specific policies

* **Coverage reduction.** `coverage_reduced` is *not* suppressed. Genuine loss (a denominator shrinks, nothing declared) is `semantic_regression`; a population change counts as such only when a declaration names that metric (FUTURE declarations use `declaredPopulationChanges` → `population_change`; the existing `knownDrift` records are historical and keep `known_historical_drift`); an evaluation-population change (new case / registry) is `population_change`. Declared drift explains only what it names.
* **New metrics.** A historical baseline that predates a metric reads **absent, not zero**; the candidate does not fail for it, even if the new metric has failing items (they are not "newly failing" against nothing). It is reported (`metric_added`), classified `expected_metric_addition`, and enters a baseline only through a refresh.
* **Removed / renamed / split / merged metrics.** Matching is by metric id, never position. A metric that vanishes earns **no improvement credit** (`metric_removed` warning; `semantic_regression` at the same evaluation version). A rename is a removal plus an unregistered addition (both reported; `not_comparable`).
* **Metric definitions.** A changed definition without an evaluation-version change is `not_comparable` (`metric_definition_changed`); with one, `evaluation_version_change`. Semantics changes require a version bump.
* **Golden changes.** A valid update records old / new fingerprint, reason, evidence, affected cases and metrics, and an acceptance point (`DeclaredGoldenChange`). An undeclared fingerprint change makes the pair `not_comparable`; a metric movement under a declared golden change is attributed to it, never to the implementation.
* **Configuration changes.** A different `configurationId` is `configuration_changed` plus `configuration_change`: "not directly comparable without interpretation". It is never declared safe.

## 6. Refreshing a baseline

A refresh is an explicit act, never a side effect of running the benchmark (no code in `src/` writes a file; the CLI writes only an explicitly given `--out`). It requires a `BaselineRefreshRecord`, validated by `validateRefreshRecord`:

1. a candidate and its assessment (`classifyDifferences`) — decision not `identical`, not `not_comparable`;
2. a **disposition and reason for every difference**; an unexplained regression can only be `acknowledged_regression`, never an ordinary update;
3. every golden change recorded in full; a stated reason; an acceptance point (CHANGELOG entry);
4. the **predecessor retained** (see §7), and the new report must differ in bytes;
5. then, and only then: write the new file, update `BASELINES.json` (`reportSha256`, metric set, `status: accepted`, `predecessor`, `history`) and add a CHANGELOG entry.

## 7. Historical-baseline policy

Old baselines are **retained, not deleted**. The repository supports one active baseline per suite, so history is kept in two places: `BASELINES.json` (`history`, `predecessor`, `knownDrift`, `declaredGoldenChanges`) and the CHANGELOG. When a baseline is superseded its file moves to
`baselines/archive/<suite>.<evaluationVersion>.<sha12>.report.json` (referenced by the new entry's `predecessor`) rather than being overwritten. The P0.9C final closure performed the first refresh (§12): both superseded reports are retained under `baselines/archive/`.

## 8. Determinism results

* Three runs in **separate processes**: both suites byte-identical (`vertical-fixtures`, `runtime-mechanics`).
* In-process repeated runs identical; stage fingerprints stable; no report (committed or fresh) contains a run-specific field.
* Graph-hash demonstration (`synthetic-claim-rules`, compiled twice 15 ms apart): the graph hashes **differ**; capability ids, contract hashes and bindings are **identical**; the two benchmark reports compare as `identical`.
* The only legitimately varying value is the graph instance identity, which never reaches a report.

## 9. Baseline audit (before any file changes)

Both committed baselines verify against `BASELINES.json` (bytes, evaluation version, metric set and definitions, case set, configuration ids; no run-specific field). Files were not modified (md5 verified).

| Suite | Case | Old baseline | Current | Difference | Classification | Refresh? |
|---|---|---|---|---|---|---|
| runtime-mechanics | runtime-mechanics | p0.9c-1, 20 metrics | + `executionProvenanceAgreement` 10/10 | metric added (Step 5) | `expected_metric_addition` | **no** (decision `compatible`) |
| vertical-fixtures | (suite) | no `evaluationVersion` | `p0.9c-1` | baseline predates versioning | `evaluation_version_change` ×1 | no |
| vertical-fixtures | all 7 cases | no attribution | attribution present | metadata only | `representation_only` ×7 | no |
| vertical-fixtures | all 7 cases | 20 metrics | + Steps 4–6 metrics | 26 additions | `expected_metric_addition` ×26 | no |
| vertical-fixtures | aastha-operations | golden `eaf93c35…` | `bbcc3cdac2c9a97c` | Step 3 matcher fix (no metric value moved) | `golden_expectation_change` | no |
| vertical-fixtures | structured-/openapi-operation-data-flow | golden `9a958b11…` | `b294e8d762ce826c` | Step 4 `producedBy` ×2 each | `golden_expectation_change` ×2 | no |
| vertical-fixtures | burglary-policy-schedule | 495 nodes / 211 concepts | 484 / 200 | table quarantine (population) | `known_historical_drift` ×2 (`observedSourceRefCoverage`, compile output) | no |
| vertical-fixtures | structured-/openapi-operation-data-flow | compile, capabilities fingerprints | changed (observed summaries identical) | post-baseline P0.9A/B change; field-level cause **not recoverable** (hash only) | `known_historical_drift` ×4 | no |

Result: **0** `semantic_regression`, **0** `not_comparable`. `runtime-mechanics` → `compatible`; `vertical-fixtures` → `review_required`.

## 10. Refresh decision

**Baseline refreshed: NO** — neither baseline was touched.

* `runtime-mechanics`: still valid evidence (`compatible`); its only difference is one expected addition. Refreshing it alone would only add one metric.
* `vertical-fixtures`: every difference is explained, but the baseline predates P0.9A and four fingerprint drifts have a cause that can only be confirmed by a human (the baseline stores hashes, not data). A refresh needs a reviewed refresh record.

**Recommendation:** refresh **both together, once, after Step 8** (which may still change evaluator or tests), with a refresh record that carries the 26 + 3 + 6 + 1 + 7 dispositions above and archives both predecessors. Doing it now risks a second refresh and an unreviewed acceptance.

## 11. Remaining limitations

* The four structured / OpenAPI fingerprint drifts are declared from the Step 1 record; they are not re-verified field by field.
* `goldenState` for `vertical-fixtures` is unrecoverable; the declared golden changes are those recorded since Step 3.
* No archive directory or refresh tooling is created; the refresh is a documented, validated procedure.
* A timestamp participating in a graph's identity is documented, not changed.

## 12. P0.9C final closure — the first controlled refresh

* **Both baselines were refreshed together** (`baselines/refresh/p09c-final.refresh.json`, validated by `validateRefreshRecord`, every difference dispositioned). The accepted baselines (`status: accepted`) are byte-identical to the final evaluation and reproduce exactly on repeated runs; the Step 7 predecessors are retained unchanged under `baselines/archive/` and stay in `BASELINES.json` as `status: historical` with all their `knownDrift` / `declaredGoldenChanges` / history.
* **Evaluation version unchanged (`p0.9c-1`)**; no metric, definition, golden expectation or report semantics changed.
* **Policy (Decision C).** A *future* declared change of the evaluated population is declared in `declaredPopulationChanges` (same shape and strict matching as `knownDrift`) and classifies as `population_change`, never `known_historical_drift`. Historical records were not rewritten. Precedence: declared golden change > configuration change > declared population change > historical drift > regression / improvement / population fallback.
* **Deferred, not implemented:** the observation-level run-specific guard (post-P0.9C hardening) and a fix for greedy-matching limitation L3 (accepted, documented).
* After closure the baselines change only through another validated refresh record.
