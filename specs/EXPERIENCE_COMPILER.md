# Experience Compiler — Architecture Specification v1.0
### The Compiler Front End, Middle End, and Back End for Professional Capability

---

## 0. Positioning

An Experience Object is a binary. Something has to produce it, and that something cannot be a script that scrapes a PDF and stuffs the text into a prompt template. That approach caps out at "document summarizer" and cannot represent reasoning strategy, risk tolerance, escalation policy, or the difference between a fact a professional knows and a judgment call a professional makes.

The Experience Compiler is the tool that actually produces XOs, the same way LLVM's toolchain actually produces executables. Nobody hand-writes machine code for a new CPU target; they write a front end that lowers their language into LLVM IR, and every existing optimization pass, every back end, every target already works. The same separation of concerns applies here: nobody should have to re-invent contradiction detection, duplicate elimination, or safety verification every time someone wants to compile a new profession into an XO. They write a front end for their source type — a PDF adapter, a Git-history adapter, a Slack adapter — that lowers heterogeneous expertise into **Experience IR (EIR)**, and the entire middle end (optimization, linking, validation, benchmark synthesis) and back end (packaging into the XO format defined in `SPECIFICATION.md`) is shared, profession-agnostic infrastructure.

This document treats the compiler as three architectural layers, exactly like a real compiler:

```
FRONT END                    MIDDLE END                       BACK END
─────────────                ──────────────────────────       ──────────────
Source Adapters   ─lower──►  EIR  ─optimize──►  EIR'  ─────►  Packager ──► .xo
(§2)                         (§3, §4)                          (§9)
                                    │
                                    ▼
                              Linker (§5)
                              Validator (§6)
                              Benchmark Synth (§7)
```

The compiler never emits code that "sounds like" an expert. It emits a typed, versioned, queryable graph of *what the expert knows, how the expert decides, and where the expert has been wrong before* — and only the packaging stage turns that graph into the artifact format the runtime consumes. Everything upstream of packaging is independent of the XO format itself; if the ecosystem's package format changes in v2.0, only the back end changes. If a new profession appears, only a front-end adapter is needed. If a new optimization technique is invented, it becomes a pass that every existing front end benefits from immediately. This is the property that makes EIR — not the XO package format — the actual long-term intellectual property of the platform, in the same way LLVM IR, not any single `.exe`, is what made LLVM a foundational technology.

---

## 1. System Architecture Overview

