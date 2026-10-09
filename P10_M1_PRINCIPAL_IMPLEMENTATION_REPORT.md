# P1.0 M1 — Principal & Identity Foundation: Implementation Report

**Milestone 1 only. P1.0 is NOT complete.** Authorization (M2), audit (M4), approval integrity (M3), idempotency (M6), package trust (M5) and endpoint hardening (M7) are untouched. This report does not claim XO is secure or enterprise-ready.

Decisions: see `P10_ENTERPRISE_TRUST_DECISIONS.md` (A = approved; B = implementation details from repo inspection).

## 1. Initial repository state
- Repo = delivered `xo-monorepo-updated.zip` (P0.9C closed). P0.9C baselines unchanged by this milestone (not in the changed-file list; benchmark 228/228 still passes).
- Existing abstractions found and **extended, not duplicated**: `ApiKeyRecord`/`FsApiKeyStore`/`createApiKeyAuth` (hashed keys → `identityId`, revocation), `requireOwnedWorkspace`, `ExecutionRecord`/`WorkflowExecutionRecord`, `resolveHumanTaskExecution`. `@xo/permissions` had package/capability requesters but no principal.
- Pre-change exposure confirmed in code: `/runtime/execute` built `ExecutionEngine` without a permission gate and read provider key/base-url/endpoint from request headers; CLI `runCommand` AI branch likewise had no gate or identity.

## 2. Principal architecture and authentication mapping
- `packages/permissions/src/principal.ts`: `Principal {kind, id, orgId?}`; `parsePrincipal` (strict validation, unknown fields rejected, frozen copy); `establishAuthenticatedPrincipal` / `isAuthenticatedPrincipal` / `assertAuthenticatedPrincipal` (WeakSet-registered marker, so a structural copy, JSON, header or stored snapshot is never "authenticated"); `toPrincipalSnapshot`; `principalsEqual`. `orgId` is a label only (no membership/authority). `PermissionRequest`/`PermissionRequester` unchanged — package/capability identity stays separate.
- API authentication (`apps/api/src/http/auth.ts`): key → hash → store record → `establishAuthenticatedPrincipal({kind: record.principalKind, id: record.identityId, orgId?})`. Sets `req.principal` and the existing `req.identity` from the same record. No header/query/body is consulted for identity. Missing/invalid/revoked key → 401 (unchanged); a record lacking a valid principal binding → 401 "not bound to a valid principal". Errors never include key material (tested).
- Operator issuance: `scripts/manage-keys.ts issue <id> --kind human|service [--org <orgId>]`; `--kind` is mandatory (no default).
- `requirePrincipal(req)` (workspace-context.ts) fails closed unless an authenticated principal exists and agrees with `req.identity`.

## 3. Execution paths integrated
| Path | Result |
|---|---|
| API deterministic execution (`POST …/executions`) | `initiator` snapshot persisted from `req.principal`; `FsExecutionStore.create` requires an `AuthenticatedPrincipal` (asserts at runtime). |
| API HITL resolve (`POST …/resolve`) | resolver = authenticated principal (never body); recorded as `humanTask.resolver`; `initiator` unchanged. `resolveHumanTaskExecution` asserts an authenticated resolver. |
| API workflow start/resume/resolve | `WorkflowRunnerContext.principal` threads the same principal into the workflow record (`initiator`) and every step execution and HITL resolution. |
| Workspace-bound source→compile→execute | execution step attributed as above; ownership checks and uniform 404 unchanged. |
| Structured JSON/OpenAPI, installed-package capabilities executed through the API | same execution route/store, so attributed identically (they reach the API only via this route). |

## 4. Execution paths deferred, and why
- **CLI `xo run` / workflow / installed-package execution:** no authentication boundary exists in the CLI; env vars, flags and `--grant` are self-asserted and are deliberately not treated as identity. CLI deterministic execution therefore carries **no principal** and gains no fallback identity (limitation, not a fix).
- **Authorization using the principal:** M2. A principal grants nothing; the `--grant`/manifest gate and approval record behave exactly as before.
- **Approval record principal / HITL assignment / approver≠requester:** M3 (approval still records `approverIdentityId` as before).
- **Background/worker execution:** none exists in the API today (in-request only); a future worker must be given the initiating principal explicitly — it cannot mint one (the factory is the single trusted call site).
- **Nested/child-XO delegation:** Multi-XO foundation.

## 5. AI execution (disabled; confirmed)
- API `/runtime/execute`: ownership check first (uniform 404 preserved), then **501** `AI-assisted execution is disabled…` before any provider is resolved or caller header read.
- CLI `runCommand`: AI branch refuses before `resolveProvider()`; deterministic path unchanged. `xo query`/TUI go through `runCommand`, so they are covered.
- Switch is a code constant, not config/flag/env/header. No AI authorization logic added. Compiler semantics untouched.

