# @xo/benchmark

Evaluation layer for the **real** XO pipeline. It answers:

> Given a source and expected semantic/execution behavior, how well did XO compile and execute it?

```
source ─► compile ─► XOIR ─► capability contracts ─► workflows ─► runtime execution
          (compile)          (capabilities)          (workflows)   (execution)     ← the four observed stages
```

It is an *evaluation* layer, not a semantic one: it contains no extractor, no resolver, no composer, no executor, no AI, and applies
no thresholds. `src/observe.ts` calls the same library functions, in the same order, that `apps/api` and `apps/cli` already call
(`compileSources` → `packageXoirGraph` / `buildSemanticCapabilityContract` → `composeWorkflows` + audits +
`prepareCandidateWorkflowForExecution` → `RuntimeCapabilityExecutor` / `WorkflowExecutor`). `apps/api/test/benchmark-equivalence.test.ts`
pins that the observer and the shipped API pipeline agree on the same source.

> **Evaluation model (P0.9C Step 2):** what each metric measures, its denominator population, open/closed-world rules, micro-averaging, unmeasured / not-observable states, warnings vs metrics and population changes are specified in [`EVALUATION_MODEL.md`](./EVALUATION_MODEL.md); its machine-checkable shadow is `src/evaluation-model.ts`.

> **Golden expectations (P0.9C Step 3):** the audit of every expectation, world-model assessment, matcher findings and the one correction are in [`GOLDEN_EXPECTATIONS.md`](./GOLDEN_EXPECTATIONS.md); per-expectation provenance lives in `ground-truth/*.ground-truth.json` (audited by `src/ground-truth.ts`).

> **Producer attribution (P0.9C Step 4):** the producer taxonomy, the attribution architecture findings and the two producer metrics are in [`PRODUCER_ATTRIBUTION.md`](./PRODUCER_ATTRIBUTION.md).

> **Provenance (P0.9C Step 5):** the provenance-chain map, the audit of the existing source-reference metrics, and the chain-coverage / execution-agreement metrics are in [`PROVENANCE_EVALUATION.md`](./PROVENANCE_EVALUATION.md).

> **Cross-path (P0.9C Step 6):** the path inventory, comparable pairs, states, findings and the `crossPathConsistency` metric are in [`CROSS_PATH_EVALUATION.md`](./CROSS_PATH_EVALUATION.md).

> **Baselines (P0.9C Step 7):** what a baseline is, its identity manifest (`baselines/BASELINES.json`), the graph-hash policy, the change taxonomy and the refresh procedure are in [`BASELINE_PROTOCOL.md`](./BASELINE_PROTOCOL.md).

> **Final closure (P0.9C):** the controlled joint baseline refresh, Decision C, the closure criteria and the remaining limitations are in [`P09C_FINAL_REPORT.md`](./P09C_FINAL_REPORT.md); accepted baselines now live in `baselines/`, predecessors in `baselines/archive/`, the refresh record in `baselines/refresh/`.

> **Evaluation self-test (P0.9C Step 8):** the mutation matrix, false-pass attempts and evaluator-internal mutations that show the benchmark catches deliberately introduced defects are in [`EVALUATION_SELF_TEST.md`](./EVALUATION_SELF_TEST.md).

## Pieces

| File | Role |
|---|---|
| `definition.ts` | The benchmark **definition** model + strict validator (`validateSuiteDefinition`). |
| `observe.ts` / `observation.ts` | Runs the real pipeline for a case and records what it produced, **per stage**. |
| `evaluate.ts` / `metrics.ts` / `evaluation-types.ts` | PURE `(definition, observation) → CaseEvaluation`. Sorted everywhere, so list order never matters. |
| `report.ts` | `runSuite`, aggregation (micro-average), report schema (`schemaVersion: 1`, no timestamps → byte-deterministic). |
| `compare.ts` | Regression comparison of two reports; per-stage fingerprint attribution. |
| `evaluation-model.ts` | P0.9C Step 2: read-only registry of the 20 metrics' denominators/emission/world rules, measurement & observability classifiers, `interpretCase`, reserved Step 4–6 semantics. Feeds no metric. |
| `ground-truth.ts` | P0.9C Step 3: strict parser + audit for the ground-truth register (why each golden expectation is believed), expectation fingerprints, static integrity lint. Benchmark provenance only; imported by nothing in the evaluation path. |
| `producer.ts` | P0.9C Step 4: derived producer taxonomy, creation-path classifier (kind + subtype + minter marker, never `producedBy`), attribution summary. |
| `cross-path.ts` | P0.9C Step 6: path inventory, view types and the pure pairwise comparator (match / mismatch judged; unknown / not_comparable / not_exercised / not_observable reported). |
| `baseline.ts` | P0.9C Step 7: baseline manifest + verification, run-specific-field guard, change classification and decision, refresh-record validation. Pure; writes nothing. |
| `format.ts`, `load.ts` | Text rendering; suite file loading (`sourceRoot` resolved against the suite file). |
| `suites/*.suite.json` | Committed suites. `baselines/*.report.json`: committed reference reports. |
| `fixtures/` | One hand-built XOIR graph (+ its generator). See *Hand-built fixture* below. |

