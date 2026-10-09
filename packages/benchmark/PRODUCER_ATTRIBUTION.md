# XO Benchmark — Producer Attribution

**P0.9C Step 4.** What `producedBy` is, which values exist, where they are assigned, what the benchmark can and cannot independently
establish, and the two metrics this step adds. Companion to `EVALUATION_MODEL.md` (Step 2) and `GOLDEN_EXPECTATIONS.md` (Step 3). This is an
evaluation milestone: nothing in the compiler was changed, and no attribution was improved to raise a score.

Machine-checkable companion: `src/producer.ts` (taxonomy + creation-path classifier), pinned by `test/producer.test.ts`, which also
guards against drift from the compiler's own tables.

## 1. Producer attribution is not provenance

| Dimension | Question | Field | Owner |
|---|---|---|---|
| **Producer attribution** | who *created* this claim | `metadata.producedBy` | **this step** |
| Source provenance | where in the source it came from | `metadata.sourceRefs` | Step 5 |
| Evidence provenance | what supports the assertion | evidence / confidence | Step 5 |
| Runtime provenance | which capability / contract / binding ran | runtime | Step 5 / 6 |

None of the last three is read by any producer metric.

## 2. Findings: the attribution architecture (derived from the code)

`producedBy` is an **extractor name**, stamped by the hybrid extractors and copied through merge and XOIR conversion. It is *not* a node-kind
label: "concept", "heuristic" and "decision_node" (the labels in the Step 0 notes) are **kinds**, not producers.