## 6. Security tests (executed)
New: `packages/permissions/test/principal.test.ts` (24), `apps/api/test/principal.test.ts` (11). Covered: valid human/service principal; missing/empty/malformed/too-long/unsafe id; invalid kind; optional/malformed orgId; unknown authority fields; forged/deserialized/copied principal is not authenticated; valid key → expected principal on persisted execution (kind, id, orgId); legacy and invalid key records → 401 with no key echo; invalid/missing/revoked credential → 401 without echoing credential; forged `x-xo-*`/query/body identity cannot change initiator; HITL initiator preserved and resolver recorded separately (route and service level); fabricated resolver rejected; stores reject non-authenticated principals; workflow record carries initiator; workspace isolation uniform 404 and no new permission (unapproved execution still 403); `/runtime/execute` 501 (all body/header combos, ownership-first, 401 unauthenticated).
Updated (intentional): 5 `/runtime/execute` tests replaced by 2 disabled-path tests; 9 CLI `run.test.ts` tests that exercised the now-disabled AI branch rewritten to assert refusal and that `resolveProvider` is never called; test fixtures that create key records/stores now supply a principal kind/authenticated principal.

## 7. Test results (commands actually run)
| Command (cwd) | Result |
|---|---|
| `node --import tsx --test test/*.test.ts` (packages/permissions) | 116 pass / 0 fail |
| same (apps/api) | **199 pass / 0 fail** (was 191; −5 replaced, +2, +11) |
| same (apps/cli) | **260 pass / 2 fail** — the 2 known pre-existing decision-rule pinned-count failures (tests 8, 49), unchanged |
| same (packages/benchmark) | 228 pass / 0 fail |
| `npm run build` (repo root) | exit 0 |
Not re-run (untouched by this milestone): @xo/compiler suite (known M1.1 shape-6 failure), runtime, registry, package-sdk suites.

## 8. Known failures (pre-existing, not touched, not new)
2 CLI decision-rule pinned-count tests; @xo/compiler M1.1 shape-6. (The 9 CLI adm-zip failures did not occur in this environment.) No new failures.

## 9. Files changed (repo-relative)
New: `P10_ENTERPRISE_TRUST_DECISIONS.md`, `P10_M1_PRINCIPAL_IMPLEMENTATION_REPORT.md`, `packages/permissions/src/principal.ts`, `packages/permissions/test/principal.test.ts`, `apps/api/test/principal.test.ts`.
Modified: `packages/permissions/src/index.ts`; `apps/api/src/{auth/api-key-store.interface,http/auth,http/types,workspace/workspace-context,executions/execution,executions/fs-execution-store,executions/resolve-human-task,workflows/workflow-execution,workflows/fs-workflow-execution-store,workflows/workflow-runner,routes/execution-routes,routes/human-task-routes,routes/workflow-routes,routes/runtime/runtime-routes}.ts`; `apps/api/scripts/manage-keys.ts`; `apps/api/README.md`; `apps/api/src/openapi.ts`; `apps/cli/src/commands/runtime/run.ts`; tests `apps/api/test/{auth,runtime-routes,test-helpers,workflow-executions}.test.ts`, `apps/cli/test/run.test.ts`.
Not touched: compiler, XOIR, capability discovery/lowering, contract hashing, binding, benchmark metrics/baselines, package format, Studio.

## 10. Remaining trust gaps and limitations
1. **Compatibility break:** API keys issued before M1 have no principal binding and no longer authenticate (401); operators must revoke and re-issue with `--kind` (documented). No in-place "bind existing key" tool was built; it is proposed for review (Decision Record §D). Revocation remains by identity; no expiry/rotation/scopes.
2. The authenticated marker is an in-process guarantee; code in the same process can call the factory. The trusted boundary is the single reviewable call site.
3. Principal in persisted records is attribution, not proof; records remain mutable JSON with no integrity protection (M4).
4. `initiator` is absent on pre-M1 records (never back-filled).
5. CLI has no identity; `--grant` remains self-asserted (M2 context).
6. The permission gate is still vacuous for compiled capabilities and defaults to allow-all (audit G1/G2) — not addressed; AI paths are disabled rather than gated.
7. Approval is still unbound/non-expiring (M3); no idempotency or duplicate protection (M6); package signatures optional (M5); header-supplied provider endpoints remain in code behind the disabled route (M7).
8. ~~Docs gap~~ **Closed in the follow-up documentation pass:** `apps/api/README.md` and `src/openapi.ts` now describe `--kind`, the 401 for unbound keys, the operator migration (revoke then re-issue with an explicit kind), the 501 on `/runtime/execute`, the CLI AI refusal, `initiator`/`resolver`, and that a principal grants no permission and authorization is not yet implemented on all paths. A key-migration (`bind`) helper is **proposed for review only** (Decision Record §D), not built.
9. `orgId` is a label with no membership check (by design).
10. Single owner per workspace remains; the principal does not change ownership semantics.

## 11. Precise next milestone
**P1.0 M2 — Authorization:** carry the `AuthenticatedPrincipal` into `PermissionRequest` alongside the package/capability requester; make the gate default-deny on every execution path; derive/declare required permissions for compiled capabilities (or an explicit "none required" policy decision); make the AI paths enforce the gate before any re-enable decision. Hard stop here — awaiting review before M2.
