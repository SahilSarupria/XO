# P1.1 — M2 Implementation Report (persisted procedure lifecycle, HTTP, OpenAPI, audit, registry integrity)

Date: 2026-10-18 · Branch `p11/m1-procedure-validator` · HEAD `86c7a8fc3d5fa71d785ed08c237e8195ca2a3513` (the M1 commit) · **M2 is uncommitted** (not committed, pushed, or PR'd; remote CI deferred to the P1.1 phase-end gate)

Companion to `P11_M0_CLOSEOUT.md` and `P11_M1_REPORT.md` (unchanged). The planning PDFs are external and unmodified; their PENDING historical statuses stand. The decisions below are the owner's new acts.

## Disposition

**M2 IMPLEMENTATION COMPLETE LOCALLY — NOT ACCEPTED.** All local checks pass. M2 is not accepted: remote CI (G-4, deferred to the phase-end gate for M1 and M2), the independent M2 review (PDF O-4, still PENDING), and the owner review have not happened. Nothing here claims remote verification or final P1.1 acceptance.

## 1. Frozen scope (Revised Plan + Acceptance Matrix)

M2 = "Persisted lifecycle, authoring/validation/approval/read over HTTP, OpenAPI, audit"; execution excluded. Delivered: procedure store and service, five HTTP routes, approval-binding integration, route-specific body cap, OpenAPI, audit types, default-deny `procedure.*` permissions, and registry-dependent validation (unknown capability/contract, dangling bindings, compilation-reference integrity and hash drift).

## 2. Owner decisions recorded (2026-10-18; new acts, not content of the PDFs)

- **PDF O-5 (identity/idempotency lines): APPROVED AS WRITTEN.** Merged API-key principal model; the plan's M6 idempotency approach (not implemented here); no code imported from unmerged Studio, OIDC or `feat/ei-m2-authorization-audit-design`.
- **PDF O-6 (audit taxonomy): APPROVED, bounded M2 subset only:** `procedure.authored`, `procedure.validated`, `procedure.approval.granted`, `procedure.approval.denied`, `procedure.attempted`, `procedure.denied`. A test asserts the audit type list contains exactly these six `procedure.*` types.
- **M1 prerequisite:** OWNER-APPROVED; remote CI deferred to the phase-end gate (timing changed, gate not waived).
- **Scope:** FULL FROZEN M2.
- Resolutions applied: no default-on approver ≠ starter rule (O-1 supersedes plan D-9); the 262,144-byte limit is the procedure body cap; M1 contracts unchanged; `resolvePath` hardening is outside M2; execution-detail and step audit events not added; M1 CI deferred, not waived.

## 3. Plan conflicts and judgment calls (documented, nothing silently settled)

1. **Plan D-9 vs O-1:** the plan's default-on separation rule is not implemented; one principal may author and approve. OpenAPI states there is no independence claim.
2. **Plan D.2 vs D.7:** D.2 implies a stored "validated" state; D.7 makes `POST …/procedures:validate` pure and persists nothing. Implemented D.7: validation is stateless; **approval performs a fresh authoritative validation** and is unreachable with any blocking finding. "Validated/approved/executable" are computed, never stored. _Proposed interpretation._
3. **Plan D-3 body cap:** the owner-approved 262,144 bytes is used at the route (enforced while reading, before parsing) and in the M1 library; no other cap.
4. **New audit target kind `procedure`** was added to `AUDIT_TARGET_KINDS` (the draft table required it). It is a target kind, not an event type, but it is outside the literal list you approved — **flagged for your review.**
5. **New permission domain `procedure`** was added to `@xo/permissions` so `procedure.author|approve|execute|read` can exist (the domain list is closed). Default policy denies all four.
6. **Audit metadata cannot carry full hashes** (the audit validator rejects 40+-character opaque runs), so events carry 23-character `sha256:` prefixes; full hashes live in the procedure and approval records, correlated by `correlationId`. The audit validator was not changed.
7. **Effectful presumption (A-1/A-3):** authoritative effect classification is unresolved (O-2). A procedure is treated as possibly effectful if any step has the advisory `effectIntent: write` (escalation-only) or resolves to an `external_tool` capability; a **service** principal cannot approve it. `effectIntent: read` never lowers anything. _Proposed interpretation._
8. **Acknowledgment:** the plan requires "approval text acknowledging" author-asserted steps/unknowns. Implemented as an optional closed body field `acknowledgment` (non-empty string), required when either exists, stored in the approval record. _Proposed interpretation._
9. **`procedure.author` gates `procedures:validate`** (it accepts authoring input and discloses registry facts). _Proposed._
10. **Drafts need only M1 static validity;** registry validity is required to approve. A draft with a drifted or unresolved compilation can be saved and can never be approved. _Proposed._
11. A repeated `PUT` of an existing version is `409` even when identical (the idempotent-retry semantics belong to M6).
12. The approval-binding code lives in `procedures/procedure-approval.ts` (reusing `deriveCapabilityApprovalState` unchanged) instead of extending `approval-binding.ts`, to avoid an import cycle. No existing file in `approvals/` changed.

## 4. Registry and compilation-reference integrity (authoritative sources)

All evidence comes from the workspace's own compilation registry; nothing client-supplied is trusted.

- **Compilation:** the workspace's `CompilationRecord` with `status === 'succeeded'`, its capability projections, and its persisted XOIR graph.
- **`graphHash`:** `XoirGraph.contentHash()` of that persisted graph (the same pinned value the runtime uses). No new hash algorithm. `compilationRef.graphHash` must equal it, else **`PROC_COMPILATION_DRIFT` is the only finding** (nothing derived from a drifted graph is trusted).
- **Per-step facts:** `deriveCapabilityApprovalState` (unchanged) gives contract content hash, permission-declaration fingerprint, binding id, implementation class and state digest. `declaredPermissionsForNode` decides the declaration: absent or malformed is `unresolved`, never "no permissions".
- **Fail closed:** missing, failed, unreadable, corrupt or other-workspace compilations are `PROC_COMPILATION_UNAVAILABLE`, indistinguishable from an unknown id. A missing `compilationRef` is `PROC_COMPILATION_REF_REQUIRED`. Absence is never validity.
- **Codes added** (local `PROC_*` family; `PROC_UNRESOLVED_CAPABILITY` is named in the frozen review, the rest are M2 additions): `PROC_PATH_MISMATCH`, `PROC_COMPILATION_REF_REQUIRED`, `PROC_COMPILATION_UNAVAILABLE`, `PROC_COMPILATION_DRIFT`, `PROC_UNRESOLVED_CAPABILITY`, `PROC_CONTRACT_MISMATCH`, `PROC_UNSUPPORTED_CAPABILITY_CLASS`, `PROC_PERMISSION_DECLARATION_UNRESOLVED`, `PROC_UNKNOWN_INPUT_PARAM`, `PROC_BINDING_OUTPUT_UNDECLARED`, `PROC_BINDING_TYPE_MISMATCH`, `PROC_UNBOUND_REQUIRED_INPUT`; plus existing `PROC_AI_STEP_DISABLED` for `ai_provider` capabilities.
- **Bindings and conditions:** parameters must be declared inputs of the consumer's contract; bound or referenced outputs must be declared outputs of the producer's contract; declared semantic types must agree when both are known; required inputs must be bound; decision steps produce no output; `when` cannot read step outputs.
- **Approval binding:** `{procedureId, version, procedureHash, validationReportHash, registryStateDigest, compilationId, graphHash, steps[{stepId, contractHash, permissionFingerprint, bindingId}], approverPrincipalId}`. Lifecycle is recomputed on every read: `approved` only if every recorded fact still equals the registry now. Drift gives `approval_stale`; unavailable evidence gives `approval_unverifiable`; a malformed approval gives `approval_invalid`.
- **Adapter/effect-class checks** are M4 and not claimed.

## 5. HTTP, permissions, persistence, lifecycle

| Route                                                | Permission (default deny) | Notes                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /workspaces/{id}/procedures:validate`          | `procedure.author`        | Pure; always 200 report; audit `procedure.validated` is durable BEFORE the report is released                                                          |
| `PUT /workspaces/{id}/procedures/{pid}/versions/{n}` | `procedure.author`        | Checked before the body is read; atomic put-if-absent; 201 / 409 / 400                                                                                 |
| `GET /workspaces/{id}/procedures`                    | `procedure.read`          | Computed lifecycle per version; durable `access.attempted` first                                                                                       |
| `GET /workspaces/{id}/procedures/{pid}[?version=n]`  | `procedure.read`          | Unknown, unknown version and cross-workspace are indistinguishable 404                                                                                 |
| `POST …/versions/{n}/approve`                        | `procedure.approve`       | Approver = authenticated principal only; closed body (`acknowledgment`); fresh validation; durable `procedure.attempted` before the approval is stored |

`procedure.execute` is declared, not granted by any route, and no start route exists (tested 404). Persistence: `<data>/<workspace>/procedures/<id>/v<n>/definition.json` (immutable, `putIfAbsent`) and `approval.json` (atomic replace). Every record is re-verified on read (shape, identity against its key, full M1 validation including N-10, recomputed `procedureHash`); a tampered record is never served as valid. Path ids use the M1 identifier grammar; versions are positive safe integers.

## 6. Files changed

New: `apps/api/src/procedures/{procedure,registry-validation,procedure-approval,fs-procedure-store}.ts`, `apps/api/src/routes/procedure-routes.ts`, `apps/api/test/procedure-routes.test.ts`, `P11_M2_REPORT.md`.
Modified: `apps/api/src/routes/index.ts`, `server.ts`, `http/body.ts` (`BodyTooLargeError`), `http/types.ts` (optional `rawBodyLimited`), `openapi.ts`, `workspace/workspace-context.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, `package-lock.json` (one dependency line), `packages/audit/src/event.ts` (six types + target kind), `packages/permissions/src/{domain,permission-id}.ts`, `packages/procedure/src/codes.ts` (additive codes). **No M1 test file changed** (`git diff 86c7a8f -- packages/procedure/test` is empty); no runtime source changed; `workflow-condition.ts` untouched.

## 7. Tests (22 new, `apps/api/test/procedure-routes.test.ts`)

Covers: default-deny for all five routes, no file or directory after an unauthorized author, five audited denials (N-16/A-1 and N-12 permission); permission separation; full lifecycle with computed `approved` and `executable: false`; immutability and unchanged bytes (409); strict stale-approval after a valid graph change (`approval_stale`) and `approval_unverifiable` when the compilation is deleted, with re-approval refused; workspace isolation with indistinguishable 404 (N-2); unknown capability, contract mismatch, missing ref, unavailable and cross-workspace compilation; hash drift (only the drift finding); binding, parameter, output and required-input checks; absent permission declaration (N-16); forged principal/approvedBy/humanGate/limits/effectKey and ignored headers, service-principal refusal and human success (N-9, A-1, A-3); acknowledgment rules; route cap at exactly 262,144 and 262,145 bytes (N-10) and 26 steps; no value echoed in responses or audit (N-14); path safety; tampered stored record fails closed; audit fail-closed when the durable precondition or `procedure.validated` cannot be recorded; exactly six `procedure.*` audit types with the expected events and no execution events; OpenAPI paths, no execution route; A-4 audit actor equals principal; A-5 documented limits in OpenAPI.

## 8. Local verification (Node v22.15.0, npm 10.9.7; `run-ci.sh`; logs in `evidence/m2-final/`)

| Step                           | Exit    |
| ------------------------------ | ------- |
| npm ci, typecheck              | 0, 0    |
| EI test, build, demo           | 0, 0, 0 |
| EI eslint, EI prettier         | 0, 0    |
| `npm run lint`, `format:check` | 0, 0    |
| `npm test`, `npm run build`    | 0, 0    |

**TAP totals (sum of per-package summaries):** baseline `680c5b8` 3,628; M1 final 3,662; **M2 final 3,684 tests / 3,684 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled across 32 summaries.** Arithmetic: 3,628 + 34 (M1) + 22 (M2) = 3,684. All-indent `ok` lines: 3,646 → 3,680 → 3,702 (not authoritative totals).

**By-name comparison:** against baseline `680c5b8`: 0 names vanished, 0 `ok` became `not ok`, 56 added (34 `@xo/procedure`, 22 `@xo/api`). Against the M1 final run: 0 vanished, 0 changed, 22 added, all in `@xo/api`. The M1 suite is unchanged. Failed 0, skipped 0.

**Newly run in this session:** everything above (the full sequence on the M2 tree). Earlier M1 evidence is in `P11_M1_REPORT.md`.

## 9. Evidence limitations

- Remote CI has **not** run for M1 or M2; local results are not remote evidence.
- The original `baseline-test-names.tsv` is still unavailable; the baseline name list is regenerated from a clean `680c5b8` run (corroborated by an equal all-indent `ok` count of 3,646), not byte-identical to the original.
- The run records HEAD `86c7a8f` plus an uncommitted tree; no file hashes were recorded at run time.
- The registry fixture is the existing hand-built test XOIR graph stored through the real compilation store; no compiler-produced fixture with proven multi-step data flow exists (PDF O-9 is still PENDING).
- Registry-dependent bindings are checked against capability contracts only; adapter checks are M4.
- Authoritative effect classification remains unresolved (§3 item 7). The list endpoint is unbounded by design (no owner-approved cap).

## 10. Remaining acceptance gates and open items

- **G-4 (M1 and M2):** remote CI at the phase-end gate — outstanding.
- **Independent M2 review (PDF O-4):** PENDING.
- **Owner review of the flagged items:** audit target kind `procedure`; `procedure` permission domain; the proposed interpretations in §3.
- **N-12:** the M2 portion (declared permission, default deny, no start route) passes; start-time enforcement is M3. **A-2:** M2 portion passes (registry, hash and binding staleness); adapter and effect-class digest parts are M3/M4. **A-5:** documented in OpenAPI; the M6 portion is outstanding.
- Runtime `resolvePath` hardening remains a separate, unauthorized item.

## 11. Next milestone

M3 (frozen order M0 → M1 → M2 → M3 → …). Its prerequisites per the matrix include M2 accepted and PDF O-9 approved/prepared (the fixture). Not started.