### 1.1 Pipeline stages

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          EXPERIENCE COMPILER                              │
│                                                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────────┐   │
│  │  FRONT END   │  │  MIDDLE END  │  │            BACK END            │   │
│  │              │  │              │  │                                │   │
│  │ Source       │  │ Extraction   │  │ Packager                       │   │
│  │ Adapters(§2) │─►│ Engine (§2.4)│─►│ ...                            │   │
│  │              │  │      │       │  │                                │   │
│  │              │  │      ▼       │  │                                │   │
│  │              │  │ EIR Builder  │  │                                │   │
│  │              │  │   (§3)       │  │                                │   │
│  │              │  │      │       │  │                                │   │
│  │              │  │      ▼       │  │                                │   │
│  │              │  │ Pass Manager │  │                                │   │
│  │              │  │   (§4)       │  │                                │   │
│  │              │  │      │       │  │                                │   │
│  │              │  │      ▼       │  │                                │   │
│  │              │  │ Linker (§5)  │──┼─► Validator (§6) ──► Benchmark  │   │
│  │              │  │              │  │                      Synth(§7) │   │
│  │              │  │              │  │           │                    │   │
│  │              │  │              │  │           ▼                    │   │
│  │              │  │              │  │      Packager (§9) ──► .xo     │   │
│  └─────────────┘  └──────────────┘  └────────────────────────────────┘   │
│                                                                            │
│  Cross-cutting: Provenance Ledger · Compiler Trace · Learning Loop (§10) │
└──────────────────────────────────────────────────────────────────────────┘
```

Every arrow in this diagram is a well-defined, independently versioned interface. A compilation is not "run a script"; it is a **compilation job** — a DAG of stage invocations, each one producing an immutable, content-addressed artifact that the next stage consumes. This makes every intermediate state cacheable, replayable, and diffable, which is what makes phases like "re-run extraction on one new source and re-link" tractable instead of requiring a full recompile.

### 1.2 Deployment topology

Like the runtime, the compiler is not a monolith — it is a set of independently scalable services orchestrated by a **Compiler Driver**.

| Service | Statefulness | Scaling driver |
|---|---|---|
| Compiler Driver (job orchestration, DAG scheduling) | Stateless (state in Job Store) | Concurrent compilation jobs |
| Ingestion Workers (per-adapter, §2) | Stateless, horizontally scaled per adapter type | Source volume × adapter type |
| Extraction Engine (§2.4) | Stateless, GPU-bound for audio/video/vision sources | Ingestion volume |
| EIR Builder / Store | Stateful (graph store, content-addressed) | EIR node count × query rate |
| Pass Manager Workers (§4) | Stateless, per-pass parallelism | EIR size × pass count |
| Linker (§5) | Stateful during a merge, stateless otherwise | Number of experts being linked |
| Validator (§6) | Stateless, some passes GPU-bound (hallucination probes) | EIR size × validation depth |
| Benchmark Synthesizer (§7) | Stateless, LLM-assisted generation | EIR capability count |
| Packager (§9) | Stateless | Compilation completions |
| Provenance Ledger | Append-only store, write-heavy | Ingestion + edit event rate |
| Compiler Trace / Observability | Stateless, streaming | Span volume |

This decomposition means a 400-page contract corpus and a 40-hour screen-recording corpus for the *same* XO can ingest in parallel, on different hardware profiles (CPU-bound text extraction vs. GPU-bound video/audio extraction), and converge at the EIR Builder before optimization ever starts.

### 1.3 Relationship to the XO Runtime and Marketplace

The compiler is upstream of both other components and depends on neither at build time — it only needs to know the **target XO package schema** (§9) to emit valid output, exactly as an LLVM back end only needs to know a target's instruction set, not anything about the operating system that will eventually run the binary. The runtime never calls the compiler; the marketplace never calls the compiler except to trigger recompilation on new evidence (§10). This one-directional dependency is deliberate: it is what lets the XO format evolve, the runtime evolve, and the compiler evolve on independent release cycles.

---

## 2. Front End — Ingestion & Extraction

### 2.1 Source Adapter model

Every adapter implements one contract:

```
Adapter.discover(source_ref)      → SourceManifest
Adapter.extract(source_manifest)  → RawArtifact[]
Adapter.provenance(artifact)      → ProvenanceRecord
```

An adapter is not required to understand expertise — only to turn a heterogeneous, possibly binary source into `RawArtifact` objects (text spans, code diffs, transcript turns, image regions, structured records) each carrying a mandatory `ProvenanceRecord`. This is the front end's *only* job: normalize form, never normalize meaning. Meaning extraction is a separate, source-agnostic stage (§2.4) so that a Slack adapter and a book adapter both hand off to the same reasoning-pattern extractor rather than each reimplementing it.

### 2.2 Adapter families (illustrative, not exhaustive)

| Family | Examples | Extraction focus |
|---|---|---|
| Document | PDF, books, papers, contracts, medical reports | Structured text, citations, defined terms, clause structure |
| Code & DevOps | Git history, PRs, code review comments, CI logs | Diffs, review reasoning, failure→fix pairs, commit rationale |
| Conversation | Slack, Discord, Teams, email threads | Turn-taking, decision threads, escalation chains, tone |
| Media | Recorded meetings, audio, video, screen recordings | ASR transcript + speaker diarization + on-screen action trace |
| Structured knowledge | Existing RAG indexes, knowledge graphs | Entity/relation extraction, existing embeddings as priors |
| Model-derived | Fine-tuned models, LoRAs, prompt libraries | Weight-diff probing, prompt pattern mining, behavior elicitation |
| Synthetic & eval | Synthetic datasets, benchmarks, correction histories, expert feedback | Labeled decision pairs, known-good/known-bad exemplars |

A source that doesn't exist for a given compilation is simply an adapter that is never invoked — the pipeline downstream has no dependency on any specific adapter having run, only on the *EIR* it produces. This satisfies the "do not assume every source exists" requirement structurally rather than through conditional logic scattered across the compiler.

### 2.3 Provenance is a first-class type, not metadata

Every `RawArtifact` — and every EIR node derived from it — carries a `ProvenanceRecord`:

```
ProvenanceRecord {
  source_id           // content hash of the originating source
  source_type          // adapter family
  author               // resolved identity, or "unattributed"
  timestamp            // creation time of the underlying evidence
  ingestion_time
  confidence           // adapter's own confidence in the extraction (0-1)
  licensing_ref         // pointer into the Licensing Ledger (§8.4-equivalent)
  ownership_claim       // contributor id(s) with royalty share basis points
  transformation_chain[] // ordered list of every pass that touched this node
}
```

Provenance is never summarized away. When two EIR nodes are merged by an optimization pass (§4), the merged node's provenance is the *union* of both chains, not a new synthetic record — this is what lets `provenance/contributors.json` in the final XO package (already defined in the marketplace spec) be generated automatically rather than hand-maintained, and what lets royalty computation trace any inference back to the specific sentence, commit, or transcript turn that justified it.

### 2.4 Experience Extraction Engine (Phase 2)

This is the stage that turns normalized `RawArtifact`s into typed **Experience Candidates** — the pre-IR objects that the EIR Builder (§3) assembles into a graph. Extraction is organized as a set of specialized extractors that all read the same `RawArtifact` stream and each look for one *kind* of expertise signal:

| Extractor | Detects | Typical evidence |
|---|---|---|
| Decision Pattern Extractor | Repeated if-this-then-that structures in expert behavior | Code review comment patterns, contract clause selection, diagnostic branching |
| Reasoning Strategy Extractor | The *order* and *justification structure* of steps, not just the conclusion | "Screen recording" step traces, chain-of-thought in written opinions, meeting deliberation transcripts |
| Heuristic Extractor | Rules of thumb stated or implied, with their exception conditions | "Usually X, unless Y" language, footnotes, review comment caveats |
| Preference & Style Extractor | Stable stylistic and communication choices | Tone across emails, formatting conventions, terminology choices |
| Risk Tolerance Extractor | How aggressively the expert accepts vs. flags uncertainty | Escalation language, hedging frequency, sign-off patterns |
| Exception & Escalation Extractor | Explicit "when to stop and ask a human" boundaries | "Loop in compliance if...", "get a second opinion when..." |
| Failure/Success Pattern Extractor | Outcomes paired with the decision that produced them | Post-mortems, correction histories, revised drafts, code review→bug link |
| Common Mistake Extractor | Recurring errors *other* people made that the expert corrects | Review comments, redlines, teaching material |
| Implicit Knowledge Extractor | Knowledge never stated directly but required to explain observed decisions (inferred via consistency-gap analysis, §2.5) | Gaps between stated reasoning and observed action |
| Confidence Estimator | Calibrates how certain the expert appears to be, per claim | Hedge words, revision frequency, citation density |

Each extractor emits `ExperienceCandidate` objects of a specific subtype (Decision Pattern, Heuristic, etc. — these subtypes become EIR node kinds, §3.2), each still carrying full provenance and a raw confidence score from the extractor itself. Extractors run independently and in parallel; they are not a linear pipeline, because a single transcript turn can simultaneously be evidence of a decision pattern, a risk-tolerance signal, and a communication-style sample.

### 2.5 Implicit knowledge via consistency-gap analysis

The hardest of the ten signal types is implicit knowledge — expertise the professional relies on but never states, because it's second nature to them. The extraction engine surfaces this by holding two representations of the same expert side by side: a **stated model** (built purely from what the expert explicitly says: heuristics, documented rules) and an **observed model** (built purely from what the expert actually does: decisions, corrections, chosen paths). Wherever the observed model makes a decision the stated model can't explain, that gap is emitted as an `ImplicitKnowledgeCandidate`, flagged with low initial confidence and routed to the Validation stage (§6) for either human confirmation or corroboration from a second independent source before it can enter EIR with normal confidence weight. This keeps the extractor honest — it cannot silently promote a guess about *why* an expert did something into a fact about what the expert knows without evidence discipline.

---

## 3. Experience Intermediate Representation (EIR)

### 3.1 Why an IR, and why this one

EIR exists for the same reason LLVM IR exists: to be the single point where N front ends meet M back ends, so the compiler needs N+M components instead of N×M. Concretely, EIR is what lets:

- A **profession** be independent of a **source type** — a radiologist's EIR and a tax lawyer's EIR are built by the same optimization passes even though one came primarily from DICOM-adjacent reports and imaging annotations and the other from contracts and case law.
- A **profession** be independent of a **target model family** — the same corporate-lawyer EIR compiles down to a LoRA for a model that supports fine-tuning and to a reasoning-trace + prompt-strategy bundle for a model that only supports in-context capability, because §9's packager, not EIR itself, makes that decision.
- **Composability** — a Tax Expert EIR and a GDPR Expert EIR can be linked (§5) into an Enterprise Legal EIR because they share a common node/edge type system, not because anyone hand-merges two different formats.

EIR is a typed, versioned, content-addressed **property graph**, not a flat document and not a token sequence. Graph structure is what lets it represent decision trees, escalation chains, and knowledge relationships natively, and it's what optimization passes (§4) operate on as first-class graph transformations rather than string rewrites.

### 3.2 Node taxonomy

Every node has a common envelope, then a type-specific payload:

```
EIRNode {
  id                  // content-derived hash
  kind                // one of the taxonomy below
  payload             // type-specific
  confidence          // propagated & recomputed (§3.6)
  provenance          // ProvenanceRecord union (§2.3)
  eir_version
  created_by_pass[]    // trace of which optimization passes touched this node
}
```

| Node kind | Represents | Key payload fields |
|---|---|---|
| `Concept` | A domain entity or term | definition, aliases, ontology position |
| `Fact` | A stated, source-grounded claim | statement, source strength |
| `Heuristic` | A rule of thumb | condition, action, exception_conditions[] |
| `DecisionNode` | One branch point in a decision graph | condition, outgoing edges to alternatives |
| `ReasoningStep` | One step in an ordered reasoning chain | justification, depends_on[] |
| `Preference` | A stable stylistic/communication choice | dimension, value, strength |
| `RiskPolicy` | A risk-tolerance rule | domain, tolerance_level, override_conditions |
| `EscalationRule` | When to defer to a human or another capability | trigger_condition, escalation_target |
| `FailureCase` | A known bad outcome and its cause | scenario, root_cause, corrective_pattern |
| `SuccessPattern` | A known good outcome and what produced it | scenario, contributing_factors |
| `Capability` | A named, invokable unit of skill (the thing users ultimately consume) | description, required_inputs, expected_outputs |
| `Constraint` | A hard limit the capability must respect | statement, severity |
| `SafetyPolicy` | A rule the compiled XO must never violate | statement, enforcement_level |
| `MemoryUnit` | A durable fact/episode intended for the runtime's memory graph | content, decay_policy |
| `EvaluationArtifact` | A test case or benchmark item derived from evidence | input, expected_behavior, difficulty |

### 3.3 Edge taxonomy

Edges are typed and directional; the graph is a multigraph (multiple edge types may connect the same two nodes):

`requires`, `contradicts`, `supports`, `refines`, `supersedes`, `escalates_to`, `triggered_by`, `co_occurs_with`, `derived_from` (points back to a `RawArtifact`, closing the loop to provenance), `composes_into` (used heavily by the Linker, §5).

`contradicts` and `supersedes` are what make contradiction-detection (§4) a graph query instead of an NLP heuristic re-run every time; once an edge is materialized, it's cheap to re-check.

### 3.4 Sub-graphs as views, not separate stores

The requirement to design "reasoning graphs, decision graphs, knowledge graphs, capabilities, constraints, safety policies" separately is satisfied as **typed views** over one graph, not five parallel data stores that can drift out of sync:

- **Knowledge Graph view** = `Concept`/`Fact` nodes + `requires`/`refines`/`contradicts` edges.
- **Reasoning Graph view** = `ReasoningStep` nodes + `depends_on` edges, optionally rooted at a `Capability`.
- **Decision Graph view** = `DecisionNode` nodes + their branch edges, terminating in `Capability` or `EscalationRule` nodes.
- **Capability Graph view** = `Capability` nodes + `requires`/`composes_into` edges into everything that capability depends on.

This matters because the same underlying evidence can simultaneously justify a knowledge-graph fact and a reasoning-graph step — with one graph, that's a shared node; with five stores, it's a synchronization problem.

### 3.5 Metadata & versioning

Every EIR instance carries a manifest analogous to (but distinct from) the XO manifest:

```
EIRManifest {
  eir_id
  spec_version           // EIR schema version — this is the "IR version" LLVM-style compatibility hinges on
  profession_tags[]
  source_manifest_refs[]  // which SourceManifests (§2.1) fed this EIR
  compiler_version         // which compiler build produced it
  pass_history[]           // ordered log of every optimization pass applied (§4.7)
  node_count / edge_count
  merkle_root
}
```

`spec_version` is what allows the compiler's optimization passes, the linker, and the packager to each declare which EIR versions they support — exactly how an LLVM pass declares which IR version it targets — so the compiler can evolve its IR without breaking every existing pass simultaneously; passes and back ends can be upgraded independently as long as they honor the version contract.

### 3.6 Confidence propagation

Confidence is not a static field copied from extraction. It is recomputed as a function of a node's own extraction confidence, the confidence and *number* of independent provenance sources supporting it, and the confidence of nodes it structurally depends on (a `Capability` cannot be more confident than the `ReasoningStep`s it composes). This propagation is itself implemented as a pass (§4.4) so it can be re-run cheaply whenever new evidence arrives, rather than being baked in once at extraction time.

### 3.7 Why EIR enables cross-profession, cross-model portability

Two independent axes of portability fall out of this design for free:

1. **Cross-profession** — the node/edge taxonomy makes no reference to any domain vocabulary. "Radiologist" and "tax expert" are `profession_tags` on the manifest and a difference in *which* `Concept` and `Heuristic` nodes exist, not a difference in schema. A pass like contradiction detection or dead-knowledge elimination works identically regardless of profession because it operates on `contradicts` edges and confidence scores, never on domain content.
2. **Cross-model** — nothing in EIR assumes a target model's architecture, context length, or fine-tunability. The decision of "this becomes a LoRA" vs. "this becomes a reasoning-trace bundle" is made entirely in the Packager (§9), which reads capability model requirements from `SPECIFICATION.md`'s compatibility matrix. EIR itself is where portability *lives*; the package format is just one possible lowering of it, in the same sense that LLVM IR can be lowered to x86, ARM, or WASM without the IR itself changing.

---

## 4. Optimization Passes

### 4.1 Pass Manager

Passes are the compiler's core reusable IP. Each pass is a pure function `EIR → EIR'` (plus a structured `PassReport`) registered with a declared input/output EIR version range and a set of **prerequisite passes** it depends on having already run — the Pass Manager topologically orders the requested pass pipeline and executes it, exactly as an LLVM pass manager schedules analysis and transform passes. Passes are categorized as **Analysis** (produce facts about the graph, don't mutate it — e.g. contradiction detection) or **Transform** (mutate the graph — e.g. duplicate elimination), and a Transform pass typically consumes the output of one or more Analysis passes.

