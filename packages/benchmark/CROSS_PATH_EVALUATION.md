# XO Benchmark — Cross-Path Evaluation

**P0.9C Step 6.** Do XO's paths agree when the same semantics go through them? This step **measures**. No compiler, runtime, package, CLI or API behavior was changed, no path was
unified, and no difference was reconciled. Companions: `PROVENANCE_EVALUATION.md` (Step 5, reused), `EVALUATION_MODEL.md` (§18), `src/cross-path.ts`, `test/cross-path.test.ts`.

## 1. Path inventory

Cell meaning: **observed** = the benchmark's own runs exercise and read it · **not_exercised** · **not_observable** · **not_applicable**. API and CLI rows are `not_exercised` by the benchmark
(the benchmark package cannot import the apps); the last column says how the repository covers them elsewhere. Machine-readable: `PATH_INVENTORY`.

| Path | Input | Compile | Discovery | Contract | Binding | Execution | Provenance | Covered elsewhere |
|---|---|---|---|---|---|---|---|---|
| benchmark observer / live graph | observed | observed | observed | observed | observed | observed | observed | reference path of every comparison |
| serialized XOIR (toJson/fromJson round trip) | observed | n/a | observed | observed | observed | not_exercised | not_observable | `runtime-mechanics` enters this way (hand-built) |
| package boundary (lowered + serialized + contract extracted) | observed | n/a | not_exercised | observed | observed | observed | not_observable | archive / sign / install **not** exercised |
| installed package (`xo create/pack/install`, `xo run`) | not_exercised | not_exercised | not_exercised | not_exercised | not_exercised | not_exercised | not_observable | apps/cli tests; not compared |
| CLI `xo capabilities` | not_exercised | not_exercised | not_exercised | n/a | n/a | n/a | n/a | calls the same `compileSources` + `discoverAndResolveCapabilities` |
| CLI `xo workflow` / `xo demo` | not_exercised | not_exercised | n/a | not_exercised | not_exercised | not_exercised | not_exercised | shares `composeWorkflows` + `prepareCandidateWorkflowForExecution` |
| API compile + capability listing | not_exercised | not_exercised | not_exercised | n/a | n/a | n/a | n/a | `apps/api/test/benchmark-equivalence.test.ts` (§3) |
| API capability execution | not_exercised | not_exercised | not_exercised | not_exercised | not_exercised | not_exercised | not_exercised | same test: 3 outcomes |
| API workflow execution | not_exercised | not_exercised | n/a | not_exercised | not_exercised | not_exercised | not_exercised | API workflow tests |
| direct capability execution | observed | observed | observed | observed | observed | observed | observed | observer |
| workflow-contained capability | observed | observed | observed | observed | observed | observed | observed | observer; **not** compared with the direct path |

Traced end to end (not inferred from shared helpers): the observer, `xo capabilities`, `xo workflow` and the API all start at `compileSources`. **Binding resolution is where they genuinely
diverge:** the live graph (observer, API) uses `STANDARD_BINDING_RESOLVERS` (structured comparison **and** action escalation); the installed `xo run` path (`deterministic-router.ts`) reads the contract
from the package boundary (`extractContractFromPropertyBag`) and resolves **only** `StructuredComparisonBindingResolver`, with no live graph and so no `graphHash`.

## 2. Comparable pairs (and why each is included or excluded)

| Pair | Included? | Why |
|---|---|---|
| **live graph ↔ serialized graph** | **yes** | the same graph through `toJson` → `fromJson`; this is the serialized-XOIR path's fidelity |
| **live graph ↔ package boundary** | **yes** | the same graph through capability lowering → serialization → contract extraction, the exact sequence the packager and installed router perform. Built on **clones**; the observed graph is never mutated. The archive / sign / install steps are **not** run, so this is the package *boundary*, not the installed package |
| observer ↔ API | no (benchmark) | the benchmark package cannot import the app; pinned by the existing apps/api test (§3) |
| observer ↔ CLI | no | `xo capabilities` calls the same functions; no benchmark-level comparison exists and none was invented |
| CLI ↔ API | no | no shared fixture harness exists; artificial pair |
| direct capability ↔ workflow-contained | no | a workflow step's input comes from data flow, not from the direct request; the same semantic input is not available |
| live graph ↔ installed package | no | requires archive / sign / install; not small, not justified here |

## 3. The existing API equivalence test (audited, not extended)

`apps/api/test/benchmark-equivalence.test.ts` compares the API with the benchmark observer on **two PDFs** (commercial policy, burglary schedule) and **three executions** (commercial).

| Compared | Not compared |
|---|---|
| the sorted set of `capabilityId`, `name`, `resolution`, `executionClass` | confidence, category, node population, contracts, contract content hashes, bindings, provenance, graph hash, workflow composition, workflow execution, the other 6 fixtures |
| execution `outcome` + `matched` for a deterministic, an HITL and an unresolved request | execution provenance, receipts, authorization |

So "API equivalence" means **capability-listing and outcome equivalence on two fixtures**, not full semantic equivalence.

## 4. Comparison dimensions and normalization

| Dimension | Pair | Meaning |
|---|---|---|
| `graph_hash` | both | compared **only** between objects of the same identity (see §6, finding 1) |
| `capability_present` | serialized | the capability set, keyed by capability id |
| `contract_embedded` | package | a lowerable capability's contract is present in the package boundary |
| `contract_hash` | both | `computeContractContentHash` of each path's contract (the same canonical function) |
| `binding` | both | `status`, `bindingId`, `implementationClass` |
| `execution_outcome` | package | outcome + `matched`, same input, deterministic capabilities |
| `execution_provenance` | package | recorded `contractId`, `bindingId`, `contractContentHash` (`graphHash` excluded: the package has none by design) |

