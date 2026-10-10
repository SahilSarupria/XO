# P1.0 Enterprise Trust — M2: Authorization — Implementation Report

**Status: AWAITING OWNER REVIEW. Not complete, not merged, not accepted.** Branch `feat/p10-m2-authorization`, based on merged `main` @ `81f2bce`. A post-review security remediation (§8) is on branch `fix/p10-m2-authorization-boundaries`. M3 and later milestones have not been started.

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
6. ~~A denied API execution still persists a failed execution record.~~ **Resolved in §8 (Finding A).** Denied direct executions now create no record. Durable audit of denied attempts (if the product wants them recorded) is a separate M4 design decision needing owner approval and abuse/storage controls.
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
| Denials before side effects                                                 | Met for handler calls; direct API route met only after §8 (Finding A)         |
| Workflow, resume, HITL, deterministic, API, CLI, direct-engine bypass tests | Met (see §3); item 7 caveat                                                   |
| M1 attribution/authentication/workspace isolation intact                    | Met (M1 suites green; isolation test added)                                   |
| AI execution disabled and unreachable                                       | Met                                                                           |
| No P0.9C baseline changes / no unrelated roadmap work                       | Met (benchmark src change = explicit subject only; 228/0)                     |
| Build and tests reported with actual results                                | Met (§4), with the "not run" items listed                                     |
| Docs describe contract, limitations, migration                              | Met (this report)                                                             |

**M2 is awaiting review. It is not complete and not merged. No M3+ work has begun.**

## 8. Security remediation after review (branch `fix/p10-m2-authorization-boundaries`)

Two findings from review of the M2 branch were independently verified against the code **before** any fix, using failing tests on PR head `23b9f0a`.

### Finding A — authorization after an API side effect (CONFIRMED)

**Root cause.** In `apps/api/src/routes/execution-routes.ts` the order was: ownership → compilation/capability → approval → graph load → **`executionStore.create`** → `executeApprovedCapability` (graph rebuild, input validation, authorization, handler). Authorization was decided only after a persistent record existed. **Verified before the fix:** an authenticated but unauthorized `POST /executions` returned **HTTP 200** with a persisted `failed` record; repeating it grew the store (tests A1, A2, A3, A5 failed; A4/A4b, the positive paths, passed).

**Fix.**

- `@xo/runtime` now exports `resolveEffectiveDeclaration` and `authorizeContractExecution`. `executeResolvedContract` uses the same function for its decision, so a preflight and the real execution share one implementation.
- `apps/api/src/executions/execute-capability.ts` adds `preflightCapabilityAuthorization(graph, capabilityId, authorization)`: loads the persisted graph, builds the contract, derives the declaration from the persisted capability node, and runs the shared decision with no registration, execution or persistence.
- The route calls it **before** `executionStore.create`; denied or undecidable returns the error (403 `XO_RUNTIME_PERMISSION_DENIED` for authorization) with no record.
- `executeApprovedCapability` still fully re-authorizes at the execution boundary (defense in depth). A preflight "authorized" grants nothing to a later call.
- **TOCTOU.** The route passes one in-memory graph to both steps. The boundary re-derives the declaration from the graph it runs. As an extra tie, `preflightGraphHash` makes execution refuse a different graph. **Verified limit:** `fromJson` trusts stored node hashes, so editing node properties without their `hash` does not change `contentHash()`; that case is covered by re-derivation, not by the hash (test A8).

**API contract change (intentional, needs owner awareness).** Unauthorized direct executions now return 403 with no record. Previously 200 with a `failed` record. The authorized path and its record are unchanged.

### Finding B — caller-supplied declaration trusted too much (CONFIRMED)

**Root cause.** `executeResolvedContract` accepted any structurally shaped `PermissionDeclaration`. Its only check was `declarationCoversCopy(supplied, contract.requiredPermissions)`, and `contract-builder` defaults the copy to `[]`. **Verified before the fix:** a hand-written `{kind:'none'}`, a JSON round-trip of it, and the shared `PERMISSION_FREE` constant each **executed** a capability under a deny-all policy with no grant, and the handler ran (B1–B3 failed).

