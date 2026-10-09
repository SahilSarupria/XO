# XO Benchmark — Evidence / Provenance Evaluation

**P0.9C Step 5.** What provenance link exists today, which can be observed, which can be verified *independently of the implementation's own
claims*, and the two metrics this step adds. Companion to `EVALUATION_MODEL.md` (§17 addendum), `PRODUCER_ATTRIBUTION.md` (Step 4) and the P0.9B
provenance projection (`@xo/capability-contract` `provenance-projection.ts`). This is an evaluation milestone: no compiler, XOIR, runtime or contract
behavior was changed, and no provenance was repaired.

Machine-checkable: `src/observe.ts` (observation), `src/evaluate.ts` (metrics), `src/evaluation-model.ts` (registry, L14–L15), `test/provenance.test.ts`.

## 1. Provenance layers (kept separate; none is merged into another's score)

| Layer | Question | Carried by | Evaluated by |
|---|---|---|---|
| Source provenance | where did the object originate | `sourceRefs[].documentPath` (+ pages, sectionPath, charOffsetRange) | `observedSourceRefCoverage` (presence), `provenanceChainCoverage` (resolves to a declared source) |
| Evidence provenance | what source evidence supports the assertion | `sourceRefs` against a golden evidence spec | `provenanceCompleteness` |
| Producer attribution | which extractor created it | `producedBy` | Step 4 (never read here) |
| Contract / binding provenance | which contract represents the capability, which binding | `contractId`, `contractContentHash`, `bindingId` | `provenanceChainCoverage` (contract link); binding state observed |
| Execution provenance | which contract / binding / graph actually ran | the runtime's recorded `graphHash`, `contractContentHash`, `bindingId`, `contractId` | `executionProvenanceAgreement` |

## 2. The actual chain available today (verified, not assumed)

"Exists" means the code creates the link. "Observable" means the benchmark can read it. "Independently verifiable" means a check against structure
the implementation does not itself assert (declared source paths, graph node ids, a second projection). An id merely being present is **never** counted as verified.

| Link | Exists | Observable | Independently verifiable | Benchmarkable | Evidence / note |
|---|---|---|---|---|---|
| source → source unit | yes (adapters) | **no** | no | **not_observable** | `compileSources` returns per-source `unitCount` only, no unit list |
| source unit → semantic node | yes: every node ref carries `experienceUnitId`, `sectionPath`, `charOffsetRange` (measured: 100% of nodes in all 7 compiled cases) | id is **opaque**: dropped by `ContractSourceRef` and by `ObservedSourceRef` | **no**: a unit id's *existence* cannot be checked | **not_observable** (§6) | see ExperienceUnit limitation |
| source → node (document) | yes: `documentPath` is a source id | yes, mapped to the declared path | **yes**: it must resolve to a source the compile reported | **yes** (`source_resolves`) | |
| node → evidence | yes (same `sourceRefs`) | yes | yes against golden pages (Step 3: 47/48 verified) | yes (`provenanceCompleteness`) | presence + document + pages only |
| semantic node → capability | yes: `contract.sourceXoirNodeIds` (the capability node plus linked rule/action nodes) | yes (P0.9B projection) | **yes**: every id must resolve in the graph and include the capability node | **yes** (`nodes_resolve`) | no *edges* touch capabilities at compile time; the link is the contract's id list |
| capability → contract | yes (`buildSemanticCapabilityContract`) | yes | **yes**: `contract.sourceRefs` must be carried by the linked nodes; `contractContentHash` must recompute identically | **yes** (`refs_carried`, `hash_deterministic`) | one distinct hash per capability in every case |
| contract → binding | yes (`resolveCapabilityBinding`) | yes (status, `bindingId`) | resolved/unresolved/ambiguous/denied is a *state*, not a link | **observed, not required** | 42 resolved / 29 unresolved of the 71 compiled capabilities; unresolved is a legitimate outcome |
| binding → manifest | yes (`lowerCapabilitiesToManifest` embeds the contract) | **no**: the benchmark builds no package | — | **not_exercised** | |
| manifest → runtime | yes (install / mount) | **no** | — | **not_exercised** | the installed path records no `graphHash` (documented in `contract-execution.ts`) |
| runtime → execution record | yes: the runtime passes `contractId`, `bindingId`, `sourceXoirNodeIds`, `graphHash`, `contractContentHash` through | yes (the observer now keeps them; it previously discarded `result.value`) | **yes**: P0.9B `projectExecutionProvenance` compares them with the live-graph view | **yes** for requests that ran | |

