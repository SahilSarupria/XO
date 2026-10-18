# P1.1 — M0 Closeout and M1 Start Record

Date: 2026-10-17 · Base: `680c5b8cea56c5424b10f8a7676eece5aff91dca` (PR #5 merge) · Branch: `p11/m1-procedure-validator` (uncommitted)

This record **adds** to, and does not replace, the four external planning PDFs (P11 OWNER DECISIONS, ACCEPTANCE MATRIX, REVISED PLAN, PRE IMPLEMENTATION REVIEW). The PDFs are not copied into the repo; their historical statuses (every O-n "PENDING") are unchanged and remain true _of those documents_. Owner decisions below were given **after** the PDFs, in the owner's M0 prompts of 2026-10-17, and are recorded here as new acts, not as approvals the PDFs already contained.

Evidence tags: VERIFIED (read/ran in this session) · OWNER-REPORTED · UNVERIFIED · UNAVAILABLE.

## 1. Numbering reconciliation (contradiction surfaced, history not rewritten)

The owner's prompt uses O-1…O-10 with topics that differ from the PDF's O-1…O-10 for five numbers. Both are kept; the owner's wording governs the topic it states (authority order #1).

| #    | PDF topic (historical status PENDING)                               | Owner-prompt topic (explicit instruction 2026-10-17)       |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| O-1  | Approval independence                                               | Single-owner approval model — consistent                   |
| O-2  | Procedure trust boundary (+ proposed 256 KiB / depth 16 / 25 steps) | Strict server-authoritative contract; **no client limits** |
| O-3  | CI Node pin (`.nvmrc`)                                              | Six-state effect model                                     |
| O-4  | Independent M2 review                                               | Registry-dependent checks stay in M2                       |
| O-5  | Identity/idempotency lines (Studio exclusion)                       | No unsupported limits                                      |
| O-6  | Audit event taxonomy                                                | Evidence and test claims                                   |
| O-7  | `external_tool` union change                                        | Same topic; PRELIMINARY / UNVERIFIED                       |
| O-8  | MCP SDK                                                             | Same topic; dated snapshot only                            |
| O-9  | Synthetic fixture                                                   | Superseded proposals / supersession markers                |
| O-10 | Frozen references                                                   | Same topic; proceed, mark UNVERIFIED                       |

**Effect on the PDF's original O-3 (CI pin), O-4 (independent review), O-5 (Studio exclusion), O-6 (audit taxonomy), O-9 (fixture):** the owner prompt did not decide these. They stay **PENDING** for their own milestones (per the PDFs: pinned-CI claims; closure language; M2/M3; M2; M3). None blocks M1 code. No approval is inferred for them.

**Contradiction to note:** the Acceptance Matrix lists 256 KiB / depth 16 / 25 steps (+ node/edge/string caps) as "O-2 defaults, pending". The owner's O-2 (reject client limits; limits server-controlled) and O-5 (no unsupported caps) mean those numbers are **not approved**. M1 therefore enforces none of them.

## 2. Owner responses (exact wording from the owner's prompt)

- O-1: "Approve the single-owner workspace model. The starter and approver may be the same principal. Do not introduce a configurable or default-on approver != starter rule…" _(supersedes the Revised Plan D.3 "checked, configurable rule approver ≠ starter … default on")_
- O-2: "Approve a strict server-authoritative procedure contract. … Reject client-supplied limits; limits are server-controlled. Do not expose client effectKey … Reject unknown authority-bearing fields, including humanGate; responsibility is not an accepted field … effectIntent may be accepted only as advisory intent in the allowed read | write form, with escalation-only semantics."
- O-3: "Approve the six-state effect model specified by the corrected acceptance matrix and review. … This recovery behavior is not implemented in M1." _(States: intent_recorded, dispatch_attempted, confirmed_success, confirmed_failure_no_effect, outcome_unknown, reconciliation_required — Review §5.3.)_
- O-4: "Keep registry-dependent checks in M2. … M1 should implement locally verifiable definition validation and reference integrity only."
- O-5: "Do not add arbitrary node-count, edge-count, or string-length caps absent from the owner-approved contract."
- O-6: "Never turn a reported claim into a verified claim merely by copying it into a new document."
- O-7: "Keep O-7 PRELIMINARY / UNVERIFIED until the required pre-M4 enumeration is produced and reviewed."
- O-8: "Treat the reported SDK version, dependency versions, and package count as a snapshot dated 2026-10-17, not as an approved selection."
- O-9: "Keep historical text intact with explicit supersession markers."
- O-10: "Proceed without complete traceability to unavailable frozen references … mark all claims that depend on unavailable references as UNVERIFIED." _(PDF status was PENDING; reconciled: owner chose the "authorize proceeding without traceability" option.)_

## 3. M0 exit gate (Acceptance Matrix §B M0 + M1 prerequisites)

| Criterion                                                               | Status                                                                                 | Evidence                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline commit/tree is the approved base; tree clean; dedicated branch | VERIFIED                                                                               | `git rev-parse HEAD` = 680c5b8…; `git status` clean before work; branch created off it                                                                     |
| Local full suite 3628/3628 on Node 22.15.0                              | **PDF-REPORTED (VERIFIED by the PDF author, single sandbox run); NOT reproduced here** | Logs (`m0-baseline-680c5b8/`, hashes a5ed44a8…, d494e827…) are not available to this session. TAP summary (3628) is authoritative, not the 3646 `ok` lines |
| Remote CI #37 / Release #13                                             | OWNER-REPORTED, NOT VERIFIED                                                           | —                                                                                                                                                          |
| Frozen references (5)                                                   | UNAVAILABLE → waived by O-10                                                           | Traceability claims UNVERIFIED                                                                                                                             |
| Independent M2 review                                                   | UNAVAILABLE; blocks no code milestone                                                  | PDF O-4 stays PENDING                                                                                                                                      |
| M1 prereq: O-2 approved (parse rules; limits)                           | OWNER-APPROVED (parse rules); limits: none approved                                    | §1, §2                                                                                                                                                     |
| M1 prereq: O-10 resolved or waived                                      | OWNER-APPROVED (waived)                                                                | §2                                                                                                                                                         |
| M1 prereq: O-3(CI) before any "pinned CI" claim                         | PENDING — **no pinned-CI claim is made**                                               | CI uses floating `22.x` (PDF-reported, VERIFIED there)                                                                                                     |
| G-5 by-name baseline diff                                               | **PENDING** — baseline name list unavailable                                           | Required at M1 **acceptance**, not at M1 start                                                                                                             |

**M0 disposition: CLOSED for the purpose of starting M1.** No mandatory M1-start gate is unsatisfied. M1 **acceptance** remains blocked on G-4 (remote CI, needs a branch/PR authorization) and G-5 (by-name baseline comparison; needs the baseline TSV or a fresh Node 22.15.0 baseline run of 680c5b8).

## 4. Runtime prototype-chain issue (separate, OUTSTANDING)

`packages/runtime/src/workflow/workflow-condition.ts` `resolvePath` walks `current[segment]` with no own-property check (VERIFIED by reading it; `({})['__proto__'] !== undefined` is true on Node). **Not modified. Not fixed.** The M1 procedure validator rejects `__proto__`, `constructor`, `prototype` as keys (anywhere in a document) and as path segments (conditions, `when`/`then`, bindings). This is a **boundary mitigation only**, not runtime-wide hardening. Runtime-wide hardening requires a separate owner authorization and does not touch frozen R1–R6 scope.

## 5. M1 scope delivered (packages/procedure) and explicit limits of it

Implemented: strict iterative raw-text parser (duplicate keys, forbidden keys, BOM/invalid UTF-8, no recursion); closed schema with authority-field rejection; node allowlist (`capability`, `decision`); AI-class kinds rejected (`PROC_AI_STEP_DISABLED`); local reference integrity (step ids, edges, bindings, condition paths, upstream-ness); graph analysis (cycle, unreachable, ambiguous entry); canonical hash; in-memory lowering to `WorkflowGraph`.

Schema decisions made by the implementer, **not** owner-approved, reviewable: (a) sequence edges are explicit `next` (absent = terminal) and the entry is the unique step with no incoming edge; (b) `inputs`/`outputs` JSON-schema blocks are not accepted in M1 (rejected as unknown fields); (c) `compilationRef` is shape-checked only; (d) local `PROC_*` codes, not added to `@xo/errors`.

Not done (by owner decision): any numeric limit; registry resolution, contract-hash drift, capability existence, output-declared-by-contract checks (M2); human-gate or effect semantics (server-resolved binding, later); effect recovery; persistence/HTTP/audit/execution; M2–M6.

Lowering note: `input.*` paths are kept as-is; seeding `outputs.input` is an M3 concern and is not claimed.

Build-order note (pre-existing, unchanged): `@xo/runtime`'s tsconfig has no reference to `@xo/ai-core`, so `tsc -b packages/procedure` alone fails on a cold tree; the root `tsc -b tsconfig.json` (the CI typecheck) builds in the right order.

## 6. Supersession note (added 2026-10-18; historical text above is unchanged)

Parts of §5 describe the state on 2026-10-17 and are **superseded in part** by the owner decisions of 2026-10-18 recorded in `P11_M1_REPORT.md` §1:

- "Not done (by owner decision): any numeric limit" — the owner has since approved the N-10 limits (262,144 UTF-8 bytes; nesting depth 16, root counted as depth 1; at most 25 `steps` entries). No other cap is approved.
- The schema decisions listed in §5 as "implementer … not owner-approved" have since been decided: explicit `next` accepted, local `PROC_*` codes confirmed, `inputs`/`outputs` blocks kept rejected in M1, `compilationRef` shape-checked only (O-4).

The 2026-10-17 owner decisions O-1…O-10 (§2) and the numbering reconciliation (§1) are unchanged. See `P11_M1_REPORT.md` for current gate status; M1 is not yet accepted.