**Fix (smallest design reusing `@xo/permissions`).**

- `resolveAuthoritativeDeclaration(raw, {capabilityId, origin})` and `attestAuthoritativeDeclaration(resolved, …)` mint a **fresh frozen** declaration recorded in a module-private `WeakMap`, bound to one capability id and a trusted origin (`persisted-xoir-node`, `installed-package-manifest`, `trusted-host-registration`). `isAuthoritativeDeclarationFor(x, id)` verifies identity.
- `executeResolvedContract` accepts only a declaration minted for `contract.id`. Literals, JSON copies, spreads, casts, the shared constant, and declarations minted for another capability are denied before registration. The cover-the-copy check remains (authoritative may be stricter, never weaker).
- Callers updated: API node-declaration helper, CLI deterministic router, benchmark harness. Test helper `declaredFrom` now mints.
- `[]` still means permission-free **only** when authoritatively declared; absent/malformed stays `unresolved` (denied).

### Regression tests added

| File                                                                           | Tests       | What it proves                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/execution-preflight.test.ts`                                    | A1–A10 (11) | denied before any record (store read directly), repeated denials don't grow store, invalid-input denial, authorized + permission-free still record, missing/malformed metadata fail closed under allow-all, handler `evaluate` counted 0 when denied / 1 when allowed, lower-level direct call can't bypass, TOCTOU, preflight vs execution agree across 4×4 graph/policy cases, workflow start with missing metadata denied |
| `packages/runtime/test/capability-authority/authoritative-declaration.test.ts` | B1–B13 (13) | forged / JSON / replayed / cross-capability declarations denied, missing/malformed denied, explicit permission-free executes, still needs verified subject, contract copy can't weaken authoritative, copy demanding more is a conflict, minting not imitable, smuggled executor-request declaration ignored, unknown/unverified/undeclared registrations refused                                                            |

Existing tests changed (transparently, narrowly): `contract-execution.test.ts` (5 tests now use a **minted** declaration so they still test what their names say instead of passing for the new provenance reason); `authz-helpers.ts#declaredFrom` mints; `workflow-fixtures.ts#storeFixtureCompilation` gained an optional graph override. No grants were added to fixtures.

### Validation actually run (sandbox limits noted)

The sandbox cannot reach the npm registry (`npm ci` fails: ENOTFOUND), so the repo's own toolchain could not be installed. Tests were run with a global `tsx` plus a scratch resolver (outside the repo) mapping `@xo/*` to `src/index.ts` and preferring `.ts` over the stale tracked `.js`, running each package's `test/**/*.test.ts` under `node --test`.

| Suite                                                                                            | PR head (before)               | Remediation branch                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| permissions                                                                                      | 140/140                        | 140/140                                                                                                                             |
| runtime                                                                                          | 449/449                        | 462/462 (+13)                                                                                                                       |
| api                                                                                              | 216/216                        | 227/227 (+11)                                                                                                                       |
| benchmark                                                                                        | not run before                 | 228/228                                                                                                                             |
| capability-contract                                                                              | not run before                 | 187/187                                                                                                                             |
| cli                                                                                              | 258 pass / 11 fail / 3 skipped | 258 / 11 / 3 — **identical 11 failures, also on base `81f2bce`** (9 zip tests need uninstalled `adm-zip`; 2 vertical-test fixtures) |
| compiler                                                                                         | not run before                 | 892 pass / 2 fail — **identical 2 failures on base `81f2bce`**                                                                      |
| all other packages (ai-core, graph-ui, package-sdk, registry, workflow-composer, xoir, types, …) | —                              | all pass                                                                                                                            |

- **Finding tests before the fix:** A: 4 of 6 initial tests failed (denial returned 200); B: 3/3 repro tests failed.
- **Format:** `prettier --check` (3.8.1, repo config) clean on every changed file except `packages/benchmark/src/observe.ts`, whose 68 lines of formatting debt are identical at PR head (left untouched to avoid unrelated churn). `packages/permissions/src/authorization.ts` had 7 lines of pre-existing debt at PR head; the whole file was formatted.
- **Typecheck (approximation):** global `tsc` 6.0.3 (repo pins 5.x) over changed files with strict repo options: no errors in changed source files; 3 errors remain in `contract-execution.test.ts` (lines 25, 212, 231) and are **present at PR head too** (pre-existing).
- **No frozen P0.9C artifact changed** (no baseline/golden/fingerprint files touched; only `observe.ts` source minting, benchmark suite 228/228).