```
Pass {
  name, version
  kind                    // analysis | transform
  requires_passes[]
  invalidates_passes[]     // which prior analyses are no longer valid after this transform runs
  run(EIR) → (EIR', PassReport)
}
```

### 4.2 Standard pass catalog

| Pass | Kind | Purpose |
|---|---|---|
| Duplicate Elimination | Transform | Collapse semantically identical nodes from multiple sources into one, unioning provenance |
| Contradiction Detection | Analysis | Materialize `contradicts` edges between nodes with incompatible claims/heuristics |
| Conflict Resolution | Transform | Resolve detected contradictions via precedence rules (source authority, recency, confidence, explicit expert override) or flag for human resolution if unresolvable |
| Knowledge Graph Simplification | Transform | Remove redundant `requires`/`refines` paths where a shorter equivalent path exists |
| Reasoning Graph Compression | Transform | Merge `ReasoningStep` chains that are observed as always co-occurring into a single composite step |
| Semantic Normalization | Transform | Canonicalize terminology across sources (e.g., "counterparty" vs. "other party") against a profession ontology |
| Capability Extraction | Analysis→Transform | Cluster reasoning/decision subgraphs into named `Capability` nodes — this is what turns a soup of extracted knowledge into the discrete, invokable units the runtime actually loads |
| Capability Clustering | Transform | Group related `Capability` nodes for coherent packaging boundaries and Capability Index generation (§9.2) |
| Prompt Optimization | Transform | Distill `ReasoningStep`/`Preference` subgraphs into candidate system-prompt / strategy artifacts for the `prompt_strategies` component |
| Memory Deduplication | Transform | Same as duplicate elimination, scoped to `MemoryUnit` nodes bound for the runtime's memory graph |
| Dead Knowledge Elimination | Transform | Remove `Concept`/`Fact` nodes with no incoming `requires` edge from any `Capability` — unreachable knowledge, analogous to dead code |
| Unused Capability Removal | Transform | Remove `Capability` nodes explicitly excluded from the compilation target's scope |
| Dependency Resolution | Analysis | Verify every `Capability`'s `requires` chain is satisfiable within the EIR; surface missing dependencies before packaging |
| Benchmark Generation (analysis half) | Analysis | Identify high-value EIR regions (high-confidence, high-usage-likelihood `Capability` subgraphs) as candidates for Benchmark Synthesis (§7) |
| Safety Verification (analysis half) | Analysis | Check every `Capability` has a reachable `SafetyPolicy`/`Constraint` path; flag capabilities with none |
| Compression for Deployment | Transform | Profile-guided trimming of low-marginal-value nodes to hit a target package size/latency budget for a specific deployment profile (e.g. edge/mobile) |

