# P1.1 — M1 Closeout Report (Procedure schema, strict parser, hash, static validation, lowering)

Updated 2026-10-18 after the owner's N-10 / schema decisions · Branch `p11/m1-procedure-validator` · Base and HEAD `680c5b8cea56c5424b10f8a7676eece5aff91dca` · **Uncommitted, unpushed** (no commit/push/PR authorization)

Companion to `P11_M0_CLOSEOUT.md` (unchanged). The four planning PDFs are external and unmodified; their PENDING decisions stay PENDING. Owner decisions O-1…O-10 (M0 closeout) and the decisions of 2026-10-18 below are the owner's **new acts**, not content of the PDFs.

## Disposition

**M1 IMPLEMENTATION COMPLETE — ACCEPTANCE BLOCKED on G-4 (remote CI) only.** Every other mandatory gate passes locally. The matrix also requires the "owner review recorded" before M2; that has not happened. Local checks are not remote CI evidence.

## 1. Owner decisions of 2026-10-18 (recorded as new acts)

1. **O-2 / N-10 limits approved:** 262,144 UTF-8 bytes raw input; nesting depth 16 with the root object counted as depth 1; 25 entries in `steps`. No other cap is approved (no node/edge/string-length cap).
2. **Local `PROC_*` codes confirmed**, including `PROC_BODY_TOO_LARGE`, `PROC_TOO_DEEP`, `PROC_TOO_MANY_STEPS`.
3. **Explicit `next` accepted** as sequence-by-edge, provided validation and lowering comply with the frozen plan.
4. **`inputs`/`outputs` blocks stay rejected in M1.** Discrepancy recorded: the Revised Plan §D example shows `inputs.schema`/`outputs.schema`, while Owner Decisions O-2 says client input may never define "schemas". M1 does not accept client-defined schemas.
5. **O-4 stands:** `compilationRef` is shape-checked in M1; hash-drift checks belong to M2.

Frozen-plan conflicts found while implementing (none blocked the work; recorded, nothing silently altered): (a) the Revised Plan example has no successor field, so a plan-shaped multi-step document needs `next` to pass M1; (b) the matrix's "valid corpus … human gate" test is superseded by O-2 (`humanGate` is a rejected authority field); (c) the matrix mentions a "node/edge/string-length cap" with no number and no approval — none implemented; (d) the matrix proposes `limits.test.ts`; the tests live in `procedure-limits.test.ts`.

## 2. Scope and files

Scope and exclusions are unchanged: no registry-dependent checks (O-4), no route/HTTP handling or route body cap (M2), no effect or human-gate semantics, no execution, persistence, audit, adapters, MCP or AI steps; M2–M6 untouched; no runtime source edited.