### NOT verified (stated, not assumed)

- **ESLint was not run locally** (not installed, registry unreachable), so lint cleanliness of the changed files is **not verified**; a `tsc --noUnusedLocals` approximation found no unused symbols in them. CI evidence for PR head `23b9f0a` (GitHub check annotations, read after the branch was pushed): the `verify (22.x)` job failed and `verify (20.x)` was cancelled. The annotated lint errors (`packages/ai-core/src/prompt/default-prompts.d.ts`, `apps/cli/src/commands/package/dependency-lookup.ts`, `apps/api/src/executions/fs-execution-store.ts`, `apps/api/src/approvals/fs-approval-store.ts`) are in files **unchanged by M2 and by this remediation** (`git diff 81f2bce 23b9f0a` is empty for them), i.e. pre-existing. **Limit:** GitHub caps annotations (about 10 errors) and the full job log could not be downloaded from this sandbox, so the complete lint error list and the "same failures on base" comparison are **not established**. No CI has run on the remediation branch (the workflow triggers on `pull_request` and pushes to `main` only).
- **Repo-pinned `tsc -b` typecheck, `npm run build`, and the GitHub Actions run** were not run/observed.
- **Build and repo-pinned `tsc -b`** were not run. **PR #2 state (read after push):** open, unmerged, base `main`, head `feat/p10-m2-authorization` @ `23b9f0a`, 1 commit, 59 files, 1 review comment (the review that raised both findings), no review threads. `main` has since advanced `81f2bce` → `b2192bd` (`fix(package-sdk): prevent package component path traversal`, `package-sdk` only, no overlap with M2 or this remediation); the M2 branch needs syncing with `main` before any merge, an owner decision.

### Residual risks / limitations

1. **Minting is an in-process guarantee**, same documented limit as M1 principals: any code that can call `resolveAuthoritativeDeclaration` can mint. It stops structural forgery, JSON, casts, replay across capabilities and omitted metadata, not a malicious in-process caller. Trust = the reviewable call sites (API node helper, CLI router, benchmark harness, test helper).
2. **Benchmark harness self-attests** its declaration from the contract it evaluates (origin `trusted-host-registration`); this is the evaluation host acting as the host, deny-all policy, and is labeled in code.
3. **Direct registry registration remains host-trusted.** `registerResolvedCapabilityBinding`/`RuntimeCapabilityRegistry.register` take requirements from the registrar (e.g. the workflow bridge derives them from the contract copy). The API workflow runner cross-checks the persisted node against the registry before every step, but the engine-level check inside the workflow bridge uses the registry copy. Not changed here (out of scope; no bypass demonstrated by an exported-API caller that does not already control registration).
4. The preflight hash tie cannot detect property edits that leave node `hash` untouched (see Finding A TOCTOU).
5. Invalid-input and unresolved-binding failures of an **authorized** caller still create a `failed` record (unchanged; not an authorization bypass).
6. Denied attempts are not recorded. If the product requires that, it is a separate M4 decision with abuse/storage controls and owner approval.
7. Tracked compiled `src/*.js` / `.d.ts` files beside `.ts` (pre-existing, stale) were not touched.

### Checklist (awaiting owner review)

| Item                                                  | Status                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Finding A verified, fixed, regression-tested          | Complete (tests run)                                                    |
| Finding B verified, fixed, regression-tested          | Complete (tests run)                                                    |
| Report updated with actual results                    | Complete                                                                |
| ESLint / repo `tsc -b` / build / CI green             | **NOT VERIFIED** (environment; partial CI evidence in the bullet above) |
| GitHub PR #2 state checked; remediation branch pushed | Complete (pushed, not merged; no PR opened)                             |
| Owner review and acceptance of M2                     | **PENDING** — M2 is not accepted; M3 not started                        |
