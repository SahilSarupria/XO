# P1.0 Enterprise Trust — M2: Authorization — Implementation Report

**Status: AWAITING REVIEW. Not complete, not merged.** Branch `feat/p10-m2-authorization`, based on merged `main` @ `81f2bce`. M4 and later milestones have not been started.

## 1. Pre-change call graph and gap inventory (inspected on merged main)

| Entry point                                                          | Route into execution                                                                  | Gate before M2                                                                         | Gap                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| API `POST /executions` (deterministic)                               | `executeApprovedCapability` → `executeResolvedContract` → `RuntimeCapabilityExecutor` | fresh `RuleBasedPolicy([])` per call; requirements from `contract.requiredPermissions` | no principal in the decision; empty requirements ⇒ run; `[]` indistinguishable from "compiler never said" (`contract-builder` defaults `?? []`) |
| API workflow start / each step                                       | `workflow-runner` `authorizeStep` + `RuntimeCapabilityExecutor`                       | same empty policy                                                                      | same; unmatched step skipped the check                                                                                                          |
| API workflow resume / HITL resolve                                   | `resolveHumanTaskExecution` → `attemptResume` → `resumeCapabilityExecution`           | same; **reject bypassed all checks**                                                   | resolver not part of any decision                                                                                                               |
| CLI `xo run` (deterministic)                                         | `tryDeterministicRun` → `executeResolvedContract`                                     | `--grant` ALLOW rules; requirements from contract/manifest                             | missing declaration ⇒ run; no subject                                                                                                           |
| CLI `xo workflow` / `xo demo`                                        | `runWorkflowPipeline` → `RuntimeCapabilityExecutor`                                   | empty policy                                                                           | same                                                                                                                                            |
| `ExecutionEngine`/`ExecutionPipeline` (direct construction; AI path) | `permissionGate`                                                                      | **default `allowAllPermissionGate`**; `PermissionManagerGate`: no requirements ⇒ allow | fail-open default; gate had no subject; throwing gate propagated                                                                                |
| `RuntimeCapabilityRegistry.register`                                 | —                                                                                     | `requiredPermissions` optional                                                         | absent ⇒ no requirement                                                                                                                         |
| `packages/benchmark/observe.ts`, `examples/*`                        | executor / `executeResolvedContract`                                                  | empty policy                                                                           | no subject                                                                                                                                      |
| API `/runtime/execute`, CLI AI path                                  | `ExecutionEngine`                                                                     | disabled in M1                                                                         | must stay disabled                                                                                                                              |

## 2. Authorization contract (as implemented)

One decision function, `authorizeCapabilityExecution` (`packages/permissions/src/authorization.ts`), reused by every path. Inputs, none substitutable for another:

1. **Subject** — `AuthenticatedPrincipal` (API) or `TrustedExecutionContext` (CLI `local-operator`; benchmark `evaluation-harness`). Verified by registry membership (`WeakSet`), not shape. Plain objects, JSON copies, strings ⇒ deny.
2. **Requester** — package/capability identity (kept separate; never evidence of identity).
3. **Declaration** — `required` | `none` | `unresolved`, resolved from authoritative metadata.
4. **Policy** — existing `PermissionManager`/`RuleBasedPolicy`, extended with `principalId` / `principalKind` rule matchers. A principal-scoped rule never matches a request without a principal. Rules without a principal matcher apply to any verified subject (explicit author choice). `orgId` is never matched or trusted.

Everything fails closed and returns a denial value: no manager, no/forged subject, no requester, absent/unresolved declaration, policy throwing, any non-`allow` decision (`prompt` = deny).

### Semantics of missing vs permission-free

- **Explicitly permission-free** = a present declaration equal to `[]` (`requiredPermissions: []`). Still requires a verified subject.
- **Missing / null / non-array / non-string entry / invalid id / conflicting copies** = `unresolved` ⇒ **denied**, even under an allow-everything policy.
- Authoritative sources: the capability node's own persisted `requiredPermissions` property (API graph; CLI package knowledge_graph); registry registration (`requiredPermissions` is now mandatory, `[]` allowed); manifest `permissions[]` and `execution.requiredPermissionIds` are **additive only** (can make a capability stricter, never looser). A contract copy that requires something the authoritative declaration omits ⇒ conflict ⇒ deny. Re-registering as permission-free never loosens an earlier requirement.
- Not changed: contract schema/hash, compiler, lowering (so no P0.9C baseline impact).