| File                                                                                   | Purpose                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/procedure/package.json`, `tsconfig.json`                                     | Workspace package (private, 0.1.0, Apache-2.0)                                                                                                                                     |
| `src/codes.ts`                                                                         | `PROC_*` union; `MAX_PROCEDURE_BYTES/DEPTH/STEPS` constants; forbidden-key and authority-field sets                                                                                |
| `src/parse.ts`                                                                         | Iterative strict parser; UTF-8 byte-length guard; depth and steps guards; duplicate/forbidden keys; BOM/UTF-8                                                                      |
| `src/definition.ts`, `src/validate.ts`                                                 | v1 types; closed schema; reference integrity; graph analysis; path-segment rejection                                                                                               |
| `src/canonical.ts`, `src/lower.ts`                                                     | Canonical hash; pure lowering to `WorkflowGraph`                                                                                                                                   |
| `src/index.ts`                                                                         | Public API (`validateProcedure`, `parseStrictJson`, hash, lowering, constants). `validateStructure` is no longer exported, so nothing can bypass the limits through the public API |
| `test/procedure-validation.test.ts` (19), `test/procedure-limits.test.ts` (15)         | 34 tests                                                                                                                                                                           |
| `tsconfig.json` (root, +1 line), `package-lock.json` (+17 lines, workspace entry only) | Registration                                                                                                                                                                       |
| `P11_M0_CLOSEOUT.md`, `P11_M1_REPORT.md`                                               | Records (untracked)                                                                                                                                                                |

## 3. N-10 implementation

- **Size:** `parseStrictJson` (called first by `validateProcedure`) rejects `Uint8Array` input on `byteLength` before decoding, and string input via a UTF-8 byte-length loop (surrogate pair = 4 bytes, lone surrogate = 3, matching `Buffer.byteLength`/TextEncoder) that stops at cap + 1, so work is bounded. `PROC_BODY_TOO_LARGE`, path `""`.
- **Depth:** the iterative parser rejects at the container that would be depth 17 (root container = 1; arrays count). `PROC_TOO_DEEP`, path `""`. Brackets inside strings do not count.
- **Steps:** counted when an entry starts in the array at JSON pointer `/steps` (root key, escapes decoded). Arrays elsewhere (`unknowns`, `evidence`, a nested key named `steps`, steps under an array root) are never counted. `PROC_TOO_MANY_STEPS`, path `/steps`.
- **Failure:** fail-fast and deterministic in scan order (a syntax error before the 26th entry reports `PROC_INVALID_JSON`; the 26th entry reached first reports the limit). The limit finding replaces earlier findings, uses a constant path, never echoes input, never throws.
- **Library-owned:** constants only; no options parameter (extra arguments are ignored and tested); a document-level `limits` is still a rejected authority field.
- **Compatibility:** in-contract documents are unchanged; canonical hashes and lowering are unchanged (tested at exactly 25 steps). Previously accepted documents above the limits are now rejected; no procedures are stored yet, so no migration exists. The earlier "no caps" assertions were replaced by boundary tests; extreme-input safety is retained (100,000-deep and 250,000-deep inputs return codes without overflow).
- **Boundary limitation:** the API accepts `string | Uint8Array`. Sizes of other representations (streams, pre-parsed objects) are outside M1; a route must apply its own body cap before reading (M2).

## 4. The four implementation choices

| #   | Choice                                                     | Status                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Explicit `next`; entry = unique step with no incoming edge | **OWNER-ACCEPTED (2026-10-18)**. Validated as an existing step id (`PROC_DANGLING_EDGE`), string only, rejected on decisions, cycles and ambiguous/unreachable entries rejected; lowered to one edge or to `__end`. Plan-example discrepancy recorded in §1 |
| 2   | `inputs`/`outputs` rejected as `PROC_UNKNOWN_FIELD`        | **OWNER-DECIDED (2026-10-18)**; discrepancy recorded                                                                                                                                                                                                        |
| 3   | `compilationRef` shape-checked only                        | **MANDATED by O-4**, reconfirmed                                                                                                                                                                                                                            |
| 4   | Local `PROC_*` codes                                       | **OWNER-CONFIRMED (2026-10-18)**                                                                                                                                                                                                                            |

## 5. Verification (Node v22.15.0, npm 10.9.7; runner `run-ci.sh`; logs under `evidence/`)

Final tree (HEAD `680c5b8` + the uncommitted M1 changes): `m1-final/`.

| Step (ci.yml order)            | Baseline `680c5b8` | Final M1 tree                                    |
| ------------------------------ | ------------------ | ------------------------------------------------ |
| npm ci, typecheck              | exit 0, 0          | exit 0, 0                                        |
| EI test, build, demo           | 0, 0, 0            | 0, 0, 0                                          |
| EI eslint, EI prettier         | 0, 0               | 0, 0                                             |
| `npm run lint`, `format:check` | 0, 0               | 0, 0                                             |
| `npm test`, `npm run build`    | 0, 0               | 0, 0                                             |
| Focused `@xo/procedure` (G-2)  | n/a                | 34 tests, 34 pass, 0 fail/cancelled/skipped/todo |

**TAP totals (sum of per-package summaries):** baseline 3,628 tests / 3,628 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled across 31 summaries. Final: **3,662 tests / 3,662 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled across 32 summaries**. Arithmetic: 3,628 + 34 = 3,662. All-indent `ok` lines: 3,646 + 34 = 3,680 (name lines are not authoritative totals).

**By-name comparison:** 0 baseline names vanished; 0 baseline `ok` became `not ok`; 0 new `not ok`; 0 skip/todo markers; 34 names added, all in `@xo/procedure`. **Provenance limitation:** the original `baseline-test-names.tsv` is unavailable. The baseline name list was regenerated from an isolated clean run of `680c5b8` on Node 22.15.0; its all-indent `ok` count (3,646) equals the count the PDFs report for the original file. That is corroborating evidence only; byte-for-byte identity with the original file is **not** claimed.

**Scope:** `git diff --stat`: `package-lock.json` +17 (workspace entry only), `tsconfig.json` +1; untracked: `packages/procedure/`, the two reports. No staged changes. No file under `packages/runtime` changed. No existing package source changed.

Failed: none. Skipped: none. Unrun: remote CI; checks outside `npm test`; comparison to the original TSV.

Historical (superseded) pre-N-10 run: 3,647 tests, 3,647 pass across 32 summaries (3,628 + 19), 0 vanished names, run before the limits were approved. Retained for the record.

## 6. Gate table

| Gate                           | Result        | Evidence / reason                                                                                                            |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| G-0 base, branch               | PASS          | `HEAD` = `680c5b8…`; branch `p11/m1-procedure-validator`; nothing staged                                                     |
| G-1 toolchain                  | PASS          | `env.txt`: Node v22.15.0, npm 10.9.7; no pinned-CI claim (PDF O-3 PENDING)                                                   |
| G-2 focused tests              | PASS          | 34/34 (`m1-final/00-focused-procedure.log`)                                                                                  |
| G-3 full local sequence        | PASS          | all 11 steps exit 0 (`m1-final/steps.txt`)                                                                                   |
| G-4 remote CI on the M1 commit | **BLOCKED**   | No commit exists; no push/PR authorization; the clone has no write credentials                                               |
| G-5 by-name comparison         | PASS (caveat) | 0 vanished / 0 new failures vs a regenerated baseline; original TSV unavailable                                              |
| G-6 failed/skipped/unrun       | PASS          | Reported separately in §5                                                                                                    |
| G-7 audit evidence             | N/A           | M1 adds no audit events                                                                                                      |
| G-8 controls                   | PASS          | N-1, N-4, N-5, N-6, N-10 (M1 library half), N-11 each covered by named tests. N-10's route body cap is M2 and is not claimed |
| G-9 scope                      | PASS          | §2 and §5; no M2 work, no runtime edits                                                                                      |
| G-10 stop report               | PASS          | This report; the one missing item is G-4 evidence                                                                            |

Lockfile and vanished-name stop rules: not triggered.

## 7. Security risks and unverified evidence

- **Runtime `resolvePath` (OUTSTANDING, separate hardening item):** `packages/runtime/src/workflow/workflow-condition.ts` walks `current[segment]` with no own-property check; `({})['__proto__'] !== undefined`. Not modified. The validator rejects `__proto__`/`constructor`/`prototype` as keys and as path segments at its boundary only; that is a boundary mitigation, not runtime-wide remediation. Needs separate owner authorization.
- Limits bound the library only. HTTP body size must be capped at the M2 route before reading.
- Hash covers strings as authored (no Unicode normalization).
- Still UNVERIFIED: CI #37 / Release #13 (owner-reported); frozen-reference traceability (waived, O-10); closure-report claims R7, R10, M3 limits, manual crash window; original baseline TSV.

## 8. Single next action

Owner: authorize committing `p11/m1-procedure-validator` and pushing it / opening a PR so GitHub Actions can run on the M1 commit (G-4), then record the owner review. M1 is ACCEPTED only after a green remote run.

## 9. Addendum (HISTORICAL; SUPERSEDED by the owner decisions of 2026-10-18 in §1) — N-10 contract determination, no code changed at the time

**Finding:** the frozen documents do not authorize concrete limits. Owner Decisions O-2 states the defaults "256 KiB, depth 16, ≤ 25 steps (all pending your approval)"; Revised Plan D-3 lists them as "proposed"; Review §D-3 calls the route cap "≤256 KiB proposed"; the Acceptance Matrix labels them "O-2 defaults, pending". The owner's O-5 (M0 prompt) forbids caps absent an owner-approved contract. The matrix's "node/edge/string-length cap" has no number anywhere. Therefore implementing any limit now would be an unauthorized contract change. Status: **OWNER DECISION REQUIRED**; the proposed contract is in the session response. Nothing in this report's gate table changes: G-4 BLOCKED, G-8 BLOCKED on N-10.

**Schema-choice re-audit against sources (still not decided by the owner):**

- Local `PROC_*` codes: Matrix "Proposed; needs your confirmation"; Review uses `PROC_*` names as examples. UNRESOLVED (owner confirmation).
- `next` edge: Matrix/Review require "sequence by edge" and "non-terminal has a successor"; no field is named. UNRESOLVED (proposed).
- `inputs`/`outputs` blocks: Revised Plan §D schema shows `inputs.schema`/`outputs.schema`, while Owner Decisions O-2 says client input may never define "schemas". The two conflict; rejection is the fail-closed reading. UNRESOLVED (owner must say which governs).
- `compilationRef` shape-only: consistent with O-4 and the plan (drift check = registry, M2). SUPPORTED.