**Normalization: none.** Capability ids are content-derived XOIR node ids, so they are comparable across paths over the same graph; ordering never matters (units are keyed and sorted by id);
path-local fields (names, positions) are not compared. No rule was added to make two paths equal.

## 5. States and the metric

`match` / `mismatch` (both observed, comparable) are the **only** judged states. `unknown` (a side recorded nothing, e.g. the package's missing `graphHash`), `not_comparable` (different semantic
object, or out of the path's declared scope), `not_exercised` and `not_observable` are reported in the breakdown and **never** pass or fail.

**`crossPathConsistency`** — descriptive (no golden), `when_measured`: numerator = matching units; denominator = match + mismatch over all units of both pairs. Absent (never 100%) for serialized-XOIR
entries and when nothing was judged. A mismatch is an item `pair|dimension|subject` carrying both raw values. Registry entry, limitation **L16**; consistent with the Step 2 accounting states.

## 6. Findings (measured, not fixed)

1. **A freshly compiled graph's `graphHash` is run-specific.** Node and edge `metadata.createdAt` is hashed **deliberately, as provenance** (`hashing.ts`; `updatedAt` and `reviewStatus` are excluded) — *corrected in Step 7: this document first said both timestamps feed the hash* — so two independent compilations of an identical fixture have different graph hashes
   while capability ids, contract hashes and bindings are identical. A graph hash is stable only for one graph instance and its serialized copies. Comparing it between separately compiled paths (observer vs API) would be a false
   mismatch; this benchmark compares it only inside one graph instance (live ↔ serialized: 7/7 match). **This matters for Step 7.**
2. **A lowered graph is a different semantic object from the unlowered one** (lowering embeds contracts and moves the content hash, documented in `capability-lowering.ts`). The live ↔ package `graph_hash` is therefore `not_comparable` (7 units), never a mismatch.
3. **The installed path is deliberately narrower.** For **all 19** human-in-the-loop capabilities the live path resolves `resolved` / `human_in_the_loop` while the installed path's resolver returns `unresolved`. Lowering embeds
   those contracts (`contract_embedded` and `contract_hash` match) but `xo run` executes only deterministic ones. This is classified `not_comparable` (out of the installed path's declared scope) with both raw values kept on the unit.
4. **Every judged unit agrees: 355/355, 0 mismatches.** Serialization is faithful; every lowered contract equals the live contract (42/42); 14/14 deterministic executions on the package boundary give the same outcome, result and recorded contract / binding provenance as the live path.

## 7. Case-by-case

| Case | Paths exercised | Judged | Serialized (hash / set / contract / binding) | Package (embedded / contract / binding) | Package executions | Not judged |
|---|---|---|---|---|---|---|
| `synthetic-claim-rules` | live, serialized, package | 19/19 | 1 / 2 / 2 / 2 | 2 / 2 / 2 | 3 match | 2 not run |
| `commercial-property-policy` | same | 181/181 | 1 / 33 / 33 / 33 | 20 / 20 / 19 | 11 match | 13 not lowerable, 1 HITL binding, 1 HITL run, 3 not run |
| `aastha-operations` | same | 79/79 | 1 / 16 / 16 / 16 | 15 / 15 / 0 | 0 | 15 HITL bindings, 1 not lowerable, 1 HITL run, 1 not run |
| `burglary-policy-schedule` | same | 34/34 | 1 / 7 / 7 / 7 | 5 / 5 / 2 | none requested | 2 not lowerable, 3 HITL bindings |
| `multidoc-burglary-claims` | same | 28/28 | 1 / 9 / 9 / 9 | 0 / 0 / 0 | none requested | 9 not lowerable (unresolved) |
| `structured-operation-data-flow` | same | 7/7 | 1 / 2 / 2 / 2 | 0 / 0 / 0 | none ran | 2 not lowerable, 1 not run |
| `openapi-operation-data-flow` | same | 7/7 | 1 / 2 / 2 / 2 | 0 / 0 / 0 | none ran | 2 not lowerable, 1 not run |
| `runtime-mechanics` | **none** — hand-built XOIR, not forced into source comparison | — | — | — | — | metric absent |

Every case also has one `graph_hash` `not_comparable` unit (live vs package). Provenance dimensions reuse Step 5's projection / agreement; the package `graphHash` is `unknown` by design, never a failure.

## 8. Not exercised and not observable

* **Not exercised:** the installed package (archive, signature, install, mount), CLI and API paths, workflow ↔ direct, execution on the serialized path.
* **Not observable:** graph hash on the package boundary (by design); ExperienceUnit existence (Step 5, L14).
* **Not compared although comparable in principle:** observer ↔ API beyond the existing test (needs an app-level harness).

## 9. Relationship to Step 5 and Step 7

* **Step 5:** no second provenance model. Contract hash, binding id and recorded execution provenance come from the same P0.9B projection / observation; `executionProvenanceAgreement` still covers live-graph recorded-vs-projected agreement, while this step compares *across* paths.
* **Step 7:** baselines are untouched. `vertical-fixtures` gains `crossPathConsistency`; `runtime-mechanics` is unchanged. Step 7 must account for the **run-specific graph hash** (finding 1) before any baseline stores or compares one.
