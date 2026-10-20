# P1.1 — M3 Report (effect-free procedure execution)

Date: 2026-10-18 · Branch `p11/m1-procedure-validator` · HEAD `e58ee14d7aba5d07114d1b702d3dbf94a35892fd` (the M2 commit) · **M3 is uncommitted** (no commit, push, PR, rebase, reset or stash)

Companion to `P11_M0_CLOSEOUT.md`, `P11_M1_REPORT.md`, `P11_M2_REPORT.md` (unchanged). The planning PDFs are external and unmodified. The pre-implementation audit that preceded this work is preserved verbatim in Appendix A and is superseded where this report says so.

## 1. Executive summary

**M3 IMPLEMENTATION COMPLETE LOCALLY — NOT ACCEPTED.** All 11 CI-order steps exit 0 and the full suite is **3,701/3,701**. Nothing here claims remote verification, M2 acceptance, or final M3 acceptance. Remote CI/G-4, the independent M2 review (PDF O-4), and the owner reviews remain **phase-end gates**.

Delivered: a persisted, restart-safe procedure execution driver (branching, value-faithful data flow, pause at a human gate, resume, per-step authorization recomputed at the moment of use), start-time input validation derived from consumer contracts, idempotent start (`start.procedure`), three routes, OpenAPI, and the seven approved audit events. Execution is **effect-free**; no M4 work was started.

## 2. Owner decisions recorded (2026-10-18; new acts, not content of the PDFs)

1. **PDF O-9 fixture — APPROVED:** the hand-built fallback for the effect-free multi-step vertical, because the compiler cannot prove the multi-step binding. All fixture evidence is labelled **hand-built**; nothing claims the compiler proved a multi-step binding; the fixture was not swapped or broadened. This is fixture approval only, **not** M2 acceptance.
2. **M3 execution audit contract — APPROVED, exactly seven types:** `procedure.execution.started`, `.waiting_for_human`, `.resumed`, `.completed`, `.failed`, `procedure.step.completed`, `procedure.step.failed`; target kinds `procedure-execution` and `procedure-step`. The M2 six are unchanged. No cancel, retry, MCP or effect types.
3. **Sequencing:** M3 may begin before M2's formal acceptance. This is not M2 acceptance and waives neither the M2 review nor remote CI/G-4.
4. **Start-time input validation:** derive validation from the consumer contracts of the `{input: …}` bindings; fail closed when a contract is absent, ambiguous, malformed or incompatible; do not invent a schema format; do not change M1's rejection of procedure-level `inputs`/`outputs`.

## 3. Frozen M3 scope and requirement-to-code-to-test traceability

Source: Revised Plan §M3 and Acceptance Matrix M3 (see Appendix A.3). **The text of AC-3, AC-4, AC-5, AC-6 and AC-8 is not in the documents available to me (frozen references, waived under O-10); every AC-based statement below is UNVERIFIED, and I did not reconstruct their text.**