## 3. Execution paths and enforcement points

| Path                                                     | Where enforced                                                                                                                                                      | Bypass test                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| API `POST /executions`                                   | `executeApprovedCapability` (principal + server policy + node declaration) → executor                                                                               | `apps/api/test/authorization.test.ts` (execute: missing/null/malformed declaration, fabricated subject, no manager, other principal) |
| API workflow start (preflight every step) and every step | `authorizeStep` (single decision; unmatched step ⇒ deny) + executor bound to principal                                                                              | workflow denial/grant/other-principal/forgery/isolation tests; no execution/workflow record created on denial                        |
| API workflow resume                                      | per-step `authorizeStep` again + executor                                                                                                                           | HITL chain test (initiator preserved); existing re-check test                                                                        |
| API human-task resolve (approve **and reject**)          | `resumeCapabilityExecution` authorizes the **resolver** before any outcome                                                                                          | resume tests (approve/reject denied for no grant, wrong principal, missing declaration)                                              |
| CLI `xo run` deterministic                               | `tryDeterministicRun`: subject check first, declaration build, decision, then `executeResolvedContract` re-checks                                                   | `apps/cli/test/authorization.test.ts`                                                                                                |
| CLI `xo workflow`/`demo`                                 | declaration check for every bound step before running + executor bound to local operator                                                                            | existing workflow/demo suites (green) + malformed-source test                                                                        |
| `RuntimeCapabilityExecutor` direct                       | constructor **throws** without verified subject/manager; `execute` decides                                                                                          | `packages/runtime/test/authorization-m2.test.ts`                                                                                     |
| `executeResolvedContract` direct                         | stage `authorization` before registration/handler                                                                                                                   | `contract-execution.test.ts` additions                                                                                               |
| `ExecutionPipeline`/`ExecutionEngine` direct             | default gate = **deny-all**; malformed/throwing/non-`allowed:true` gate ⇒ deny; `createPermissionManagerGate` requires verified subject and an explicit declaration | `permission-gate.test.ts` rewritten + extended                                                                                       |
| Benchmark harness, examples                              | explicit `evaluation-harness` / `local-operator` context                                                                                                            | benchmark suite 228/228 unchanged; `examples/vertical-test/run.ts` run: SUCCESS                                                      |

### AI execution (kept disabled)

`/runtime/execute` returns 501 and `AI_EXECUTION_ENABLED=false` in CLI; neither was touched. Tests: authorized principal + allow-all policy + provider headers/body/env/`--grant` still refused; provider resolver never called. Authorization success never flips the flag. (Independently, an unconfigured `ExecutionEngine` now denies by default.)

## 4. Test results (actually executed)