| Path | Stamp site | Receives `producedBy`? |
|---|---|---|
| Knowledge extraction → concept / fact / constraint | `knowledge/hybrid-extractor.ts` stamps `extractorName`; `knowledge/merge.ts` sets `producedBy` iff all merged candidates share one extractor; `knowledge-to-xoir.ts` copies it | **yes** |
| Capability extraction → capability | `capabilities/hybrid-extractor.ts` stamps `rule-based` / `structured-operation` / `ai`; `capabilities/merge.ts` same single-extractor rule; `capability-to-xoir.ts` copies it | **yes** |
| Reasoning extraction → heuristic, decision_node, reasoning-derived constraint, … | none (`reasoning/*` extractors have names — `rule-based`, `ai`, `hybrid` — but nothing stamps them) | **no** |
| Rule-capability minter → capabilities minted from reasoning nodes | none (a pass, not an extractor; marked by `xoRuleDerived` in the capability's own metadata) | **no** |

Two points matter for evaluation:

1. **The creating path is observable without reading `producedBy`.** `(kind, subtype)` identifies the pipeline (knowledge types and reasoning
   types map to disjoint `(kind, subtype)` pairs; the shared subtype `exception` maps to `constraint` in one and `heuristic` in the other), and the
   minter marks its output with `xoRuleDerived`. So a coverage denominator need not be defined by its own numerator.
2. **Whether the two un-stamped paths *should* be attributed is not established by the repository.** The type documentation says `producedBy` is absent
   "when no genuinely identifiable producer exists rather than fabricated", and names hand-built XOIR and multi-extractor merges as the legitimate absences.
   Reasoning nodes are neither, and the reasoning extractors do have stable names — so the absence is not documented as deliberate *or* as a defect.
   (The Step 1 comment "P0.9A leaves some node classes unattributed by design" records the observation, not a documented decision.) This is reported as a
   **finding**, not fixed and not scored.

## 3. Producer taxonomy

| Value | Assigned at | Receivers | Stamped | Independently establishable by the benchmark | Exercised by |
|---|---|---|---|---|---|
| `rule-based` | knowledge and capability rule-based extractors | concept / fact / constraint; capability | yes | **Yes while AI is not exercised** — the only extractor on the text path | all 7 compiled cases |
| `structured-operation` | capability hybrid extractor | capabilities lowered from structured / OpenAPI sources | yes | **Yes** — the *source format* is a fixture fact and only this extractor consumes it | `structured-operation-data-flow`, `openapi-operation-data-flow` |
| `ai` | knowledge / capability hybrid extractors, only if an AI extractor is configured | as above | yes | **No** — AI is `not_exercised` (P1.5) | none |
| `hybrid` | never stamped (the wrapper's own name; it stamps its sub-extractors) | none | no | a `hybrid` value on a node would itself be a finding | none |

Every value is descriptive of *who ran*; none is an authority claim about correctness. There is **no normalisation**: values compare by exact,
case-sensitive equality, and an unknown string is reported verbatim (`producerValueStatus`). The taxonomy was not extended for benchmark convenience.

## 4. Producer attribution coverage — `producerAttributionCoverage`

> Among observed nodes created through a path that **has a producer-stamping site**, what fraction carries `producedBy`?

* **Population (denominator):** nodes whose creation path is `knowledge_extractor` (concept / fact / constraint from knowledge types) or
  `capability_extractor` (capability without the `xoRuleDerived` marker), classified from kind, subtype and the marker — never from `producedBy`.
* **Numerator:** population nodes with a `producedBy`.
* **Not judged, but reported** (in the metric's `breakdown` as `not_judged.<origin>.<attributed|unattributed>`): reasoning-derived nodes,
  rule-minted capabilities, and unclassified nodes. Their absence is neither counted as legitimate nor as missing (limitation L12).
* **Absent (not applicable)** when compile did not run (serialized-XOIR entry, failed compile), when AI is exercised (limitation L13), or when the
  population is empty. Never `0%`.
* **Descriptive:** it is judged against the architecture, not a golden expectation, so it does not make an expectation-free suite count as `measured`
  (same treatment as `observedSourceRefCoverage`).
* **Missing attribution is measured as missing:** each population node without a producer is a `missing` item with its creation path.

Why not "all nodes" or "all kinds that *could* carry a producer"? The first penalises paths the repository never stamps; the second would need a
ruling (is a reasoning node's missing producer a defect?) that the repository does not make. The population is exactly what is unambiguous.

## 5. Producer attribution correctness — `producerAttributionCorrectness`

> For located capabilities that declare an expected producer, does `producedBy` equal it?

* **Expected producer:** an optional `producedBy` on a capability expectation (`definition.ts`), asserted only where the creating extractor is
  objectively determined. Currently **four** assertions: `op-calculate-brokerage` and `op-record-brokerage` in both structured and OpenAPI cases →
  `structured-operation` (the source format determines the extractor; verified against `capabilities/hybrid-extractor.ts` and by the real pipeline).
* **Denominator:** located capabilities with an expected producer **that were created by a capability extractor and carry a producer** (the *premise*).
* **Excluded, never forced:** a located capability created another way (rule-minted — a different path could legitimately produce the same semantic
  object) is *outside the assertion*, as is one with no observed producer (absence is coverage's question — counted there once, not twice). Both are
  recorded in the `breakdown` (`excluded.premise_not_met`, `excluded.no_observed_producer`).
* **Wrong producer** → a `mismatched` item and the capability item becomes `incorrect`; **no historical metric changes** (capability recall is identity-only).
* An expected value that is not a producer the pipeline stamps is rejected by the integrity lint (`unknown_expected_producer`).
* **Absent, never 0%,** when nothing is asserted or every assertion is outside the premise.

Not asserted, deliberately: text-source capabilities (`rule-based`). They are `rule-based` by construction and most golden commercial capabilities are
rule-minted (no producer), so a per-item expectation there would need a per-item ruling the fixtures do not supply; coverage already guards them.

## 6. Case-by-case audit

Attributed counts are over **all** observed nodes (Step 1's descriptive distribution); the metric columns are this step's metrics.

| Case | Nodes | Producers observed | Attributed / unattributed | Coverage (in population) | Not judged (unattributed) | Correctness |
|---|---|---|---|---|---|---|
| `synthetic-claim-rules` | 6 | rule-based | 4 / 2 | 4/4 | 1 reasoning, 1 rule-minted | — (no assertion) |
| `commercial-property-policy` | 144 | rule-based | 84 / 60 | 84/84 | 43 reasoning, 17 rule-minted | — |
| `aastha-operations` | 83 | rule-based | 83 / 0 | 83/83 | none (no reasoning nodes) | — |
| `burglary-policy-schedule` | 217 | rule-based | 208 / 9 | 208/208 | 8 reasoning, 1 rule-minted | — |
| `multidoc-burglary-claims` | 26 | rule-based | 26 / 0 | 26/26 | none | — |
| `structured-operation-data-flow` | 4 | rule-based ×2, structured-operation ×2 | 4 / 0 | 4/4 | none | **2/2** |
| `openapi-operation-data-flow` | 4 | rule-based ×2, structured-operation ×2 | 4 / 0 | 4/4 | none | **2/2** |
| `runtime-mechanics` | 15 | none | 0 / 15 | **absent** (hand-built XOIR, compile `skipped`) | not observable | — |

Aggregate: coverage **413/413** judged; **71** nodes (52 reasoning-derived, 19 rule-minted, all unattributed) not judged; correctness **4/4**.
No node in any case is unclassified, and no reasoning-derived or rule-minted node carries a producer (both are tested against the real pipeline).
`ai` and `hybrid` are never observed.

**Reading the numbers:** 100% coverage says the paths that *do* stamp do so completely; it says nothing about the 71 un-stamped nodes (≈15% of the
484 compiled nodes), which is the real open question (§2). Correctness 4/4 is deliberately narrow.

## 7. Ambiguities and what is not measurable

| Item | Status |
|---|---|
| Reasoning-derived nodes: should they carry a producer? | **not established** — reported under `not_judged`, not scored |
| Rule-minted capabilities: the producer would be a *pass*, not an extractor | **not established** — same |
| `rule-based` expected on text-source capabilities | not asserted (by construction; per-item ruling not supportable for minted ones) |
| `ai`, `hybrid`, multi-extractor merges | **not exercised** (P1.5); both metrics are not emitted unless the configuration reports `ai: not_exercised` |
| Hand-built XOIR (`runtime-mechanics`) | **not observable** — no extractor ran |

## 8. Reporting and baselines

The metrics use the existing structures (`MetricResult`, `breakdown`, item lists, micro-aggregation); no new report section exists. Step 1's
`observedContext.producerDistribution` is unchanged. **No baseline was regenerated.** `runtime-mechanics` is byte-identical to its baseline (both metrics
are absent). `vertical-fixtures` reports gain the two new metrics; every pre-existing metric, item and fingerprint is identical (verified), and the comparison
against the committed baseline remains `no_change` (the new metrics appear only in the current run). `EVALUATION_VERSION` is unchanged.

## 9. Remaining limitations

* **L12** — un-stamped paths are not judged (§2, §4). Resolving it needs an architectural decision, then a Step 7-style baseline change.
* **L13** — valid only while AI is not exercised.
* Correctness has four assertions (structured / OpenAPI only).
* The local kind/subtype tables are a copy of the compiler's (not exported); a test fails on any drift.
* `producerAttributionCoverage` is a regression guard for stamping today (it is 100%); it becomes informative when AI or new extractors arrive.