## 3. Existing source-reference metrics (audited; definitions unchanged)

| | `provenanceCompleteness` | `observedSourceRefCoverage` |
|---|---|---|
| Numerator | evidence specs satisfied by the located item (min refs / document / pages) | observed nodes with ≥ 1 source reference |
| Denominator | evidence specs on **located** facts and capabilities | all observed nodes |
| Population | golden expectations that carry an `evidence` spec | the graph (descriptive; no expectation) |
| World | open / closed alike | open / closed alike |
| Missing refs | a failed spec (`mismatched`) | a smaller numerator |
| "Complete" means | the cited refs meet the spec | at least one ref exists |

Both are **internally correct and consistent with `EVALUATION_MODEL.md`, but narrower than their names suggest**: they measure source-reference
*presence and placement*, not a derivation chain. They **can hide a broken chain**: `test/provenance.test.ts` builds two observations with identical
source refs where one capability links a node id that does not exist; both existing metrics are byte-identical for the two, while `provenanceChainCoverage` is 1/1 vs 0/1.
Neither was redefined (their definition text is pinned against the committed baselines by `attribution.test.ts`).

## 4. `provenanceChainCoverage` (new; descriptive)

> Of the capabilities of a compiled case, what fraction have a compile-side chain (source → node → capability → contract) that is internally connected?

A capability's chain is **complete** when all four checks hold, each against independent structure:

1. `source_resolves` — it has ≥ 1 contract source ref and every one resolves to a source the compile declared;
2. `nodes_resolve` — it links ≥ 1 XOIR node, every linked id resolves in the graph, and the list includes the capability node itself;
3. `refs_carried` — every contract source ref is carried (same document and pages) by a linked node;
4. `hash_deterministic` — `contractContentHash` is present and a **second** projection of the same graph reproduces it.

Not required: binding state (reported as `binding.<status>` in the breakdown), the ExperienceUnit link (not observable), manifest / runtime links (not exercised).
Population: every observed capability of a case whose compile ran. **Absent** (never 0%) for serialized-XOIR entries, failed compiles, or no capability.
Descriptive (no golden expectation): it does not make an expectation-free suite count as `measured`. A broken chain is a `missing` item naming the failed link.

**What it does and does not say.** It says the links that exist are *internally connected and deterministic*. It does **not** say the provenance is semantically
correct, nor complete (L14). Today it is 71/71 — a regression guard for chain integrity.

## 5. `executionProvenanceAgreement` (new; descriptive)

> For capabilities the runtime actually executed, does the provenance the execution *recorded* agree with the live-graph view?

* **Observation:** the observer keeps the runtime's pass-through fields for capability requests and for each workflow step (via the existing recording wrapper), and
  joins them to the P0.9B projection with `projectExecutionProvenance` — consumed unchanged. `agreement` is P0.9B's own field-by-field equality
  (`graphHash`, `contractContentHash`, `bindingId`, `contractId`).
* **Per unit state:** `match` (all four match) · `mismatch` (any mismatch; each field named) · `unknown` (a side is absent — e.g. an installed package records no `graphHash`) ·
  `not_exercised` (the request did not run: not executable, invalid input, refused workflow, un-run step) · `not_observable` (it ran but no record was captured).
* **Metric:** numerator = `match`; denominator = `match` + `mismatch`. `unknown`, `not_exercised` and `not_observable` are **never** counted — they appear in the breakdown only.
* **Absent** when nothing ran or every executed capability is `unknown`.

**What it does and does not say (L15).** It compares two derivations of the same facts from the same graph, so it detects divergence (a stale hash, the wrong contract or
binding, a different graph) but does not prove the contract is correct. Live-graph path only. Today it is 28/28 (synthetic 3, commercial 13, aastha 2, runtime-mechanics 10); 11 further
requests in those cases did not run (plus 4 in the structured / OpenAPI cases, where nothing ran) and are reported as `not_exercised`.

## 6. ExperienceUnit and package / installed-path limitations (recorded, not worked around)