CLI: `xo benchmark-run <suite.json> [--baseline r.json] [--out r.json] [--source-root d] [--summary] [--limit n] [--json]`
(exit 1 on a regression vs `--baseline`, an invalid definition, or a case the harness could not run) and
`xo benchmark-compare <baseline.json> <current.json>`.

**No API routes / no persistence layer.** A benchmark is a development/CI-time measurement over repository fixtures, not per-workspace
customer data; the persisted artifact is the JSON report file (a baseline you commit). A workspace-bound API would add surface with no
caller. The engine takes plain data in and returns plain data, so a route can be added later without changing it.

## Definition data model (what XO *should* produce)

A suite has cases. A case has **one** entry point — `sources` (real files: `pdf|document|html|structured|openapi|image`, each with an
explicit `kind` so no extension sniffing lives here) **or** `xoir` (a serialized graph that enters the real pipeline at the
packaging/contract stage) — plus:

* `expect.compile` — `succeeds` / `fails` (+ error code)
* `expect.semantics` — `facts[]` (`kind`, `identify` predicates = *which* node, `assert` predicates = *is it right*, `evidence`), `forbidden[]`, `closedWorldKinds[]`
* `expect.capabilities` — `items[]` (name matcher, `resolution`, `executionClass`, `inputs`, `outputs`, `evidence`), `forbidden[]`, `closedWorld`
* `expect.workflows` — `items[]` (step set, `ordered`, `executability`, `stepClasses`, `dataFlow.bindings[]` with `proven`/`not_proven`), `closedWorld`
* `execution[]` — capability runs (input → outcome / output subset) and workflow runs (status, per-step output, **expected runtime injections**)

**Open vs closed world is explicit.** A list is a complete ground truth only when the author says so (`closedWorld`, `closedWorldKinds`).
Only then can unclaimed output be `unexpected` and a **precision** computed; otherwise the precision metric is simply not emitted (never a
silent 100%). `forbidden` items measure known false positives in open-world suites.

**Identity vs assertion.** An item is *located* by its identity predicates and then judged by its assertions. Located-but-wrong is
`incorrect` (semantically incorrect / wrong class), a different failure from `missing`.

## Item outcomes

`found` · `incorrect` · `missing` · `unexpected` (closed-world, unclaimed) · `spurious` (forbidden but present) · `passed` / `failed` / `not_run`
(execution). Independently, the report always carries **expectation-free distributions** of what was produced: capabilities by
`resolution` (resolved / unresolved / ambiguous / denied) and by class (deterministic_rule / human_in_the_loop / not_executable),
workflows by audit status (executable_candidate / not_executable_yet / semantically_invalid), executions by outcome — so unresolved,
unsupported, human-in-the-loop and not-executable results stay visible even where nothing was expected.

## Metrics (each independent; there is **no combined score**)

Every metric reports `numerator`, `denominator`, `ratio` (`null` when the denominator is 0 — "not measured" ≠ "perfect"),
`missing[]`, `unexpected[]`, `mismatched[]` (each item with a reason and the **attributed stage**).

