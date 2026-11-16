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

Settled under owner delegation in [ADR 0030](../adr/0030-pre-execution-launch-completion.md):

1. **Allowed READY_WITH_CONDITIONS conditions:** exactly two, both bounded: an unstated step order the owner accepts,
   and a waived source-quality finding.
2. **Certificate default:** required in production (`XO_READINESS_CERTIFICATE=required`); Studio obtains it.
3. **Scope ambiguity margin:** 15%, kept, and validated against labelled goal-selection cases.
4. **Benchmark thresholds:** each real-document threshold has a ratified non-regression floor at the measured value
   that gates every evaluation run; the 90 / 90 / 0 targets stay proposals until a fresh blind set meets them.

## Known limits, stated plainly

- **The real-document targets are not met yet** (blind 114/143 read right, 114/168 output precise, 7 silent losses).
  Regressions are gated; reaching the targets is measurement work on a fresh blind set.
- **A local certificate (CLI) is never READY.** Approval is a workspace decision, and the CLI has no workspace. With
  `--connectors`, the CLI takes the adapters the file names as present; a workspace checks they are installed.
- **Workspace-dependent digests legitimately differ by surface.** The inventory digest and the authorization gate
  depend on the workspace's approvals. The conformance suite compares every digest that does not depend on them.
- **Connector side effects come from the operator, not the sources.** An operation with no binding is reported and
  blocks; generation never guesses a destination or an effect.

## Where to read more

- `docs/adr/0029-pre-execution-pipeline.md`: the decisions.
- `PRE_EXECUTION_ARCHITECTURE.md`, `PRE_EXECUTION_GAP_REGISTER.md`, `PRE_EXECUTION_IMPLEMENTATION_PLAN.md`.
- `BUSINESS_KNOWLEDGE_BASE.md`, `CAPABILITY_INVENTORY.md`, `WORKFLOW_GENERATION.md`, `READINESS_CERTIFICATE.md`.
- `DEVELOPER_GUIDE.md`: how to extend the pipeline.