### 4.3 Pass ordering & fixpoint iteration

Some passes must reach a fixpoint before proceeding — duplicate elimination can expose new contradictions, and conflict resolution can create new duplicate-eligible nodes. The Pass Manager runs the **Canonicalization Group** (Duplicate Elimination → Contradiction Detection → Conflict Resolution → Semantic Normalization) in a loop until no pass in the group reports a change, then proceeds to the **Structuring Group** (Capability Extraction → Knowledge Graph Simplification → Reasoning Graph Compression → Capability Clustering), then the **Pruning Group** (Dependency Resolution → Dead Knowledge Elimination → Unused Capability Removal), then the **Deployment Group** (Prompt Optimization → Memory Deduplication → Compression for Deployment). This staged-fixpoint structure mirrors LLVM's own separation of canonicalization from later structural optimization, and it's what prevents, e.g., capability clustering from running against knowledge that duplicate elimination hasn't finished consolidating yet.

### 4.4 Confidence Propagation as a pass

As noted in §3.6, confidence propagation is implemented as its own Analysis pass, re-runnable any time new evidence lands via the Learning Loop (§10), without requiring a full recompile.

### 4.5 Custom / profession-specific passes

The catalog above is deliberately generic. A profession vertical (e.g. Radiology) may register additional passes — a "DICOM measurement consistency" pass, for instance — that only activate when `profession_tags` matches, without those passes becoming part of the core catalog every other profession pays the cost of running. This is the compiler's equivalent of target-specific LLVM back-end passes: opt-in, declared, sandboxed to the professions that need them.

