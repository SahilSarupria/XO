# Pre-execution pipeline hardening: report

This report covers "XO Pre-Execution Pipeline Hardening 1.0", delivered as nine stacked PRs from PX-0 to PX-8. The pipeline
runs from a source arriving to a workflow being allowed to start, and it is now one source-independent path. Every
surface (API, CLI, Studio) uses the same functions and gets the same digests. A workflow starts only against a
certificate that the start gate recomputes and verifies.

Of the 28 gaps recorded in `PRE_EXECUTION_GAP_REGISTER.md`, 27 are **verified** with test evidence. PX-G28 (benchmark
thresholds as a gate) is **deferred**, because the owner has to ratify it. No runtime execution semantics changed, and the
frozen roadmaps (`specs/`, `docs/ROADMAP.md`) were not edited.

## What was built, stage by stage

| PR      | Stage                                 | Gaps                                | What it delivers                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #21     | PX-0 recon                            | —                                   | ADR 0029 (17 decisions), the as-built architecture, the gap register, and the implementation plan.                                                                                                                                                                                                                                         |
| #22     | PX-1 source registration and artifact | G01–G08, G11, G14                   | `@xo/pre-execution`: content checks for every format (signature, archive limits, inflated-size lies); content-addressed source sets; `CompileConfiguration` with a digest; one `compileSourceSet`; a complete `CompilationArtifact` that the API persists, with a digest that matches between the API and the CLI.                         |
| #23     | PX-2 quality and waivers              | G09, G10                            | One `SourceQualityState`. A source that is partial, degraded or blocked needs a recorded `SourceWaiver`, bound to the source version, its findings, the scope, the actor and a reason. This is enforced at approval.                                                                                                                       |
| #24     | PX-3 completeness and rulings         | G12, G13                            | Completeness is reported separately from validity. Structured `HumanRuling` records are attributed, audited and bound to the source set, and become stale when the item they rule on changes. A confirm-rule ruling compiles in as a confirmed rule on every surface.                                                                      |
| #25     | PX-4 Business Knowledge Base          | G15, G16                            | `@xo/knowledge-base` (no dependencies): governed change sets, immutable states identified by digest, conflicts that are kept, entity resolution with no automatic merge, BM25 search pinned to a state, a hash-chained store per tenant, Domain Knowledge Packs, and the XOIR adapter. API, CLI and `XoManifest.domainPacks` are included. |
| #26     | PX-5 capability inventory             | G17–G20                             | One human-task contract rule, shared by procedure steps and prose actions. An inventory with seven statuses, four independent readiness answers, duplicate groups, gaps and parameter derivation.                                                                                                                                          |
| #27     | PX-6 goal to Workflow IR              | G21–G23                             | A typed goal and explainable scope selection that asks instead of guessing. One lowering function to Workflow IR (`approve` for human tasks, gated on the previous confirmation; `decide` with rendered rules). Generated workflows are persisted with their digest.                                                                       |
| #28     | PX-7 readiness certificate            | G24, G25                            | `WorkflowReadinessCertificate`: seven gates, four statuses, and digest bindings for every input. A start gate that verifies the certificate against freshly recomputed state. A workspace setting to require it. The sign-off binds to each step's contract hash.                                                                          |
| this PR | PX-8 cross-surface and report         | G26, G27 (and closes G02, G07, G09) | The Studio pre-start check, the API/CLI conformance suite, security tests, this report, and the developer guide.                                                                                                                                                                                                                           |

## The path, end to end

1. **Register.** Content is checked against its declared format. Archives are bounded. The source version is identified
   by the SHA-256 of its bytes, and a source set by its members.
2. **Compile.** One configuration type with its own digest feeds one entry point. The artifact carries everything the
   compiler produced and is persisted with a digest.
3. **Assess.** Source quality comes with waivers. Completeness comes with rulings. Validity is reported separately.
4. **Know.** Compiled knowledge is proposed to the Business Knowledge Base, never applied directly. A reviewer approves
   it into a new immutable state.
5. **Inventory.** Every capability gets a status and four independent answers. A step runs as a human task only under
   its human-task contract.
6. **Generate.** A goal selects a workflow, or asks which one is meant. The workflow is lowered to Workflow IR and
   validated, then persisted with its digest.
