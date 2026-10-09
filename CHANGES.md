# P0.9B — Application Orchestration: Consolidation Package

Scope: the six steps from the approved P0.9B implementation plan (graph
identity, shared resolver set, contract content hash, canonical assembly
path, discover+resolve consolidation, inspection/provenance projection).
Read-only audit preceded this work; Area E untouched; no roadmap/scope
changes; `compile-pdf-to-package.ts` deliberately left as dead code,
deferred for separate sign-off.

44 files changed/added. Full monorepo build: clean. Full monorepo test
suite: 2936 tests, 3 failures — the exact same 3 pre-existing failures,
by name, as the pre-P0.9B baseline. Zero new failures. 57 new focused
tests added across 9 test files.

---

## Step 1 — Graph identity (graphHash)

**Files:** `packages/compiler/src/pipeline/compile-sources.ts`,
`packages/compiler/src/pipeline/capability-lowering.ts`,
`packages/runtime/src/capability-authority/runtime-capability-declaration.ts`,
`packages/runtime/src/capability-authority/runtime-capability-executor.ts`,
`packages/runtime/src/session/execution-receipt.ts`,
`packages/runtime/src/engine/execution-pipeline.ts`,
`packages/runtime/src/capability-authority/capability-binding-registration.ts`,
`packages/runtime/src/workflow/candidate-workflow-bridge.ts`,
`apps/api/src/executions/execute-capability.ts`,
`apps/api/src/workflows/workflow-execution.ts`,
`apps/api/src/workflows/workflow-runner.ts`.
**Tests:** `packages/compiler/test/pipeline/compile-sources-graph-hash.test.ts`,
`packages/compiler/test/pipeline/graph-hash-consistency.test.ts`,
additions to `packages/runtime/test/session/execution-receipt-capability-authority.test.ts`
and `packages/runtime/test/capability-authority/capability-binding-registration.test.ts`,
additions to `apps/api/test/execution-routes.test.ts` and
`apps/api/test/workflow-executions.test.ts`.

Uses the existing, authoritative `XoirGraph.contentHash()` — no second
graph identity introduced. `compileSources` now always sets
`manifest.graphHash = contentHash()` (previously only when
source-quality data existed). Threaded as an additive optional field:
`RuntimeCapabilityDeclaration.graphHash` → `RuntimeCapabilityExecutionResult.graphHash`
→ `ExecutionReceipt.graphHash` / `WorkflowExecutionRecord.provenance.graphHash`
/ API `ExecutionRecord.graphHash`. Absent, never fabricated, on the
installed-package path (no live graph).

**Bug found and fixed along the way:** `lowerCapabilitiesToManifest`
embeds resolved contracts into capability nodes, which *mutates* the
graph's content — so a `manifest.graphHash` cached before lowering runs
goes stale relative to the graph's real post-lowering identity (the one
a receipt is actually built from). Fixed in `capability-lowering.ts` by
refreshing the cached hash at the end of lowering (only when a manifest
was already present — never fabricates one), and in both `apps/api`
call sites by capturing the graph's hash *as loaded*, before that same
file's own lowering call can move it. Caught by
`graph-hash-consistency.test.ts` and the workflow-execution regression
test before it could reach a shipped receipt.

## Step 2 — Shared resolver set

**Files:** `packages/capability-contract/src/standard-resolvers.ts` (new),
`packages/capability-contract/src/index.ts`,
`packages/compiler/src/pipeline/capability-lowering.ts`,
`packages/runtime/src/workflow/candidate-workflow-bridge.ts`,
`packages/benchmark/src/observe.ts`, `apps/api/src/executions/execute-capability.ts`,
`packages/workflow-composer/src/audit.ts`.
**Tests:** `packages/capability-contract/test/standard-resolvers.test.ts`.