| Requirement (frozen reference)                                                                  | Implementation                                                                                                                       | Test(s) in `apps/api/test/procedure-execution.test.ts`                                                                                                                                     | Result               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Graph-aware persisted driver reusing the runtime `WorkflowExecutor`, no second engine (plan M3) | `procedures/procedure-runner.ts` (`drive`, `stepGraph`); executor + `executeApprovedCapability` + `resolveHumanTaskExecution` reused | all lifecycle tests                                                                                                                                                                        | PASS                 |
| Branching with skipped steps; untaken path never executes (spy)                                 | `drive`; unreached steps marked `skipped`                                                                                            | "branch taken …", "branch not taken …" (counts step executions; `h`/`c` or `x` have no execution record)                                                                                   | PASS                 |
| Value-faithful typed data flow incl. `matched:false`                                            | `stepInputOf` (own-property reads; never defaults)                                                                                   | "branch not taken + value-faithful transfer" (consumer's recorded input has `matched === false`)                                                                                           | PASS                 |
| Pause at human gate → restart → resume                                                          | `ProcedureExecutionRecord`; `resumeProcedureExecution`                                                                               | "restart: a NEW server process over the same persisted stores resumes…" (second `TestServer` on the same data dirs)                                                                        | PASS                 |
| Double resume 409; stale revision 409; stale step execution 409                                 | `ProcedureConflictError` (reason `terminal`/`stale_revision`/`stale_step_execution`/`not_waiting`)                                   | same restart test                                                                                                                                                                          | PASS                 |
| Per-step authorization recomputed before every step                                             | `authorizeStep` (capability approval + permission gate + approved per-step state)                                                    | "N-8 / per-step authorization…" (approval removed while paused → step `c` fails `authorization`, no execution created)                                                                     | PASS                 |
| N-7: hash/registry recompute at start; N-15: edit between approve and start                     | `startProcedureExecution` step 1 (`computeLifecycle` over fresh registry read; stored record re-verified)                            | "N-7 / N-15 …" (registry change → 403 and zero records; tampered definition → ≥400, zero records)                                                                                          | PASS (see limits)    |
| Start-time input validation before persistence (owner decision 4)                               | `validateStartInput`, `schemasByContract`                                                                                            | "start-time input validation …" (valid; missing required; wrong type; undeclared key; non-object; no value echoed; zero records) and "… fails closed when the consumer contract is absent" | PASS                 |
| Authorization denied leaves zero records                                                        | start ordering: permission → body → lifecycle → per-step authorization → input → idempotency → record                                | "authorization at start …" (no grant; unapproved capability; draft procedure)                                                                                                              | PASS                 |
| Idempotent start (M6 line, per O-5)                                                             | `start.procedure` in `idempotency/idempotency.ts`; `procedure-routes.ts`                                                             | "M6 line — idempotent start …" (replay returns same execution; different payload 422; exactly one execution)                                                                               | PASS                 |
| Postcondition failure is `failed_postcondition`                                                 | `drive` evaluates `then` via the runtime `evaluateCondition`                                                                         | "postcondition failure …"                                                                                                                                                                  | PASS                 |
| Step timeout class `timeout`                                                                    | `raceTimeout`, `ProcedureRunnerContext.stepTimeoutMs`                                                                                | "step timeout …" (unit: mechanism only)                                                                                                                                                    | **PARTIAL** (see §8) |
| Crash-at-write: old-or-new record, never truncated                                              | atomic `replace` (temp + rename) + strict re-verification on read                                                                    | "crash-at-write …" (stray truncated temp file ignored; corrupt primary fails closed with 404)                                                                                              | PASS (simulated)     |
| Audit: seven approved types, two target kinds; M2 six unchanged                                 | `packages/audit/src/event.ts`; events emitted in the runner and routes                                                               | "M3 audit contract …" (exact lists); M2 suite's list test now excludes the M3 seven and still pins M2's six                                                                                | PASS                 |
| Workspace isolation                                                                             | workspace-scoped store; 404 indistinguishable                                                                                        | "workspace isolation and read …"                                                                                                                                                           | PASS                 |
| Closed bodies; authority fields rejected without echo                                           | `readClosedBody`                                                                                                                     | "closed bodies …"                                                                                                                                                                          | PASS                 |
| OpenAPI                                                                                         | `openapi.ts` (3 paths, `ProcedureExecution` schema)                                                                                  | "OpenAPI documents the M3 routes; no cancel or retry route"                                                                                                                                | PASS                 |

## 4. Implementation summary

**Routes** (all under `/workspaces/{id}`): `POST /procedures/{pid}/versions/{n}/executions` (`procedure.execute`; closed body `{input?}`; optional `Idempotency-Key`; 201, or 200 when the run failed), `GET /procedure-executions/{eid}` (`procedure.read`), `POST /procedure-executions/{eid}/resume` (`procedure.execute`; closed body `{decision, data?, expectedRevision?, expectedStepExecutionId?}`).

**Start order (fail closed, nothing persisted before the end):** workspace ownership → `procedure.execute` (default deny) → closed body (262,144-byte cap, strict parse) → durable `procedure.attempted` → lifecycle must be `approved` against a fresh registry read (N-7/N-15) → authorization of **every** step → input validation → idempotency gate → record created → run.

**Per-step execution:** fresh registry read (the procedure must still validate and match its approval digest) → capability approval verdict (existing system) + permission preflight + approved per-step state (contract hash, permission fingerprint, binding id) → inputs assembled from bindings (client input and upstream outputs; a missing producer value fails the step, it is never defaulted) → `executeApprovedCapability` → record.

**Input validation derivation (decision 4).** Guaranteed: the consumer capability's execution input schema (from `lowerCapabilitiesToManifest`, the same representation the direct-execution and workflow routes use) for parameters bound with `{input: …}`; property keys are `normalizeToFallbackKey(parameter name)`. Missing, malformed or ambiguous (fails closed with a finding): no schema for a step that has input-bound parameters (`PROC_INPUT_CONTRACT_UNAVAILABLE`); an input-bound parameter the schema does not declare (`PROC_INPUT_UNDECLARED`); required properties nothing binds (`PROC_UNBOUND_REQUIRED_INPUT`); a required input value absent (`PROC_INPUT_MISSING`); a wrong-typed value (`PROC_INPUT_INVALID`); an input key no binding references (`PROC_INPUT_UNDECLARED`). Step-bound values are checked when they exist at run time, never guessed at start. Findings carry codes and JSON pointers only. M1's rule rejecting procedure-level `inputs`/`outputs` is unchanged.

**Files changed**

| File                                             | Change                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/procedures/procedure-execution.ts` | new: record type, strict parser, `ProcedureConflictError`, `FsProcedureExecutionStore` (atomic replace, revision compare-and-set)                                     |
| `apps/api/src/procedures/procedure-runner.ts`    | new: start / resume / drive / per-step authorization / input validation                                                                                               |
| `apps/api/src/routes/procedure-routes.ts`        | start, read, resume handlers (M2 handlers unchanged)                                                                                                                  |
| `apps/api/src/procedures/registry-validation.ts` | **M2 fix found by M3:** a bound parameter is also declared when it names a property of the capability's execution input schema (see §8); `schemasByContract` exported |
| `apps/api/src/idempotency/idempotency.ts`        | `start.procedure` operation and `procedure-execution` resource kind (parse updated)                                                                                   |
| `apps/api/src/executions/execute-capability.ts`  | additive option `validateInputSchema` (default unchanged)                                                                                                             |
| `apps/api/src/workspace/workspace-context.ts`    | `workspaceProcedureExecutionsStore`                                                                                                                                   |
| `apps/api/src/openapi.ts`                        | three paths, `ProcedureExecution` schema                                                                                                                              |
| `packages/audit/src/event.ts`                    | seven event types, two target kinds                                                                                                                                   |
| `packages/procedure/src/codes.ts`                | four `PROC_INPUT_*` codes (additive)                                                                                                                                  |
| `apps/api/test/procedure-execution.test.ts`      | new: 17 tests                                                                                                                                                         |
| `apps/api/test/procedure-routes.test.ts`         | **two intentional edits to M2 tests** (see §8)                                                                                                                        |
| `P11_M3_REPORT.md`                               | this report                                                                                                                                                           |

No runtime source changed; `workflow-condition.ts` is untouched.

## 5. Security, authorization, audit, persistence, failure handling

- **Identity and authority:** only `req.principal`; no body/header/query field names an actor; `humanGate`, `limits`, `principal`, `approvedBy` etc. are rejected on every closed body (tested).
- **Default deny:** `procedure.execute` is required to start or resume; `procedure.read` to read; denials are audited (`procedure.denied`) and leave no record.
- **Defence in depth for `resolvePath`:** the runtime helper still reads `current[segment]` without an own-property check (unchanged, out of scope). Step outputs handed to conditions are rebuilt as **null-prototype objects**, so inherited names cannot appear to exist. M2's registry check already rejects any condition path naming an undeclared output. This is a mitigation at the runner boundary, **not** runtime-wide hardening, and it is not separately tested.
- **Audit:** `procedure.attempted` is a **durable precondition** (no audit, no run). The execution and step events are best-effort (`tryRecord`) and carry codes, ids and hash prefixes only. Outcomes used: `started` (execution started/resumed), `allowed` (waiting for human), `completed`, `failed`.
- **Persistence:** one record per execution, atomic replace; every read re-verifies shape, identity and workspace; a corrupt record is a 404, never served. Revision compare-and-set serializes writers inside a process.
- **Failure classes:** `authorization`, `stale_binding`, `input_invalid`, `capability_error`, `timeout`, `failed_postcondition`, `human_rejected`, `internal`.

## 6. Verification (Node v22.15.0, npm 10.9.7; `run-ci.sh`; logs in `evidence/m3/`)

| Step                           | Exit    |
| ------------------------------ | ------- |
| npm ci, typecheck              | 0, 0    |
| EI test, build, demo           | 0, 0, 0 |
| EI eslint, EI prettier         | 0, 0    |
| `npm run lint`, `format:check` | 0, 0    |
| `npm test`, `npm run build`    | 0, 0    |

**TAP totals (sum of per-package summaries):** baseline `680c5b8` 3,628; M1 final 3,662; M2 final 3,684; **M3 3,701 tests / 3,701 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled across 32 summaries.** Arithmetic: 3,684 + 17 new M3 tests = 3,701. All-indent `ok` lines: 3,646 → 3,680 → 3,702 → 3,719 (not authoritative totals).

## 7. Baseline comparison and regressions

- Against baseline `680c5b8`: 0 names vanished, 0 `ok` became `not ok`, 73 added (34 `@xo/procedure`, 39 `@xo/api`).
- Against the M2 final run: **1 name vanished — an intentional change, not a regression:** "OpenAPI documents every M2 route and no execution route exists" was retired and replaced by "OpenAPI documents every M2 route", because M3 (owner-authorized) legitimately adds execution routes. 18 names added (17 new M3 tests + that replacement). The M2 audit-list test kept its name; only its filter changed to exclude the seven approved M3 types while still pinning M2's six exactly.
- No other M1 or M2 test changed. No failing, skipped or weakened test.

## 8. Limitations, discrepancies and unresolved items

1. **M2 defect found and fixed by M3:** M2's registry check accepted a bound parameter only if it was a contract `input`, but several capabilities (for example `flowA`, `xsegA`) take their client input only through the execution input schema and declare no contract inputs, so no procedure could feed them. The fix is additive (a parameter is also declared when it names a schema property). M2 approval still does not check that every _required schema property_ is bound; that is caught at start (`PROC_UNBOUND_REQUIRED_INPUT`), so an approved procedure can be unstartable until its bindings are complete.
2. **Step timeout is only partly evidenced:** `stepTimeoutMs` is optional with **no default** (a timeout is a resource limit and no value is owner-approved, O-5) and is **not wired to server configuration**. The mechanism is unit-tested (`raceTimeout`); an end-to-end timeout through HTTP was not tested, and the in-flight call is not cancelled (cancel-in-flight is out of scope). **Owner decision needed:** a default and its configuration surface.
3. **All input-bound parameters of all steps are required at start,** including steps on a branch that may not run.
4. **N-15 race:** the edit-between-approve-and-start case is tested; a true concurrent start-time race is not (the compare-and-set serializes writers in one process only).
5. **Crash-at-write is simulated** (stray truncated temp file, corrupt primary), not a real process kill.
6. **Audit detail events are best-effort;** only `procedure.attempted` is durable.
7. **Capability approvals are required per step** through the existing approval system (the frozen text I have says "per-step authz"; I applied the same gate the workflow runner uses).
8. **Hand-built fixture only (decision 1):** the compiler did not prove any multi-step binding here; the outputs of the standard resolvers remain `matched`/`outcome` (the honest limit in the frozen plan: typed data flow beyond those exists only through capabilities with declared output schemas).
9. **AC-3/4/5/6/8 definitions unavailable** (UNVERIFIED traceability, O-10).
10. The original `baseline-test-names.tsv` is still unavailable; the baseline name list is regenerated from a clean `680c5b8` run (corroborated by an equal all-indent `ok` count of 3,646) and is not claimed byte-identical.
11. The run records HEAD `e58ee14` plus an uncommitted tree; no file hashes were recorded at run time.
12. Runtime `resolvePath` hardening remains a separate, unauthorized item.

## 9. Implementation completion versus formal acceptance

M3 is implementation-complete locally and **not accepted**. Outstanding phase-end gates: remote CI/G-4 for M1, M2 and M3; the independent M2 review (PDF O-4); the owner review of the flagged M2 and M3 items (audit target kinds, permission domain, proposed interpretations, the M2 registry fix, the retired M2 assertion); and M3 acceptance itself.

## 10. Next milestone prerequisites (M4; not started)

Per the matrix: M3 accepted; PDF O-7 approved with the enumerated affected-file list; PDF O-1 decided for effect claims.

---

# Appendix A — Pre-implementation audit (historical; superseded by §§1–9 where they differ)

### A.1 Executive summary (as written before the owner decisions)

**M3 IMPLEMENTATION NOT STARTED — BLOCKED ON TWO UNRECORDED OWNER DECISIONS.** No source, test or frozen document was changed in this audit, and nothing was committed. The scope audit, dependency analysis and implementation plan below are complete.

Two prerequisites genuinely prevent safe, compliant M3 code:

1. **PDF O-9 (synthetic procedure fixture) is PENDING with no owner response.** The M3 acceptance tests need it, and the frozen plan names it as an M3 prerequisite.
2. **No audit event types exist for execution.** The owner approved only the six M2 `procedure.*` types and explicitly deferred execution-detail and step-level types "to the milestones that implement those behaviors". M3 needs them, and the frozen M2 stop rule forbids any type outside an approved list. The PDF's execution-event list is still a DRAFT with owner response "—".

M2's formal acceptance is not recorded either. That is the expected phase-end activity (independent review and remote CI/G-4 are deferred by policy), not a technical defect; M2 is technically complete. I did not conduct the deferred review, and I did not treat M2 as accepted.

### A.2. Prerequisite table

| Prerequisite                 | Required evidence                                  | Status                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2 implementation            | Current source and M2 report                       | **VERIFIED present:** `apps/api/src/procedures/*`, `routes/procedure-routes.ts`, `P11_M2_REPORT.md` at `e58ee14`; clean tree                                                                                                                                                                                             |
| M2 local verification        | Final logs/report                                  | **VERIFIED (prior run) + spot-checked now.** M2 report: 11/11 CI-order steps exit 0, 3,684/3,684 tests. Re-run today on this checkout: root `tsc -b` exit 0; `procedure-routes` 22/22; `@xo/procedure` 34/34. The full 3,684 suite was not re-run; the checkout is byte-identical to the tested tree as far as git shows |
| M2 formal acceptance         | Authoritative acceptance record                    | **PENDING** (none recorded). Gates deferred by policy: remote CI/G-4 for M1 and M2, independent M2 review (PDF O-4), owner review of the flagged M2 items                                                                                                                                                                |
| O-9 fixture decision         | Explicit owner approval in an authoritative record | **NOT APPROVED.** Owner Decisions, "O-9 — Synthetic procedure fixture": _"Approval status: PENDING · Owner response: —"_                                                                                                                                                                                                 |
| M3 audit types for execution | Owner-approved list                                | **NOT APPROVED.** Only the six M2 types are approved; the PDF's `procedure.execution.*` / `procedure.step.*` rows are DRAFT, status PENDING, _"Blocks: M2 (and M3/M4 for their subsets)"_                                                                                                                                |
| M3 scope                     | Frozen plan and acceptance criteria                | **VERIFIED from the Revised Plan §M3 and Acceptance Matrix M3**; AC-3/4/5/6/8 text is **UNVERIFIED** (see §3)                                                                                                                                                                                                            |

**O-9 evidence and the numbering trap.** The decision text reads: _"Prepare a synthetic source document stating (a) a threshold rule, (b) a human-review step above the threshold, (c) a settlement step below it, with explicit ordering and data hand-off; compile it for real. Any hand-built XOIR fixture is labelled FALLBACK / hand-built. Anything the compiler does not prove is stored author_asserted with unknowns; it is never presented as compiler-proven."_ It _"Blocks: M3 acceptance (not M1/M2…)"_. The owner's M0 prompt also used the label "O-9", but for a different topic (superseded proposals and supersession markers). That is not an approval of the fixture. No other record approves it. The existence of the hand-built P0.8 fixture (`apps/api/test/workflow-fixtures.ts`) is not an approval either, and I did not substitute it.

A wording discrepancy exists in the frozen documents: the matrix says M3 "Prereqs: M2 accepted; O-9 approved/prepared", while the PDF says O-9 blocks M3 _acceptance_. I did not resolve this; I treated the stricter reading as binding for fixture-dependent work.

### A.3. Exact frozen M3 scope

Source: Revised Plan §M3; Acceptance Matrix M3, N-controls.

- **Title:** "Deterministic execution, branching, typed data flow, pause/resume, idempotent start" (matrix: "…restart/resume, per-step authz, idempotency").
- **Outcome:** the effect-free vertical runs over HTTP, pauses at the human gate, survives restart, resumes.
- **Code areas:** new `apps/api/src/procedures/procedure-runner.ts` (graph-aware persisted driver reusing `makeCapabilityAuthorityNodeHandler`, `WorkflowExecutor` and atomic stores; no second engine); `apps/api/src/idempotency/idempotency.ts` extended with `start.procedure` (the M6 idempotency line only, per owner O-5); a resume route; `ProcedureExecutionRecord`.
- **Runtime prerequisites:** none beyond existing R1–R6 (verify only). The only runtime delta is in M4.
- **Tests:** N-7 (hash recompute at start), N-8 (per-step digest after a capability rule change), N-15 (start-time recompute race); branch taken/not taken with skipped steps and spy counters on the untaken path; value-faithful producer→consumer transfer including `matched:false`; pause → restart (new runner over the same store) → resume; double resume 409; stale revision 409; authorization re-checked before every step; start-time input validation before any persistence; same Idempotency-Key replays and a different payload is 422; step timeout fails with class `timeout`; postcondition failure is `failed_postcondition`.
- **Negative controls:** authorization denied leaves zero records; approval revoked while waiting makes the later step fail closed (mirrors the workflows test at L1087); a predicate-style condition cannot be persisted.
- **Acceptance:** AC-3, AC-4, AC-5, AC-6 (human gate), AC-8; exit: a crash-at-write test shows the old or the new record, never a truncated one.
- **Non-goals:** effects, MCP, cancel-in-flight, retries of steps.
- **Honest limit (must appear in the final M3 report):** typed data flow beyond `matched`/`outcome` exists only through capabilities with declared output schemas.
- **Traceability limit:** the AC-n definitions live in documents not available to me (frozen references, waived under O-10). Every AC-based claim is UNVERIFIED.

### A.4. Dependency analysis (from the current code)

1. **The existing app-level workflow runner is linear.** `apps/api/src/workflows/workflow-runner.ts` (982 lines) and `workflow-transitions.ts` persist an ordered `steps[]` with `firstRunnableStepIndex`; there is no branching. The frozen plan therefore points M3 at the runtime `WorkflowExecutor` (graph, decision edges, checkpoint/resume) with a new persisted driver, not at extending the linear runner. This is the largest design item and must not be underestimated.
2. **Reusable as-is:** M1 `lowerToWorkflowGraph` (decisions lowered to an expression edge plus an unconditional fallback; `steps.<id>.output.<rest>` lowered to `<id>.<rest>`); the runtime executor's `run`/`resume` and `CheckpointStore`; the M2 `computeLifecycle` and `validateAgainstRegistry` (start-time recompute for N-7/N-8/N-15); the existing capability authorization and approval derivation (`deriveCapabilityApprovalState`); the M2 stores and atomic `putIfAbsent`/`replace` patterns; the idempotency gate (`IdempotencyGate`), whose operation union currently has only `execute.capability` and `start.workflow`.
3. **Needs a design decision inside M3:** start-time input validation. M1 rejects `inputs`/`outputs` blocks (owner decision), so input names exist only as `{input: …}` bindings and their types only as the consumer contract's declared semantic types. The plan's "start-time input validation before any persistence" must be derived from those, and the plan does not say how. This is a gap I would document, not guess.
4. **Known risk carried from M1:** `resolvePath` in `packages/runtime/src/workflow/workflow-condition.ts` has no own-property check. The runner would execute decision conditions through it. The M1 validator blocks `__proto__`/`constructor`/`prototype` at its boundary, so persisted procedures cannot carry them, but runtime-wide hardening is still unauthorized and outside M3. M3 must keep refusing any procedure that did not pass the validator.
5. **Idempotency scope:** `start.procedure` is a new `IdempotentOperation` and resource kind; `parseIdempotencyRecord` currently rejects unknown operations, so persisted records need a compatible extension.
6. **Audit:** execution coverage needs new event types and target kinds (§1 item 2). Without them M3 could emit only `procedure.attempted` and `procedure.denied`, which would not give execution audit coverage.

### A.5. Implementation plan (not started; for the unblocked path)

| Requirement                                                    | Planned files                                                                                                               | Planned tests                                                          | Status                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Graph-aware persisted driver, no second engine                 | `procedures/procedure-runner.ts`, `procedures/procedure-execution.ts` (`ProcedureExecutionRecord`, revision-checked stores) | pause → new runner over same store → resume; crash-at-write old-or-new | BLOCKED (O-9, audit types, M2 acceptance)      |
| Branching and value-faithful data flow                         | runner + M1 lowering                                                                                                        | spy counters on the untaken path; `matched:false` transfer             | BLOCKED                                        |
| Start-time recompute (N-7/N-8/N-15), per-step authz            | `procedure-approval.ts` (reuse), runner                                                                                     | swap step, change capability rule, edit-between-approve-and-start      | BLOCKED                                        |
| Start route, resume route, input validation before persistence | `routes/procedure-routes.ts` + OpenAPI                                                                                      | zero records on denial; double resume 409; stale revision 409          | BLOCKED                                        |
| Idempotent start (`start.procedure`)                           | `idempotency/idempotency.ts`, `idempotency-http.ts`                                                                         | replay; payload mismatch 422                                           | BLOCKED (owner O-5 approved the approach)      |
| Timeout and postcondition classes                              | runner                                                                                                                      | `timeout`; `failed_postcondition`                                      | BLOCKED                                        |
| Execution audit                                                | `packages/audit/src/event.ts` (new types and target kinds)                                                                  | audit coverage including denials                                       | **BLOCKED — needs owner approval of the list** |
| Fixture                                                        | synthetic source compiled for real, or labelled FALLBACK                                                                    | N-7/N-8/N-15 and the vertical                                          | **BLOCKED — O-9**                              |

### A.6. Verification performed in this audit

Node v22.15.0, npm 10.9.7. `git status --short`: 0 changes. `npx tsc -b tsconfig.json`: exit 0. `node --import tsx --test test/procedure-routes.test.ts` (apps/api): 22 tests, 22 pass. `npm test` in `packages/procedure`: 34 tests, 34 pass. **Not run:** the full suite, remote CI, any M3 check (no M3 code exists). No baseline comparison was needed because no code changed.

### A.7. Owner decisions required (one list)

1. **PDF O-9 — fixture.** Recommended: approve as written (compile a synthetic threshold → human review → settlement source for real; any hand-built graph is labelled FALLBACK/hand-built; unproven parts stored `author_asserted` with unknowns). The compiler cannot prove a multi-step binding today (per the P0.8 fixture header), so expect the FALLBACK path to be used, labelled. If declined, M3 acceptance cannot be evidenced.
2. **M3 audit subset (extension of O-6).** Recommended: approve a trimmed subset of the draft's execution rows for M3 only: `procedure.execution.started`, `.waiting_for_human`, `.resumed`, `.completed` and `.failed` (dropping `.cancelled`, since cancel-in-flight is a non-goal), plus `procedure.step.completed` and `procedure.step.failed`, with new target kinds `procedure-execution` and `procedure-step`. Leave `procedure.effect.*` for M4. This list is my trim of the PDF draft, not an approved list.
3. **Order of work.** Confirm that fixture-dependent M3 work may begin before M2's formal phase-end acceptance (the matrix lists "M2 accepted" as a prerequisite). Recommended: yes, since you directed that reviews are deferred to the phase end; this records it as an owner-sanctioned deviation, not a waiver of M2 acceptance.
4. **Start-time input validation source.** Recommended: derive required input names and semantic types from the consumer contracts of the `{input: …}` bindings, and state this in the report as the M3 interpretation (since `inputs` blocks stay rejected).

### A.8. Separation of implementation completion from formal acceptance

M2 is implementation-complete locally and not formally accepted. M3 is not implemented. Remote CI/G-4 for M1 and M2, the independent M2 review and the owner review remain phase-end gates and have not run. Nothing in this report claims remote verification.

### A.9. Next milestone prerequisites (M4; not started)

Per the matrix: M3 accepted; PDF O-7 approved with the enumerated affected-file list; PDF O-1 decided for effect claims. Not started.