7. **Certify.** Seven gates decide READY, READY_WITH_CONDITIONS, NEEDS_REVIEW or BLOCKED. The certificate binds the digest
   of every input.
8. **Start.** The gate recomputes every binding. A stale, tampered or not-ready certificate is refused with its reasons.
   Permission is rechecked live for every step.

## Evidence

- **Full verification on every PR:**
  - build
  - every node test suite (6,736 at PX-7)
  - Studio Vitest (744 at PX-8; 6,741 node tests)
  - lint, Prettier and typecheck
  - `npm run eval -- --check`
- **False-ready corpus** (`pre-execution/test/readiness.test.ts`). None of these ever produces READY:
  - a step that is not approved
  - an open conflict
  - an unmet need
  - an unbound step
  - a blocked source
  - a knowledge conflict
  - a goal that is still asking a question
  - a circular order
  - an unstated order that was not accepted
- **Staleness** (`readiness.test.ts`, `api/test/readiness-certificate.test.ts`). Each of these makes the certificate stale,
  and the reason names it:
  - inventory, workflow definition, knowledge state, goal, waivers and rulings, and a single contract
  - on the API, approving knowledge after certification refuses the start
- **Cross-surface conformance** (`cli/test/pre-execution-conformance.test.ts`). For four fixtures, the API and the CLI
  produce identical:
  - source set and artifact
  - graph and goal
  - step contracts
  - Workflow IR and its digest
- **Security** (`api/test/pre-execution-security.test.ts`, `knowledge-base/test`):
  - workspace isolation for generated workflows, certificates, inventory and knowledge
  - a certificate altered on disk is refused at start
  - template placeholders in source text never reach Workflow IR
  - malformed and traversal ids are refused
  - each tenant's knowledge store refuses another tenant's records
  - the event log is tamper-evident
- **Benchmarks.** One controlled change, recorded in `packages/benchmark/CHANGELOG.md` (PX-5). Fifteen procedure steps
  now resolve as human tasks, and two procedure workflows became executable candidates. The five steps linked to rules
  stay unresolved. No accepted baseline moved.

## Decisions that are the owner's

ADR 0029 decision 17 lists these. Until the owner ratifies them, the conservative behaviour applies.

1. **Allowed READY_WITH_CONDITIONS conditions.** Today there is exactly one: an unstated step order the owner accepts.
   Everything else needs review or blocks.
2. **`trust.requireReadinessCertificate` default.** It is off, so existing starts are unchanged. Turn it on per
   workspace to make the certificate mandatory. A future default of on is a one-line change.
3. **Scope-selection ambiguity margin.** It is 15% (`SCOPE_AMBIGUITY_MARGIN`).
4. **Benchmark thresholds as a gate** (PX-G28). These stay proposals in `evaluation/thresholds.json`.

## Known limits, stated plainly

- **Workflow generation emits `approve` and `decide` only.** It does not emit `act`, `branch`, `wait`, `compensate`,
  `for_each` or `extract`. Those need facts the sources do not state, such as connector operations, side effects, waits
  and undo steps. `GENERATION_CONSTRUCTS` records why for each one. Such steps are reported as blocking and never
  invented.
- **A local certificate (CLI) is never READY.** Approval is a workspace decision, and the CLI has no workspace.
- **Workspace-dependent digests legitimately differ by surface.** The inventory digest and the authorization gate
  depend on the workspace's approvals. The conformance suite compares every digest that does not depend on them.
- **Generated workflows run through the existing workflow runner, which executes the composed candidate.** The Workflow
  IR is the canonical definition the certificate binds. Running the IR itself through `@xo/workflow-runtime` is outside
  this scope, because decision 12 keeps the existing runtime bridge as the execution adapter.
- **The knowledge base stores plain files** (decision 16). A database adapter can implement `KnowledgeStore` behind the
  same interface.

## Where to read more

- `docs/adr/0029-pre-execution-pipeline.md`: the decisions.
- `PRE_EXECUTION_ARCHITECTURE.md`, `PRE_EXECUTION_GAP_REGISTER.md`, `PRE_EXECUTION_IMPLEMENTATION_PLAN.md`.
- `BUSINESS_KNOWLEDGE_BASE.md`, `CAPABILITY_INVENTORY.md`, `WORKFLOW_GENERATION.md`, `READINESS_CERTIFICATE.md`.
- `DEVELOPER_GUIDE.md`: how to extend the pipeline.