* **ExperienceUnit.** The id *is* carried on every XOIR node ref, but (a) `ContractSourceRef` drops it, (b) `ObservedSourceRef` drops it, and (c) the compile result exposes no unit list, so
  even an observed id could not be checked for existence. Inventing a benchmark-only mapping was rejected. The link is **`not_observable`**; the architectural fix (carry the unit through the
  contract and expose the unit list) is a later milestone.
* **Package / installed path.** The benchmark builds no package and mounts no runtime, so binding → manifest → runtime is **`not_exercised`**, not pretended. No package benchmark was added.

## 7. Provenance paths that exist (recorded for Step 6; not compared here)

| Path | Provenance recorded | Benchmark |
|---|---|---|
| direct capability execution, live graph | all five fields, `graphHash` supplied | **exercised** |
| workflow execution (runtime bridge) | per step, same fields | **exercised** |
| serialized XOIR (hand-built, `runtime-mechanics`) | same, no compile result | exercised (chain `not_observable`) |
| API execution | `graphHash` recorded on workflow executions | not exercised |
| CLI (`xo run`, `xo workflow`) | installed-package path: no `graphHash` | not exercised |
| installed package | contract from the embedded property bag; no `graphHash` | not exercised |

## 8. Per-case provenance observability

| Case | Source / evidence | Capability | Contract | Binding (resolved / unresolved) | Execution | Chain | Agreement |
|---|---|---|---|---|---|---|---|
| `synthetic-claim-rules` | ✓ | 2 | ✓ | 2 / 0 | requested | 2/2 | 3/3 (3 not run) |
| `commercial-property-policy` | ✓ | 33 | ✓ | 20 / 13 | requested | 33/33 | 13/13 (4 not run) |
| `aastha-operations` | ✓ | 16 | ✓ | 15 / 1 | requested | 16/16 | 2/2 (1 not run) |
| `burglary-policy-schedule` | ✓ | 7 | ✓ | 5 / 2 | none requested | 7/7 | absent |
| `multidoc-burglary-claims` | ✓ | 9 | ✓ | 0 / 9 | none requested | 9/9 | absent |
| `structured-operation-data-flow` | ✓ | 2 | ✓ | 0 / 2 | requested, none ran | 2/2 | absent (not exercised) |
| `openapi-operation-data-flow` | ✓ | 2 | ✓ | 0 / 2 | requested, none ran | 2/2 | absent (not exercised) |
| `runtime-mechanics` | hand-built: no compile | 8 | ✓ | 7 / 1 | requested | **not_observable** | 10/10 (3 not run) |

"Chain complete" is true wherever the chain is observable (71/71); "chain measurable" is false only for the hand-built case. Known gaps for every case: ExperienceUnit existence
(`not_observable`), binding → manifest → runtime (`not_exercised`).

## 9. Metrics deferred

* **`contractBindingLinkage`** — which contract / binding a capability *should* have needs a golden. Only the structured-operation fixtures could supply one (their binding is `unresolved` because no
  implementation exists), and that is already measured by `resolutionAccuracy`. Observed binding state is reported in the chain breakdown. Not forced.
* **No golden provenance expectations were added.** The one defensible candidate (structured operation → its source file) would be a new `evidence` spec and change the *existing*
  `provenanceCompleteness` denominator of those cases; that decision is left to you.

## 10. Baselines and regression

No baseline was regenerated. Every pre-existing metric, item and fingerprint is identical to Step 4 (provenance is excluded from stage fingerprints, like `producedBy`). `vertical-fixtures` gains the two
new metrics; `runtime-mechanics` gains `executionProvenanceAgreement`, so it is no longer byte-identical to its committed baseline — the guard that pinned that now compares the output *minus the Step 5 metrics*.
`EVALUATION_VERSION` is unchanged.

## 11. Relationship to P0.9B and to Step 6

The benchmark **consumes** `projectAllCapabilityProvenance` and `projectExecutionProvenance` unchanged; it adds no identity and no trust semantics (the projection reports equality, it does not gate). Of the
P0.9B projections, workflow-level `projectWorkflowProvenance` is **not** consumed (step-level agreement is observed directly), and note that **no production code** outside tests consumes any of the three
projection APIs. Step 6 (cross-path) will need the same observation on the API / CLI / installed paths; the `unknown` state defined here is exactly what an installed-package execution (no `graphHash`) will produce.