Baseline captured on merged main before edits (permissions 116/0, runtime 433/0, api 199/0, cli 260/**2**, workflow-composer 51/0), then extended to every package after changes.

| Package            | Baseline                                                   | After M2         |
| ------------------ | ---------------------------------------------------------- | ---------------- |
| permissions        | 116 / 0                                                    | 140 / 0          |
| runtime            | 433 / 0                                                    | 449 / 0          |
| api                | 199 / 0                                                    | 216 / 0          |
| cli                | 260 / 2                                                    | 270 / 2          |
| benchmark          | n/a (not baselined; 228/0 after)                           | 228 / 0          |
| workflow-composer  | 51 / 0                                                     | 51 / 0           |
| compiler           | 894 / **1** (verified on pristine `main` by stash+rebuild) | 894 / 1          |
| all other packages | —                                                          | all pass, 0 fail |

Workspace `npm run build`: exit 0 (before and after).

**Pre-existing failures (not regressions):** CLI `capabilities … vertical-test benchmark fixture … nonzero resolved count` (#8) and `create … lowers a nonzero resolved count` (#49) — fail identically on merged main; compiler `M1.1 shape 6 — prerequisite rule with an unparseable outcome shape` — fails identically on pristine main. Not touched.

**No regressions.** During the work, well over 100 existing tests failed (runtime 129, api 20, cli 24 at the first runs) because their fixtures relied on the fail-open defaults. They were migrated (not weakened): fixtures now declare `requiredPermissions: []` / pass an explicit subject / pass an explicit `allowAllPermissionGate` where permissions are not the subject of the test. Tests asserting the old fail-open behavior (default no-op gate; "no declaration ⇒ executes" in `permission-gate`, `permission-integration` sec5 and CLI R3 #132; invalid-permission stage in `contract-execution`) were rewritten to assert the new fail-closed behavior.

**Not run:** `examples/e2e-pdf/run.ts` (patched with an explicit gate opt-out; not executed); no live HTTP deployment/manual run beyond the in-process test servers.

## 5. Migration impact

- `RuntimeCapabilityRegistration.requiredPermissions`, `RuntimeCapabilityExecutor.subject`, `ExecuteResolvedContractRequest.subject` + `.permissionDeclaration`, `createPermissionManagerGate({subject})`, `tryDeterministicRun(..., subject)`, `registerRoutes({permissionManager})` are now required. Embedders must supply them.
- Hand-built graphs/packages whose capability nodes lack `requiredPermissions` are now **denied** until they declare it (compiler output always writes it).
- Manifest-gate path (`createPermissionManagerGate`): a capability with no explicit declaration anywhere is denied. The compiler's lowering omits `execution.requiredPermissionIds` when empty, so compiled-and-packaged capabilities need `execution.requiredPermissionIds: []` (or a host registry entry) to run through the `ExecutionPipeline` path. The deterministic CLI path is unaffected (uses the node property). Lowering was deliberately not changed (compiler out of scope; baseline risk).
- API default policy is deny-all for any capability declaring a permission.

## 6. Remaining risks / deferred (not silently expanded)

1. **API policy source is programmatic** (`ServerDeps.permissionPolicy`). No operator-facing config file/CLI exists yet, so a stock deployment denies every permission-declaring capability. Needs a decision (small follow-up, arguably M2.1 or M7).
2. **"Execute" itself is not a permission.** Permission-free capabilities require only an authenticated principal (+ existing workspace ownership and approval checks). Requiring a `runtime.execute` grant for every execution would be a policy decision I did not take.
3. Stored `PermissionGrant`s remain package-scoped (not principal-scoped); not used by any API/CLI path today.
4. `TrustedExecutionContext`/`AuthenticatedPrincipal` unforgeability is in-process (same documented limit as M1); trust boundary = reviewable mint call sites (CLI `run.ts`, `workflow-pipeline.ts`, benchmark `observe.ts`, examples).
5. `allowAllPermissionGate` remains exported as an explicit opt-out; nothing in `apps/*` uses it. `allowAllMemoryPermissionGate` (memory access default) is still allow-all — memory is not a capability-execution path; deferred.
6. A denied API execution still persists a failed execution record (existing behavior; denial occurs after record creation, before the handler). Durable audit semantics belong to M4.
7. No test mutates server policy mid-workflow to prove re-authorization on resume with a _permissioned_ step; per-step authorization is covered structurally (the same `authorizeStep` runs every step) and by the existing approval-revoked test.
8. Tracked compiled `src/*.js` files exist next to `.ts` throughout the repo (pre-existing, stale); not touched.

## 7. Acceptance checklist

| Criterion                                                                   | Status                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Every identified protected entry point has an effective gate                | Met (table §3)                                                                |
| Absence of a gate cannot become allow-all                                   | Met (default deny-all; executor/gate cannot be built without subject/manager) |
| Principal and requester identity separate                                   | Met (`PermissionRequest.principal` vs `requester`)                            |
| Requirements from authoritative, validated declarations                     | Met (node property / registry / manifest-additive)                            |
| Missing/ambiguous metadata cannot authorize                                 | Met (tested incl. allow-all policy)                                           |
| Permitted succeed, unauthorized denied                                      | Met                                                                           |
| Denials before side effects                                                 | Met (handler call counters = 0 in tests)                                      |
| Workflow, resume, HITL, deterministic, API, CLI, direct-engine bypass tests | Met (see §3); item 7 caveat                                                   |
| M1 attribution/authentication/workspace isolation intact                    | Met (M1 suites green; isolation test added)                                   |
| AI execution disabled and unreachable                                       | Met                                                                           |
| No P0.9C baseline changes / no unrelated roadmap work                       | Met (benchmark src change = explicit subject only; 228/0)                     |
| Build and tests reported with actual results                                | Met (§4), with the "not run" items listed                                     |
| Docs describe contract, limitations, migration                              | Met (this report)                                                             |

**M2 is awaiting review. It is not complete and not merged. No M3+ work has begun.**
