# 0029: One pre-execution pipeline, a governed Business Knowledge Base, and a digest-bound readiness certificate

## Status

Accepted under owner delegation, 2026-11-15 (pre-execution program, PX-0). The owner gave Claude authority to make design decisions that make the product better, more accurate and easier to use. This is a delegated sign-off, not an independent review. Items marked **owner ratification** are decided provisionally and stay conservative until the owner ratifies them.

## Context

The owner's _XO Pre-Execution Pipeline Hardening_ specification (1.0, 14 November 2026) asks for one source-independent path from a source to an authoritative readiness decision, just before a workflow starts. It includes a persistent, governed Business Knowledge Base (BKB).

Reconnaissance at `4a9837b` (`docs/pre-execution/PRE_EXECUTION_ARCHITECTURE.md`) found the following:

- **Sources.** No magic-byte check at upload. No source versions or source sets.
- **Compilation.** API compilation persists only part of the compiler result.
- **Quality waivers.** A partial-source waiver is documented but enforced nowhere.
- **Workflows.** There are three workflow representations, and none lowers to another.
- **Manual steps.** Manual steps and prose actions resolve differently.
- **Knowledge.** There is no persistent organizational knowledge store.
- **Start.** There is no readiness artifact; start checks approvals and permissions only.

This ADR records the seventeen design decisions the specification (§12) requires before implementation reaches each area.

## Decisions

1. **Source-set identity and version model.**
   - A _source version_ is identified by the SHA-256 of its bytes. A _source record_ (an upload event) keeps its own id, origin, uploader and time. Two uploads of identical bytes are two records that share one version.
   - A _source set_ is an ordered list of `{sourceId, digestSha256, role}` entries. Its id is `ss_` plus the first 24 hex characters of the SHA-256 of the canonical JSON of that list.
   - A compilation names the source set it ran on, and can be reproduced from it.
   - No upload is deduplicated away; deduplication is by version only.
2. **Parser adapter result and quality vocabulary.**
   - The compiler's existing `SourceCompilationReport` is the adapter result. It carries detected format, `qualityState`, `coverage`, `recovery`, `sourceClass` and `kindProposals`.
   - Each report gains `parserVersion` (`<frontend>@<version>`).
   - The quality vocabulary is the existing `SourceQualityState`: `trusted | degraded | partial | blocked`. No second enum is introduced.
3. **Content validation and format matrix.**
   - Every upload is classified by content (signature or magic bytes, or a text sniff) and refused with a structured code when the content contradicts the extension. The codes are `SOURCE_SIGNATURE_MISMATCH`, `SOURCE_EMPTY`, `SOURCE_UNSUPPORTED`, `SOURCE_TOO_LARGE` and `SOURCE_ARCHIVE_UNSAFE`.
   - The supported-format matrix is published in `docs/INGESTION.md`, with one support statement per format.
   - The CLI's zip reading gets the same bomb limits as the API.
4. **Semantic assertion, evidence and provenance schema.**
   - XOIR nodes stay the semantic interchange (ADR 0001 line).
   - Evidence is the existing `sourceRefs` (document path, pages, section, character range), extended in the BKB with `sourceDigestSha256` and an extraction method and version.
   - A BKB claim records its derivation as one of `source | model | human | system`.
5. **Entity identity, aliasing and ambiguity.**
   - Entities are tenant-scoped. An exact strong identifier (a declared scheme) links deterministically. A name or alias match only proposes a candidate.
   - When there are two or more candidates, or no exact identifier, the entity stays `unresolved`, and dependent readiness becomes `NEEDS_REVIEW`.
   - Merges and splits are events with lineage. They are never deletions.
6. **Conflicts, precedence and rulings.**
   - Competing claims are both stored. A conflict is a first-class record.
   - A conflict is resolved only by a declared precedence policy (versioned) or by a human ruling. A ruling is actor-attributed, timestamped, evidence-linked and bound to the digests of the claims it rules on.
7. **XOIR validity vs completeness.**
   - _Validity_ means the structural, semantic and integrity checks pass.
   - _Completeness_ is a separate assessment: unclassified sentences, uncovered sentences, unresolved review items, and source coverage below full.
   - A valid graph can be incomplete, and the certificate reports the two separately.