### 4.6 Determinism and idempotence

Every pass is required to be deterministic given the same input EIR and pass configuration, and idempotent where semantically applicable (running Duplicate Elimination twice produces the same output as running it once). This is what makes incremental recompilation (§10.2) and caching viable — the Pass Manager can memoize a pass's output keyed on `(pass_id, pass_version, input_eir_hash, config_hash)`.

### 4.7 Pass history & the Optimization Report

Every pass execution appends to `EIRManifest.pass_history[]` and emits a `PassReport` (nodes added/removed/merged, contradictions found/resolved, warnings). The concatenation of all `PassReport`s across a compilation becomes the human-facing **Optimization Report** (§11).

---

## 5. Experience Linker

### 5.1 Purpose

The Linker takes N independently compiled (or independently extracted, pre-optimization) EIRs and produces one composite EIR — the mechanism behind "Corporate Lawyer + Tax Expert + GDPR Expert → Enterprise Legal XO." Linking can happen at two points in the pipeline: **pre-optimization linking** (merge raw EIRs, then run the full pass pipeline once over the union — preferred when the experts overlap heavily, since shared canonicalization gives better duplicate elimination) or **post-optimization linking** (merge already-optimized, already-packaged-adjacent EIRs — preferred when the inputs are independently maintained, versioned XOs that shouldn't be re-optimized as a side effect of someone else's link).

### 5.2 Linking algorithm

```
1. Namespace     — tag every node in each input EIR with its origin_eir_id
                    to prevent accidental identity collisions during merge.
2. Concept Align — match Concept/Fact nodes across EIRs via the same
                    semantic-normalization machinery used in §4.2, producing
                    an alignment map (this expert's "material breach" =
                    that expert's "default event").
3. Union         — merge aligned nodes (provenance union, per §2.3);
                    keep unaligned nodes as-is.
4. Conflict Scan — run Contradiction Detection (§4.2) across the union;
                    this is where genuinely cross-expert disagreements
                    surface (Tax Expert says X is compliant, GDPR Expert
                    says X is not).
5. Precedence    — resolve conflicts using a declared Precedence Policy
                    (§5.3); anything unresolved is escalated to a human
                    reviewer and blocks promotion past Validation (§6).
6. Compose       — link Capability graphs via `composes_into` edges so
                    the resulting XO can express "for GDPR-relevant
                    clauses, defer to the GDPR Expert's RiskPolicy" as a
                    structural graph fact, not a prompt instruction.
7. Re-optimize   — run the full Pass Manager pipeline (§4) over the
                    composite EIR.
```

### 5.3 Precedence policy

A `PrecedencePolicy` is itself an artifact, not a hardcoded rule, so enterprise customers can supply their own:

```
PrecedencePolicy {
  policy_id
  rules[]  {
    scope               // which node kinds / domains this rule governs
    order                // ordered list of origin_eir_ids or authority tiers
    tie_breaker          // "highest_confidence" | "most_recent" | "escalate"
  }
  default_tie_breaker
}
```

Default platform policy is domain-authority-based (a GDPR-specialist EIR outranks a generalist EIR on data-protection nodes) with `escalate` as the ultimate fallback — the Linker never silently guesses on a genuine cross-domain conflict.

### 5.4 Shared concepts and dependency resolution

Because linking happens on the same typed graph as single-source compilation, "shared concepts" is not a special case — it's the normal behavior of Concept Alignment (step 2 above). Dependency resolution (§4.2) is re-run post-link specifically because linking can introduce `Capability` nodes whose `requires` edges now point across origin boundaries (a merged capability might require a `RiskPolicy` node that only existed in one of the input EIRs) — this must be verified before the composite is valid.

### 5.5 Capability composition

The output of linking is not a flat union of capabilities — Capability Clustering (§4.2) re-runs over the composite graph specifically to identify where two experts' capabilities should compose into a *new*, higher-order capability ("draft a GDPR-compliant vendor contract" as a composite of the Lawyer's contract-drafting capability and the GDPR Expert's compliance-checking capability) rather than simply sitting side by side as two independently invokable capabilities in the same package.

---

## 6. Validation Framework

### 6.1 Validation stages

Validation runs after linking (or directly after optimization, for single-source compilations) and before benchmark synthesis, as a series of independently gated checks — a compilation cannot proceed to packaging until every **blocking** stage passes:

| Stage | Checks | Blocking? |
|---|---|---|
| Completeness | Every declared `Capability` has a reachable reasoning path and no unresolved `requires` | Yes |
| Internal Consistency | Zero unresolved `contradicts` edges remain post-Conflict-Resolution | Yes |
| Knowledge Coverage | Capability's supporting evidence meets minimum breadth/depth thresholds for its declared confidence tier | Yes |
| Safety Policy Coverage | Every `Capability` has at least one reachable `SafetyPolicy`/`Constraint` node | Yes |
| Licensing | Every node's provenance resolves to a valid, non-conflicting license grant | Yes |
| Compatibility | EIR is expressible against at least one declared target model family's `consumes` set (per `SPECIFICATION.md` §1.2) | Yes |
| Reasoning Quality | Sampled `ReasoningStep` chains pass a structured-reasoning probe (logical validity, non-circularity) | No — warning |
| Hallucination Risk | Nodes with low provenance-source-count but high stated confidence are flagged for review | No — warning |
| Benchmark Readiness | Sufficient high-confidence capability coverage exists to synthesize a meaningful benchmark suite (§7) | Yes |

### 6.2 Validation as re-runnable, independent passes

Each validation stage is architected the same way as an optimization Analysis pass — pure function over EIR, deterministic, independently re-runnable — so that after a human resolves a blocking finding (e.g., supplies a missing license grant), the compiler re-runs only the affected validation stage rather than the entire pipeline.

### 6.3 Human-in-the-loop escalation

