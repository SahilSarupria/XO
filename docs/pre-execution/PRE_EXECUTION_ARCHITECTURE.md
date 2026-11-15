# Pre-execution pipeline: as-built architecture

This document records what the code did at commit `4a9837b` (branch `uw-3c/real-document-hardening`), established by reading the code. It then gives the target shape, decided in ADR 0029. Each pre-execution pull request updates the "Target" column as that stage lands.

## 1. Stages and where they live

| Stage                       | As built (`4a9837b`)                                                                                                                                                                                                                                                                                                                                                                                  | Target (ADR 0029)                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source acquisition          | API `routes/source-routes.ts` (`registerSourceRoutes` L111, shared write path `storeSource` L140–279): upload, URL import (`sources/safe-fetch.ts`), resumable uploads (`sources/upload-sessions.ts`), email attachments (`sources/email-attachments.ts`). CLI `commands/compiler/source-collection.ts` (`collectSources`, zip via adm-zip). Record `SourceRecord` (`sources/source.ts` L13–68).      | One registration contract with a content signature check and structured codes. Source versions by digest; source-set manifests. CLI archives held to the API's bomb limits. |
| Parsing and extraction      | `@xo/compiler` frontends (`sources/*-frontend.ts`). Structured readers for Markdown, HTML and Word (ADR 0028). PDF layout (`document/*`). OCR tiers (`extraction/*`, API `compilations/extraction-tiers.ts`).                                                                                                                                                                                         | Unchanged mechanisms, plus a `parserVersion` on each source report.                                                                                                         |
| Source quality and coverage | `document/document-quality.ts` (`SourceQualityState` L27, computed L127–134). Copied without importing into `xoir/src/manifest.ts` L59–75. Enforced only inside the compiler (a `blocked` source gets no semantic extraction).                                                                                                                                                                        | A typed waiver record, digest-bound. Enforced at approval and at start, through the readiness certificate.                                                                  |
| Semantic extraction         | `compileSources` (`pipeline/compile-sources.ts`): knowledge, reasoning, capabilities, policy, coverage, review queue, cross-document conflicts, execution readiness.                                                                                                                                                                                                                                  | A complete compile result persisted and exposed. An unresolved ledger; human rulings.                                                                                       |
| XOIR                        | `compileXoir` (`pipeline/compile.ts`): convert, structural validation, semantic validation, normalize. Deterministic hashing (UW-1).                                                                                                                                                                                                                                                                  | Validity and completeness reported separately (ADR 0029 decision 7).                                                                                                        |
| BKB                         | None. The nearest is `packages/environment-intelligence/src/knowledge/` (claims, conflicts, identifier-based entity keys, for discovered environments).                                                                                                                                                                                                                                               | New `@xo/knowledge-base`: a domain-agnostic core, domain packs, a tenant store, change sets, snapshots, and an XOIR adapter.                                                |
| Capability discovery        | `discoverAndResolveCapabilities` (compiler) and `capability-contract` builders.                                                                                                                                                                                                                                                                                                                       | An inventory with lifecycle status, duplicates, gaps and coverage.                                                                                                          |
| Contracts and binding       | `SemanticCapabilityContract` (`capability-contract/src/types.ts` L128–163). Resolvers: `StructuredComparisonBindingResolver`, `ActionEscalationBindingResolver` (`standard-resolvers.ts`). Execution class in `workflow-composer/src/audit.ts` `auditStep` L43–197. Compiler readiness `pipeline/execution-readiness.ts` marks every discovered capability `not_executable`.                          | Separate eligible, bound, runtime-supported and authorized answers. One human-task contract rule (ADR 0029 decision 11).                                                    |
| Workflow generation         | `composeWorkflows` gives a `CandidateWorkflow` (sequential). Executed through `runtime/src/workflow/candidate-workflow-bridge.ts`. Workflow IR is emitted only by the policy pipeline (`policy/workflow-emit.ts`). API drafts are `WorkflowDefinition` (`apps/api/src/workflow-definitions/definition.ts`). Procedures go through `ProcedureDefinition` → `WorkflowGraph`.                            | A typed goal; `CandidateWorkflow` lowered to Workflow IR by one function; composition rationale.                                                                            |
| Static validation           | `validateWorkflowComponent` (`workflow-ir/src/validate.ts` L96) for Workflow IR. Composer audits (`auditWorkflowExecutability`, `auditWorkflowDataFlow`).                                                                                                                                                                                                                                             | Every generated definition validated; constructs the runtime does not support block readiness.                                                                              |
| Readiness and start         | API `routes/workflow-routes.ts` `startExecution` L312 → `startGated` (pause/trigger/cap) → `startWorkflowExecution` (`workflows/workflow-runner.ts` L745): re-composes, requires `executable`, then per-step `verifyApproval` + `authorizeCapabilityExecution`. Approvals bind contract hash, permission fingerprint, binding id and source digest (`approvals/approval-binding.ts`). No certificate. | `WorkflowReadinessCertificate` in `@xo/pre-execution`. The start route verifies it and rechecks permission.                                                                 |