One canonical `STANDARD_BINDING_RESOLVERS` export, replacing five
independent local declarations of `[StructuredComparisonBindingResolver,
ActionEscalationBindingResolver]`. Resolver behavior unchanged (both
classes are stateless; sharing singleton instances is behaviorally
identical to each caller's own `new`). **Deliberately not touched:**
`apps/cli/src/commands/runtime/deterministic-router.ts` keeps its
narrower, single-resolver list (`[StructuredComparisonBindingResolver]`
only) for the installed-package path — a pre-existing asymmetry outside
this step's mandate, called out rather than silently widened.

## Step 3 — Contract content hash

**Files:** `packages/capability-contract/src/contract-hash.ts` (new),
`packages/capability-contract/src/types.ts`,
`packages/capability-contract/src/contract-embed.ts`,
`packages/capability-contract/src/index.ts`,
`packages/capability-contract/package.json`,
`packages/capability-contract/tsconfig.json` (added `@xo/crypto`
dependency), `packages/types/src/xo-capability.ts`,
`packages/compiler/src/pipeline/capability-lowering.ts`,
`packages/runtime/src/capability-authority/{runtime-capability-declaration,runtime-capability-executor}.ts`,
`packages/runtime/src/session/execution-receipt.ts`,
`packages/runtime/src/engine/execution-pipeline.ts`,
`packages/runtime/src/capability-authority/capability-binding-registration.ts`,
`apps/api/src/executions/execution.ts`, `apps/api/src/executions/execute-capability.ts`,
`apps/api/src/executions/fs-execution-store.ts`, `apps/api/src/routes/execution-routes.ts`,
`apps/api/src/workflows/workflow-runner.ts`.
**Tests:** `packages/capability-contract/test/contract-hash.test.ts`,
`packages/compiler/test/pipeline/capability-lowering-contract-hash.test.ts`,
additions to the runtime and API test files listed under Step 1.

`computeContractContentHash` reuses `@xo/xoir`'s `canonicalStringify` +
`@xo/crypto`'s `Sha256Hasher` — no new hashing utility. Hashes `name,
description, category, inputs, outputs, requiredPermissions,
determinism, rules, actionKnowledgeRefs`; excludes `id`, `confidence`
(contract- and rule-level), `sourceRefs`, `sourceXoirNodeIds`.

**Refinement found empirically (test-driven):** each rule's
`sourceNodeId` and each action-knowledge ref's `sourceNodeId` are XOIR
node-id pointers — provenance, not content — and needed the same
exclusion: two semantically identical contracts compiled with
differently-named graph nodes were hashing differently until this was
added. A failing "equivalent compilations produce the same hash" test
caught it.

Attached additively: `contentHash` on the embedded contract
(`contract-embed.ts`, always recomputed, never copied from a possibly
stale field), `contractContentHash` on `CapabilityExecutionDeclaration`
and threaded through the same receipt/record chain as `graphHash`,
identically on both information-boundary paths.

## Step 4 — Canonical assembly path

**Files:** `packages/runtime/src/capability-authority/contract-execution.ts` (new),
`packages/runtime/src/index.ts`, `apps/api/src/executions/execute-capability.ts`,
`apps/cli/src/commands/runtime/deterministic-router.ts`,
`packages/runtime/src/workflow/candidate-workflow-bridge.ts`.
**Tests:** `packages/runtime/test/capability-authority/contract-execution.test.ts`.

`resolveContractBinding` / `executeResolvedContract` — the one shared
`contract -> binding resolution -> registration -> RuntimeCapabilityExecutor`
sequence, replacing hand-written copies in API execute, API resume, and
`xo run`. **Placed in `@xo/runtime`, not `@xo/capability-contract`** —
decided by dependency direction: `@xo/runtime` already imports
`@xo/capability-contract` (checked in `package.json`), the reverse would
cycle, and the helper's last two steps need `RuntimeCapabilityRegistry`/
`RuntimeCapabilityExecutor`, which exist only in `@xo/runtime`.
`RuntimeCapabilityRegistry.register()` itself was not touched. Each
caller keeps its own error wording and its own `PermissionManager`
policy (a host decision, not this helper's).

## Step 5 — Discover + resolve consolidation

**Files:** `packages/compiler/src/pipeline/capability-discovery.ts` (new),
`packages/compiler/src/pipeline/index.ts`,
`apps/cli/src/commands/compiler/capabilities.ts`,
`apps/api/src/compilations/compile-source.ts`, `packages/benchmark/src/observe.ts`.

`discoverAndResolveCapabilities` replaces three independent
`compileSources` + preview-`packageXoirGraph` sequences. Runs the real
`packageXoirGraph` in memory and discards the bundle — not a second
lowering implementation. The benchmark observer's equivalence role is
preserved and strengthened: it now checks the real shared
implementation (and the real shared resolver list / assembly helper
from Steps 2 and 4) rather than a hand-copied duplicate of any of them.
`examples/vertical-test` (untouched) remains the reference golden path.

## Step 6 — Canonical inspection / provenance

**Files:** `packages/capability-contract/src/provenance-projection.ts` (new),
`packages/capability-contract/src/index.ts`.
**Tests:** `packages/capability-contract/test/provenance-projection.test.ts`,
additions to `packages/runtime/test/capability-authority/contract-execution.test.ts`.

`projectCapabilityProvenance` / `projectExecutionProvenance` /
`projectWorkflowProvenance` — a pure, read-only data projection over
existing ids/hashes (`sourceRefs`, `sourceXoirNodeIds`, `contractId`,
`bindingId`, `graphHash`, `contractContentHash`). No new identity, no
trust/approval semantics: `agreement` fields report
`'match'|'mismatch'|'unknown'` only, never a verdict. Answers, from data
already produced by Steps 1–5: source → capability → XOIR nodes →
contract → binding, and workflow step → capability/contract/binding →
execution → graphHash/contractContentHash.

---

## Regression summary

| package | baseline | after |
|---|---|---|
| capability-contract | 160 / 0 fail | 187 / 0 |
| compiler | 875 / 1 fail | 889 / 1 (same failure, by name) |
| runtime | 417 / 0 | 433 / 0 |
| api | 191 / 0 | 191 / 0 |
| cli | 262 / 2 fail | 262 / 2 (same 2 failures, by name) |
| all other packages | unchanged | unchanged |

Pre-existing failures, unaffected by this work (identical by name before
and after): `M1.1 shape 6 — prerequisite rule with an unparseable
outcome shape: never minted`; two `vertical-test`-fixture resolved-count
assertions in `apps/cli/test/{capabilities,create}.test.ts`.

## Deferred, not in this package

`packages/compiler/src/pipeline/compile-pdf-to-package.ts` — confirmed
dead code (zero callers), left untouched. Flagged for separate
post-P0.9B cleanup sign-off.