Any blocking finding that the compiler cannot auto-resolve (unresolved cross-expert contradiction, missing safety-policy path, ambiguous licensing) is emitted as a `ValidationFinding` with severity, affected node ids, and a suggested resolution action, and the compilation job pauses in a `blocked_on_review` state rather than either failing hard or silently guessing. This is the same posture as a compiler erroring out with a specific line number instead of emitting a binary that might crash at runtime.

---

## 7. Benchmark Synthesis

### 7.1 Why synthesis, not authoring

Requiring a human to hand-write a benchmark suite for every XO does not scale to an open ecosystem of arbitrary professions, and it re-introduces exactly the trust problem the marketplace's on-chain benchmark/challenge system (per `SPECIFICATION.md`) is designed to solve independently of any single seller's claims. Benchmark Synthesis instead derives test cases mechanically from the same EIR the XO is built from, so the benchmark is *provably* testing the capability that was actually compiled, not a generic proxy.

### 7.2 Generation strategy by evidence type

| EIR evidence available | Generated benchmark item type |
|---|---|
| `FailureCase` nodes | Regression items: "given this scenario, does the capability avoid the known failure?" |
| `SuccessPattern` nodes | Positive items: "given this scenario, does the capability reproduce the successful approach?" |
| `DecisionNode` branches | Coverage items, one per branch, verifying correct branch selection |
| `Heuristic` exception_conditions | Edge-case items specifically targeting the exception, not just the general rule |
| Cross-`Capability` `composes_into` edges | Integration items testing composite behavior |
| `EscalationRule` nodes | Escalation-fidelity items: does the capability correctly defer instead of answering? |
| `contradicts` edges resolved during linking (§5) | Conflict-boundary items probing the precedence decision specifically |
| Domain ontology (`Concept` graph) | Knowledge-recall items for coverage breadth |

### 7.3 Benchmark categories produced

Matching the required evaluation dimensions, each synthesized suite is partitioned into: **Knowledge** (recall/precision against the Concept graph), **Reasoning** (does the capability's chain-of-justification match the ReasoningStep structure, not just the final answer), **Consistency** (repeated-query stability), **Safety** (adversarial probes against every `SafetyPolicy`/`Constraint`), **Domain Coverage** (breadth across all Capability clusters, weighted by evidence density), **Edge Cases** (from exception_conditions and FailureCases specifically), and **Explainability** (can the capability's output be traced back to specific EIR nodes and, transitively, specific provenance records — this category is uniquely possible because of the provenance discipline in §2.3).

### 7.4 Output

The synthesized suite is emitted directly in the shape the marketplace already expects (`evaluation/benchmark_suite.json`), with every generated item cross-referencing the EIR node id(s) it was derived from — this reference is what lets the runtime's own benchmark-refresh cycle and the marketplace's challenge system re-derive *why* a given benchmark item exists, rather than treating it as an opaque test.

---

## 8. Compilation Lifecycle

### 8.1 End-to-end job

```
1. Job submitted             (source manifest + target profile + precedence
                               policy, if linking)
2. Ingestion                 (§2.1-2.3, parallel per source)
3. Extraction                (§2.4-2.5, parallel per extractor)
4. EIR Build                 (candidates → typed graph, §3)
5. Optimization               (Pass Manager, staged fixpoint, §4.3)
6. Linking                    (if multiple EIRs targeted, §5)
7. Validation                 (§6) ──► blocked_on_review? ──► human resolves ──┐
                                                                                 │
8. Benchmark Synthesis         (§7)                        ◄────────────────────┘
9. Packaging                   (§9)
10. Signing & Publish           (to Package Store / marketplace)
```

### 8.2 Incremental compilation

Because every stage is content-addressed and every pass is deterministic (§4.6), adding one new source to an already-compiled XO does not require re-running the full pipeline. The Compiler Driver diffs the new `SourceManifest` set against the prior compilation's `EIRManifest.source_manifest_refs`, re-runs Ingestion/Extraction only for new/changed sources, re-runs the Canonicalization Group of passes (since new evidence can introduce new duplicates/contradictions against *existing* EIR, not just within the new material), and re-runs only the validation stages whose inputs changed. This incremental model is what makes the Self-Improvement / Learning Loop (§10) economically viable at scale — a single enterprise correction shouldn't force a full recompile of a multi-source XO.

---

## 9. Packaging (Back End)

### 9.1 Responsibilities

The Packager is the only stage in the compiler that has any knowledge of the XO package format defined in `SPECIFICATION.md`. Its job is a pure **lowering**: read the validated, optimized (and, if applicable, linked) EIR and the target's `compatibility.model_families[].consumes` requirements, and emit each required package component:

| XO package component | Derived from EIR via |
|---|---|
| `manifest.json` | EIRManifest + target compatibility declaration |
| `metadata.json` | Capability cluster summaries + profession_tags |
| `knowledge/graph.json` | Knowledge Graph view (§3.4) |
| `memory/long_term_graph.json` | MemoryUnit nodes |
| `reasoning/decision_trees.json` | Decision Graph view |
| `reasoning/reasoning_traces.jsonl` | Reasoning Graph view, flattened per Capability |
| `reasoning/case_library.json` | FailureCase / SuccessPattern nodes |
| `prompting/strategies.json` | Output of the Prompt Optimization pass (§4.2) |
| `weights/lora/`, `weights/finetune/` | Only emitted for target families whose `consumes` includes them — routes through a model-family-specific fine-tuning pipeline that is itself pluggable (§12) |
| `evaluation/benchmark_suite.json` | Benchmark Synthesizer output (§7) |
| `safety/rules.json` | SafetyPolicy / Constraint nodes |
| `licensing/license.json` | Aggregated provenance licensing_refs |
| `provenance/contributors.json`, `version_history.json` | Provenance Ledger (§2.3, cross-cut) |
| `signatures/signatures.json` | Compiler signing key + per-component hashes |

### 9.2 Capability Index generation