## 2. Surfaces

| Surface                                        | Compile call                                                                                   | Persists or prints                                              | Workflow representation                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| API `POST /workspaces/:ws/sources/:id/compile` | `compileSources([input], {pageTiers, extractionBudget})` then `discoverAndResolveCapabilities` | capabilities, counts, graph (internal), part of `sources[0]`    | `CandidateWorkflow` re-composed per request; drafts as `WorkflowDefinition` |
| API `POST /compiler/compile`                   | `compileXoir` on a supplied graph                                                              | nothing persisted                                               | none                                                                        |
| CLI `xo compile`                               | `compileSources(files+prompts, {domainHint, lexicon})`                                         | sources, stats, validation, diagnostics, prompt interpretations | none                                                                        |
| CLI `xo create`                                | `compileSources(…, {policy:{ledger, workflows}})` twice (determinism check)                    | a `.xo` package with a Workflow IR `workflows` component        | Workflow IR (policy emit only)                                              |
| CLI `xo workflow` / `xo demo`                  | `compileSources(…, {domainHint})`                                                              | report                                                          | `CandidateWorkflow` → runtime bridge                                        |
| Studio                                         | API client (`apps/studio/src/platform/client.ts`)                                              | —                                                               | whatever the API returns                                                    |

None of these passes `precedence`, `connectors`, `confirmedRules` or `candidateProvider` to the compiler. Only the API passes OCR tiers.

## 3. What the API drops from a compilation

`CompileSourcesResult` (`compile-sources.ts` L115–143) carries the fields below. The API persists only `graph`, the capability projection and part of `sources[0]`.

| Field                                                     | Persisted by the API? |
| --------------------------------------------------------- | --------------------- |
| `graph`                                                   | yes                   |
| `valid`, `validation`, `diagnostics`, `passRuns`, `stats` | no                    |
| `policy`, `policyReview`                                  | no                    |
| `sources`                                                 | partly (`sources[0]`) |
| `unclassified`                                            | no                    |
| `promptInterpretations`                                   | no                    |
| `executionReadiness`                                      | no                    |
| `reviewQueue`                                             | no                    |
| `crossDocument`                                           | no                    |
| `aiCandidates`                                            | no                    |

## 4. Target sequence

```
upload / import / attachment ──► SourceRegistration (signature check, digest, version, origin, principal)
                                        │
                     SourceSet manifest (ordered {sourceId, digest, role}) ──► id ss_<sha256/24>
                                        │
                     compileSourceSet (one orchestration in @xo/pre-execution)
                       ├─ compileSources(inputs, options from one config)  ─► complete CompilationArtifact (persisted)
                       ├─ completeness assessment (validity ≠ completeness)
                       ├─ BKB reconcile ─► proposed ChangeSet ─(review/approve)─► KnowledgeState (id + digest)
                       ├─ capability inventory (statuses, duplicates, gaps) + contracts + binding reports
                       └─ goal ─► compose ─► Workflow IR + rationale + static validation
                                        │
                     ReadinessService ─► WorkflowReadinessCertificate (digest-bound, status)
                                        │
                     API start route: verify certificate + live permission check ─► runtime (unchanged)
```

## 5. Package layering (ADR 0029 decision 16)

```
@xo/types, @xo/errors, @xo/crypto
        ▲
@xo/knowledge-base  (BKB core, domain packs, store, snapshots, retrieval; structural XOIR view)
        ▲
@xo/pre-execution   (source sets, orchestration, completeness, inventory, lowering, readiness certificate)
   depends on @xo/compiler, @xo/capability-contract, @xo/workflow-composer, @xo/workflow-ir, @xo/xoir
        ▲
apps/api, apps/cli   (Studio only through the API)
```