8. **Capability candidate lifecycle and deduplication.**
   - Status is one of `explicit | inferred | accepted | rejected | duplicate | unresolved | unsupported`.
   - Two candidates are duplicates only when their name, inputs, outputs, rules and source evidence are equivalent after normalisation. Candidates that differ in any of these stay distinct.
9. **Canonical contract and schema dialect.**
   - `SemanticCapabilityContract` (`@xo/capability-contract`) stays canonical.
   - Typed input/output schemas use the JSON Schema subset already validated by `validateCapabilityInput`. A construct outside that subset is reported, never weakened.
10. **Execution strategy vocabulary.**
    - The strategies are `deterministic_rule | human_in_the_loop | model | hybrid | external_tool`, as in `CapabilityExecutionDeclaration`.
    - Each capability report keeps four independent answers: _eligible_ (the declaration permits the strategy), _bound_ (a binding resolved), _runtime-supported_ (the runtime has an executor for it), and _authorized_ (permission is currently granted). Only all four together make a step runnable.
11. **Manual / human-in-the-loop policy.**
    - A step runs as human-in-the-loop only under an explicit _human task contract_: required inputs, an actor role, an outcome schema, and evidence of the instruction. The contract can be derived from a procedure step, which carries its own instruction text and done-when.
    - A prose capability with linked action knowledge gets the same contract.
    - With no contract, a step stays `unresolved`. One rule covers both paths, closing the UW-3b inconsistency.
12. **Canonical workflow generation path.**
    - Workflow IR (`@xo/workflow-ir`) is the canonical definition.
    - `CandidateWorkflow` (composer) is lowered to Workflow IR by one function, and the API, CLI and Studio consume that.
    - The existing runtime bridge remains the execution adapter and is out of scope.
13. **Static validation for loops, parallel branches, waits, compensation and connector declarations.**
    - These use the existing `validateWorkflowComponent`, extended where the composer can emit the construct.
    - A construct the runtime cannot yet execute is reported as `definition valid / runtime unsupported`, which blocks readiness.
14. **Readiness statuses.**
    - The statuses are `READY | READY_WITH_CONDITIONS | NEEDS_REVIEW | BLOCKED`.
    - `READY_WITH_CONDITIONS` is allowed only for _declared, bounded_ conditions that do not bypass mandatory policy: an unresolved ambiguous-precedence tie-break the owner has accepted, or a warning-level coverage gap with a recorded waiver. Mandatory gates never degrade to conditions.
    - **Owner ratification:** the set of allowed conditions.
15. **Digest composition and invalidation.**
    - A certificate binds the digests of the following: the source set, the XOIR graph (existing deterministic hash), the knowledge state, the capability inventory, each contract (`computeContractContentHash`), the workflow definition (canonical JSON SHA-256), the goal, and the readiness policy version.
    - Its own digest is the SHA-256 of its canonical JSON with the digest field omitted.
    - Any bound digest that differs at start makes the certificate stale, and start refuses.
16. **Sharing orchestration without cycles.**
    - A new package, `@xo/pre-execution`, depends on `compiler`, `capability-contract`, `workflow-composer`, `workflow-ir`, `xoir`, `crypto` and the new `@xo/knowledge-base`.
    - The API and CLI depend on it. Studio reaches it only through the API.
    - `@xo/knowledge-base` depends only on `types`, `errors` and `crypto`, and its XOIR adapter takes a structural view of a graph, so `xoir` stays below it.
17. **Thresholds that need owner ratification.**
    - These are: every numeric quality, confidence and benchmark threshold (`evaluation/thresholds.json`), the readiness confidence floor, and the set of allowed `READY_WITH_CONDITIONS` conditions.
    - Until the owner ratifies them, the conservative behaviour applies: a partial or degraded source is `BLOCKED` without a waiver, and steps below the confidence floor are `NEEDS_REVIEW`.

## Consequences

- The work is delivered as stacked pull requests `px-1` … `px-8`, in the specification's dependency order (`docs/pre-execution/PRE_EXECUTION_IMPLEMENTATION_PLAN.md`).
- The frozen roadmaps (`specs/`, `docs/ROADMAP.md`) are not edited.
- Runtime execution semantics are not changed. The only runtime-boundary change is that the API start route verifies the certificate and rechecks permission.