Because §4.2's Capability Clustering pass has already produced coherent, named Capability nodes, generating the manifest's capability-facing index is a direct projection rather than a re-analysis — this is the clearest example of why doing real work in the middle end (EIR) rather than deferring structure to the back end matters: the Packager never has to *discover* structure, only *format* structure that optimization already established.

### 9.3 Multi-target packaging from one EIR

A single validated EIR can be packaged multiple times against different target profiles (e.g., a "full" package for enterprise deployment vs. a size-constrained package for an edge deployment, using the output of the Compression for Deployment pass, §4.2) without re-running extraction, optimization, linking, or validation — only packaging re-runs, keyed on target profile. This is the direct analog of one LLVM IR module being lowered to multiple target architectures.

### 9.4 Signing

The Packager computes the Merkle root exactly as `SPECIFICATION.md` §1.1-1.2 requires and signs it with the compiler's own attestation key in addition to any creator/co-signer keys, producing a verifiable claim of the form "this package's contents were produced by compiler version X from EIR with hash Y, and EIR Y passed Validation policy Z" — this attestation is what lets the marketplace's trust system distinguish "compiled by the canonical pipeline" from "hand-assembled to mimic the format," which matters once other companies build their own front ends or their own alternative compilers targeting the same EIR/XO ecosystem (§13).

---

## 10. Self-Improvement Loop

### 10.1 Feedback sources

The compiler does not stop being useful once an XO ships. It subscribes to structured feedback events:

| Source | Signal | Compiler action |
|---|---|---|
| Runtime (per `RUNTIME_ARCHITECTURE.md` §12 Learning Engine) | Which capabilities/reasoning traces were actually used, and outcome signals | New `MemoryUnit`/evidence candidates fed back into the owning EIR |
| Benchmark results (initial and re-runs) | Failing benchmark items | Routed to the relevant `Capability` subgraph as a `FailureCase` candidate for the *next* compilation |
| Marketplace challenges | A challenger's counter-evidence | Treated as a new, adversarial-tagged source through the normal ingestion path — challenge evidence never bypasses provenance or validation |
| User/enterprise ratings | Aggregate satisfaction signal, correlated to specific capability usage | Weighted input to confidence recalibration (§3.6) on next incremental compile |
| Enterprise deployment corrections | Explicit expert corrections to XO output | Highest-trust evidence tier; ingested via the Correction History adapter (§2.2) |

### 10.2 Compiler self-improvement vs. XO self-improvement

Two distinct improvement loops exist and must not be conflated: **XO-level** improvement (§10.1's evidence gets folded into a specific XO's EIR via incremental recompilation, §8.2) and **compiler-level** improvement (aggregate patterns across *many* compilations reveal that a pass is systematically under- or over-triggering, or that a new pass is warranted — e.g., discovering that "escalation rule" extraction is under-firing across every legal-profession XO suggests improving the Escalation & Exception Extractor itself, not any single XO). Compiler-level improvement changes the compiler's own version and pass catalog and is subject to its own regression-benchmark suite (the compiler benchmarks itself against a held-out corpus of past compilations to ensure new passes don't regress prior output quality) before rollout — mirroring how a real optimizing compiler validates new optimization passes against a benchmark corpus before merging them.

---

## 11. Observability

### 11.1 Per-compilation artifacts

Every compilation job produces the full required artifact set as structured, machine-readable documents (not just logs):

| Artifact | Contents |
|---|---|
| Compilation Graph | The DAG of stage invocations actually executed for this job, with timing and cache-hit status per stage |
| Optimization Report | Concatenated `PassReport`s (§4.7): nodes merged/removed/added per pass, contradictions found/resolved |
| Coverage Report | Knowledge/reasoning coverage per Capability cluster against declared scope |
| Capability Report | Final Capability Index with confidence, evidence density, and benchmark pass rate per capability |
| Knowledge Statistics | Node/edge counts by kind, source diversity per Capability |
| Compression Ratio | Raw ingested artifact volume vs. final packaged size, per target profile |
| Quality Metrics | Aggregate confidence distribution, benchmark pass rates by category (§7.3) |
| Warnings | Non-blocking Validation findings (§6.1) |
| Errors | Blocking findings, with the specific EIR nodes and stage responsible |
| Security Findings | Licensing conflicts, provenance gaps, signature verification issues |
| Provenance Report | Full contributor/source attribution rollup, ready to drive royalty computation |
| Compiler Trace | Structured, replayable log of every pass invocation, input/output EIR hash, and configuration — sufficient to exactly reproduce the compilation |

### 11.2 Tracing model

Every stage invocation emits a span tagged with `job_id`, `stage`, `input_hash`, `output_hash`, `duration`, and `cache_hit`, feeding the same class of streaming Observability Collector the runtime uses (`RUNTIME_ARCHITECTURE.md` §14) — this is a deliberate shared-infrastructure choice so operators get one observability plane across both compiler and runtime, not two.

---

## 12. Extensibility Architecture

### 12.1 Plugin surfaces

Three independent extension points, matching the three-layer model in §0:

| Surface | Extends | Contract |
|---|---|---|
| Source Adapter Plugin | Front end | `discover`/`extract`/`provenance` (§2.1) |
| Optimization Pass Plugin | Middle end | `Pass` interface (§4.1), declared `requires_passes`/`invalidates_passes` |
| Target Lowering Plugin | Back end | Reads EIR + target profile, emits one or more package components (§9.1) |

### 12.2 Third-party compilers targeting EIR

Because EIR is specified independently of this compiler's own implementation (§3, spec-versioned per §3.5), the architecture explicitly supports other organizations building alternative front ends — or entire alternative compilers — that target EIR, exactly as Rust, Swift, and Julia all target LLVM IR independently of any single vendor. The platform's role in that scenario narrows to: publishing the EIR spec, running the canonical Validator and Benchmark Synthesizer as a trust-anchoring service any EIR can be submitted to, and operating the canonical Packager for the public XO format — while still allowing enterprises to run compliant private compilers end-to-end for internal-only XOs that never touch the public marketplace.

### 12.3 Governance of the pass catalog