| Metric | Stage | Definition |
|---|---|---|
| `compileOutcomeAccuracy` | compile | compile outcome equals the expected `succeeds`/`fails` |
| `semanticRecall` | compile | expected facts located **and** correct / expected facts |
| `semanticCorrectness` | compile | correct / located — isolates "wrong" from "absent" |
| `semanticPrecision` | compile | observed nodes of closed-world kinds claimed by a correct fact / all such nodes |
| `spuriousFactAvoidance` | compile | forbidden facts absent / forbidden facts |
| `provenanceCompleteness` | compile | evidence specs (min refs / document / pages) satisfied by the located item / evidence specs on located items |
| `observedSourceRefCoverage` | compile | *descriptive*: nodes with ≥1 source ref / nodes (never makes a suite count as "measured") |
| `capabilityRecall` / `capabilityPrecision` | capabilities | discovered / expected; matched-by-expectation / discovered (closed-world) |
| `spuriousCapabilityAvoidance` | capabilities | forbidden capabilities absent / forbidden |
| `resolutionAccuracy` | capabilities | expected `resolved/unresolved/ambiguous/denied` matched, over discovered capabilities |
| `executionClassAccuracy` | capabilities | expected class matched, over discovered (with an expected→actual confusion `breakdown`) |
| `structuredIoAccuracy` | capabilities | declared input/output parameter **sets** exactly equal (missing and unexpected listed separately) |
| `workflowRecall` / `workflowPrecision` | workflows | expected workflows found (exact step set, any order) / matched observed (closed-world) |
| `workflowExecutabilityAccuracy` | workflows | audit status equals expected, over found workflows |
| `workflowStructureAccuracy` | workflows | step order / per-step classes equal expected, over found workflows |
| `dataFlowCorrectness` | workflows | proven bindings present, `not_proven` absent, no extra proven ones (closed-world) |
| `executionCorrectness` | execution | run outcome/output/steps equal the expected ones / requests |
| `runtimeDataFlowTransfer` | execution | expected producer→consumer injections the **runtime actually performed** (the observer records the input each capability was really executed with) |

Denominators are **conditional on the upstream item being found** (data-flow assertions are not counted for a workflow that was never
found — that is a `workflowRecall` miss). Coverage that silently shrinks is therefore surfaced by the comparator (`coverage_reduced`).

### Compile-side vs runtime-side attribution

Each item carries `attributedStage`. An execution failure whose cause is an unresolved / undiscovered capability is attributed to
`capabilities`, not `execution`; a workflow the audit refuses is `workflows`. A workflow that is not `executable_candidate` is **refused**
(not run) in the observer, mirroring the P0.8 API gate (`WORKFLOW_NOT_EXECUTABLE`) — the raw runtime bridge itself does not consult the audit.

## Regression detection (`compareReports`)

Item-aware verdicts per metric (`improved` / `regressed` / `mixed` / `unchanged`), plus:

* **Tradeoffs** — a recall metric up while its precision partner is down ("improved recall but introduced false positives"), naming the new unexpected items.
* **Stage fingerprints** — a stable hash of each stage's observable output (never timestamps). Compile/capability/workflow output identical while an execution metric regressed ⇒ `executionOnlyRegression` ("a runtime change did not change compilation but broke execution").
* Removed cases are regressions; `coverage_reduced` warns when assertions vanish; item ids for observed things are text keys, not content hashes, so re-hashing does not look like fix+break.

## Suites

* `vertical-fixtures` — the repository's real fixtures (Commercial Property PDF, Aastha PDF, burglary PDF, synthetic claim-rules text, three
  plain-English documents compiled together, structured JSON and OpenAPI operations). Ground truth was authored from each source's own content
  (read independently of XO with `pdftotext`; for Commercial Property, the document's own Appendix A cases A–H are the execution truth).
  **Known gaps are expected failures and are recorded in the baseline**, not tuned away. See `CHANGELOG.md` for dated ground-truth changes and
  the reasoning behind each.
* `runtime-mechanics` — a hand-built graph; see below.

### Hand-built fixture

No real source in the repository compiles to a multi-step `executable_candidate` workflow or to a proven, wired producer→consumer binding
(`@xo/compiler` emits no declared capability outputs today). `fixtures/build-xoir-fixtures.ts` therefore builds a small graph from real
`@xo/xoir` nodes/edges; it enters the real pipeline via `xoir` at the packaging/contract stage (source ingestion is reported `skipped`).
It measures contracts, workflow composition/audit, the runtime bridge and executor — **not** extraction — and is not a discovered
production capability. A test asserts the committed JSON equals the generator's output.

## Baselines

```
xo benchmark-run packages/benchmark/suites/<suite>.suite.json --out packages/benchmark/baselines/<suite>.report.json
```

`test/suites.test.ts` runs both suites on the real pipeline and fails on any regression against the committed baselines; improvements pass
(refresh the baseline deliberately).

## Limitations

* Workflow *execution* is observed through the runtime bridge (`WorkflowExecutor` + the CLI's whole-run semantics); the P0.8 API's
  stop-at-HITL segmenting and persistence live in `apps/api` and are covered by its own tests.
* Matching is exact-after-normalization (case/whitespace) or `contains`; no fuzzy/semantic similarity by design.
* Real-source ground truth is partial for capabilities/workflows (open-world) except where a case declares `closedWorld`.
* The observer's call sequence is repeated from `apps/api`/`apps/cli` (they have no importable exports); the equivalence test guards drift.