Core passes (§4.2) are versioned and change-controlled the way a language's standard library is; profession-specific passes (§4.5) and third-party front ends are namespaced and cannot silently override core pass behavior — the Pass Manager refuses to schedule a pass that claims to `invalidate` a core Analysis pass without an explicit compatibility declaration, preventing an untrusted plugin from quietly corrupting confidence propagation or contradiction detection for everyone.

---

## 13. Security Architecture

### 13.1 Threat surface specific to a compiler

Beyond standard service security, a capability compiler has distinct risks: (a) **evidence poisoning** — malicious or low-quality sources engineered to bias a compiled capability (e.g., a planted "expert correction" that actually degrades quality); (b) **provenance forgery** — falsely claiming authorship/licensing over ingested material to capture royalty share; (c) **pass injection** — a malicious third-party pass plugin (§12.1) designed to exfiltrate EIR content or silently corrupt safety-relevant nodes; (d) **benchmark gaming** — evidence engineered specifically to make the *synthesized* benchmark suite easy rather than representative.

### 13.2 Mitigations

| Threat | Mitigation |
|---|---|
| Evidence poisoning | Confidence propagation (§3.6) weights low-provenance-diversity evidence down automatically; Implicit Knowledge candidates (§2.5) and any single-source high-impact claim route through Validation's human-review path rather than auto-promoting |
| Provenance forgery | Ownership claims are checked against the Licensing Ledger's existing grants at ingestion time (§2.3); conflicting claims block that source at Validation (§6.1) rather than silently picking one |
| Pass injection | Plugin passes run sandboxed with read access to EIR and write access only to a scoped output diff the Pass Manager applies and re-validates, never direct in-place graph mutation; core safety-relevant node kinds (`SafetyPolicy`, `Constraint`) require a core-pass signature to modify |
| Benchmark gaming | Benchmark Synthesis draws from the same EIR the capability is built from (§7.1) by construction, and the marketplace's independent, post-hoc challenge/benchmark system (external to this compiler) re-tests the shipped XO against separately maintained probes, so a gamed internal benchmark doesn't survive external challenge |

### 13.3 Compilation attestation

As established in §9.4, every package carries a compiler attestation. Attestations are themselves signed and independently auditable, so a dispute over "did this XO actually come from validated EIR" is resolvable without re-trusting the seller.

---

## 14. Scalability Strategy

The architecture separates concerns exactly along the lines that scale independently in practice: ingestion/extraction is embarrassingly parallel per source and the natural place to burst GPU capacity for audio/video (§1.2); optimization passes are parallelizable within a fixpoint group wherever passes don't share a mutation target, and memoizable via the deterministic-pass property (§4.6) so re-compiling with one new source doesn't re-pay for canonicalization work already done (§8.2); linking is bounded by the number of experts being combined, not by any individual EIR's size, so it scales horizontally across link jobs; validation and benchmark synthesis are the most compute-intensive middle-end stages (LLM-assisted probes) and are architected as stateless workers that scale on job queue depth. The EIR store itself — the one genuinely stateful, hard-to-shard component — is partitioned per `eir_id`, which is sufficient because cross-EIR access only happens explicitly during linking (§5), never during normal single-source compilation.

---

## 15. Storage Model

| Store | Contents | Access pattern |
|---|---|---|
| Source Store | Raw ingested bytes, content-addressed | Write-once, read during extraction/audit |
| Provenance Ledger | Append-only ProvenanceRecord log | Write-heavy, range-queried for royalty/audit |
| EIR Store | The property graph itself, versioned, content-addressed per node | Read/write-heavy during compilation, read-only after |
| Job Store | Compilation Driver state, DAG execution state | Transactional, short-lived hot state |
| Licensing Ledger | Ownership/license grants referenced by provenance | Read-heavy, low write rate |
| Pass Cache | Memoized `(pass_id, version, input_hash, config_hash) → output_hash` | High-read, TTL-managed |
| Package Store | Finished `.xo` artifacts, shared with the marketplace/runtime | Content-addressed, CDN-fronted |

---

## 16. Extensibility Roadmap / Future Passes

Anticipated next-generation passes, sequenced by dependency on infrastructure already specified above: **Cross-XO Contradiction Detection** (compare a new compilation's claims against *already-published* sibling XOs in the same profession, not just within one EIR — requires a cross-EIR index built on top of §15's EIR Store); **Active Evidence Solicitation** (the Validator, instead of only flagging low-coverage Capability clusters, generates a targeted request for specific missing evidence and routes it to a human expert — turning §6's Validation from purely reactive to proactive); **Multi-Modal Reasoning Fusion** (a dedicated pass for aligning reasoning chains extracted from screen-recording action traces with reasoning chains extracted from the expert's simultaneous verbal narration, currently handled as two independent extractor outputs per §2.4); **Automated Precedence Learning** (learn `PrecedencePolicy` weights, §5.3, from historical conflict-resolution outcomes and challenge results rather than requiring them fully hand-authored); **Differential Recompilation Diffing** (produce a human-readable "what changed and why" report between two versions of the same XO's EIR, extending the Optimization Report, §11.1, into a version-comparison artifact).

---

## 17. Summary: What Makes This a Compiler and Not a Pipeline

A pipeline moves data through fixed stages and calls it done. This is a compiler because it has the properties that actually earn that name: a real intermediate representation that is independently specified, versioned, and target-agnostic (§3); a set of composable, reorderable, cacheable, independently-authored optimization passes operating on that IR rather than on raw source (§4); a linker that merges IR-level units rather than post-hoc string-concatenating outputs (§5); a validation framework that reasons about IR-level properties like reachability and contradiction rather than surface-level plausibility (§6); and a back end that lowers one IR to multiple targets without re-deriving structure each time (§9). The professional expertise of a corporate lawyer and the professional expertise of a radiologist are, at the EIR level, the same kind of object — nodes, edges, confidence, provenance — compiled by exactly the same middle end, which is the entire point: this is infrastructure for *any* profession, built once.
