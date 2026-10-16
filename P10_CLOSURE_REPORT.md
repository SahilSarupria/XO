# P1.0 — Closure Report

Companion to `P10_CLOSURE_BASELINE.md` (criteria, owner decisions, M1–M6 matrix, M4 gate, follow-ups). Prepared 2026-10-16 on branch `candidate/p10-closure-owner-review`.

## 1. Outcome

**P1.0 CLOSED LOCALLY — READY FOR A SEPARATE RELEASE/PUBLICATION DECISION.**

This holds because (a) final-tree validation passed on the pinned Node 22.15.0 (§4) and (b) every required acceptance record is present in the repository (§6). It is a statement about the local candidate only. Nothing has been pushed, merged, published or deployed, and no release or publication decision has been made or authorized (§8).

## 2. Provenance: recovered records versus owner-restated criteria

- **Recovered historical records:** decisions D1–D4; the frozen sequence M1 → M2 → M4 → M3 → M6 → M5 → M7 (conditional); the M7 NO-GO assessment (Project document, archived verbatim); the milestone implementation reports; commit history (`P10_CLOSURE_BASELINE.md` §1).
- **Not recovered:** the original frozen P1.0 completion checklist and the per-milestone acceptance briefs (including the original M4 gate and M5 brief). This is unchanged. The baseline is **not** a recovered specification.
- **Owner-restated criteria:** the closure baseline (common criteria C-1–C-6, per-milestone criteria, the M4 R1–R11 gate) was drafted by the implementer and **ratified by the owner on 2026-10-16** as the owner-restated baseline for this review only (O-1). Provenance labels are preserved in the baseline.
- **Not promoted:** decision-record sections B, E, F and G remain implementer-chosen details, not historically approved decisions.

## 3. Starting state (verified again at the start of this session)

Branch `candidate/p10-closure-owner-review`, HEAD `dfb849682aad08ed14da3b5948ae0665a259e505` (0 commits ahead of `origin/candidate/p10-closure-owner-review`), base `823a53e7ac1aaf7760ac889c7131fa8fd8fd75a2`, `apps/cli/bin/xo.js` mode `100755`. The working tree held only the uncommitted closure work from the previous step (no commit existed). No remote action had occurred.

## 4. Validation

### 4a. Automated checks (exact final tree, pinned toolchain)

Replayed from `.github/workflows/ci.yml` step order with a script that never aborts early and records each exit code. **Node v22.15.0** (the repository pin), npm 10.9.4. Logs (sandbox scratch, not in the repo): `…/xo-verify/ci-logs-node22150/`.

| Step                                               | Exit | Result                                                    |
| -------------------------------------------------- | ---- | --------------------------------------------------------- |
| `npm run typecheck`                                | 0    | clean                                                     |
| EI: `npm run test -w @xo/environment-intelligence` | 0    | pass                                                      |
| EI: build, then `demo` (CI-only)                   | 0, 0 | pass                                                      |
| EI: eslint `--max-warnings=0`, prettier `--check`  | 0, 0 | clean                                                     |
| `npm run lint`                                     | 0    | clean                                                     |
| `npm run format:check`                             | 0    | clean (no source file is exempted; see §5)                |
| `npm test` (31 workspaces)                         | 0    | **3628 tests, 3628 pass, 0 fail, 0 skipped, 0 cancelled** |
| `npm run build`                                    | 0    | all workspaces                                            |

The same replay on Node 22.22.0 (the sandbox default) also passed 3628/3628, all steps exit 0. The earlier baseline was 3619; the increase is 9 new tests: 4 reason-code unit tests, 1 R10 crash-window end-to-end test, 4 malformed-path regression tests.

Focused runs before the full run, all exit 0: audit/F-1/approval group (56/56), per-milestone groups in frozen order (M1 24+35+27, M2 30+29+11, M4 30+35, M3 38, M6 30+9, M5 52+8+9+12 — counts as in the baseline matrix), and the router/auth/error group after the encoding fix (75/75). A mutation check confirmed three of the four malformed-path tests fail against the original `router.ts`. One focused run exited 1 earlier only because I passed a non-existent test path; it passed 9/9 on the correct file.

**Byte-identity of the M7 archive:** SHA-256 of `claude/P10_M7_GO_NO_GO_ASSESSMENT.md` is `0f03f7f918dabce23f3a2b81753a84c1622bbbf3aad6401b1fab7cbd0f88e301`, recorded when it was created and re-checked after every later step including the final replay. It is byte-identical to the text returned by the Project tool; the source document itself cannot be diffed from this environment beyond that.

### 4b. Environment checks that could not be run

- GitHub Actions results for this candidate or for PR #4, and PR comments: not verifiable from this environment (the M2 report's open conditions remain).
- A real process kill or power loss against the audit store (R10): not simulated; the crash state is built by failing the completion append.
- Windows behaviour, network filesystems, multi-host operation: not tested and not claimed.
- Dependencies were installed earlier under Node 22.22.0 and were not reinstalled with `npm ci` under 22.15.0; the typecheck, lint, format, test and build steps all ran under 22.15.0.

## 5. Changed files (one local commit)

| File                                             | Change                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/audit/audit-service.ts`            | `safeReasonCode`: stored failure code to audit `reasonCode`; invalid shape becomes `XO_UNKNOWN`.                                                                                                                                         |
| `apps/api/src/routes/human-task-routes.ts`       | F-1: `classifyResolution`; completion event carries `reasonCode` for failed resumes; an `unsupported` resume is audited `failed` (was `completed`). No HTTP, body or state change.                                                       |
| `apps/api/src/routes/workflow-routes.ts`         | F-1: `workflow.failed` carries `reasonCode` from the stored workflow `errorCode` when present.                                                                                                                                           |
| `apps/api/src/http/router.ts`                    | M7 observation fix: a malformed percent-encoded path parameter is now HTTP 400 `INVALID_ARGUMENT` (was an unauthenticated generic 500); decoding happens only after literal segments match; offending text is never echoed.              |
| `apps/api/test/audit-reason-codes.test.ts` (new) | 4 unit tests (sanitiser; failed, unsupported, succeeded and rejected classification).                                                                                                                                                    |
| `apps/api/test/malformed-path.test.ts` (new)     | 4 regression tests (router unit, HTTP authenticated and unauthenticated, wrong-method path, auth/404/501 unchanged, encoded ids still decode).                                                                                           |
| `apps/api/test/audit-event-coverage.test.ts`     | F-1 characterization updated to the new contract; `workflow.failed` reasonCode; `humantask.denied` listed reserved/unreachable.                                                                                                          |
| `apps/api/test/approval-integrity.test.ts`       | Stale-approval resume (approve and reject): audit `failed` + `XO_RUNTIME_PERMISSION_DENIED`, no message text; success has no code.                                                                                                       |
| `apps/api/test/audit-durable-e2e.test.ts`        | R10: "started, no outcome" crash state on the real store, reconciled by correlation id against the execution record.                                                                                                                     |
| `docs/audit-operations.md`                       | Owner-accepted status; new "P1.0 owner dispositions and accepted limitations" (R7 not tamper-evident, R8–R11); F-1 reason codes; event taxonomy.                                                                                         |
| `claude/P10_M7_GO_NO_GO_ASSESSMENT.md` (new)     | Verbatim archive of the M7 assessment.                                                                                                                                                                                                   |
| `.prettierignore`                                | One exact path, `/claude/P10_M7_GO_NO_GO_ASSESSMENT.md`, so formatting cannot alter the archive. Verified it exempts nothing else: probe files in `claude/` and in a nested `apps/api/claude/` were still flagged by `prettier --check`. |
| `P10_CLOSURE_BASELINE.md` (new)                  | Ratified owner-restated baseline, owner decisions (§1a), M1–M6 matrix, M4 gate and dispositions, M7 disposition, follow-ups.                                                                                                             |
| `P10_CLOSURE_REPORT.md` (new)                    | This report.                                                                                                                                                                                                                             |

Not changed: the audit schema, the audit event-type list, the approval-gate contract, the package-trust code, any CLI code, the decision record, AI execution gating (D3), and `apps/cli/bin/xo.js` (still `100755`). The commit contains only the files above.

## 6. Implementation complete versus formally accepted

Owner decisions of 2026-10-16 (recorded in the baseline §1a). "Implementation" is what the tree and the tests show; "Acceptance" is the owner's act. Acceptances are against the ratified owner-restated criteria, with the limitations in §7, and subject to the validation in §4a, which passed.

| Milestone | Implementation (verified on the final tree)         | Formal acceptance recorded in the repo                                                                                                                                                                                    |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Complete                                            | **Accepted, owner, 2026-10-16**                                                                                                                                                                                           |
| M2        | Complete                                            | **Accepted, owner, 2026-10-16.** PR #4 is integration evidence, not the acceptance.                                                                                                                                       |
| M4        | Complete; R1–R6 evidenced; R10 test added           | **Accepted, owner, 2026-10-16**, contingent on R1–R6 evidenced (yes), R7–R11 dispositions recorded (yes), validation passing (yes)                                                                                        |
| M3        | Complete                                            | **Accepted, owner, 2026-10-16**, including the coarse `XO_RUNTIME_PERMISSION_DENIED` code; gate contract not expanded                                                                                                     |
| M6        | Complete                                            | **Accepted, owner, 2026-10-16**, including idempotency and single-process limitations                                                                                                                                     |
| M5        | Complete; `8a85c85` is an ancestor of the candidate | **Accepted / reconfirmed, owner, 2026-10-16.** The earlier 2026-10-15 acceptance existed only in project notes; this is the first repository record and is not back-dated.                                                |
| M7        | **Not implemented**                                 | **Not applicable.** Owner-approved conditional disposition: NO-GO for P1.0, hardening deferred to P1.5. It closes the P1.0 scope decision for M7, **not** the M7 implementation, which must not be reported as completed. |

## 7. Accepted limitations versus deferred implementation

**Accepted limitations (in force; not removed by acceptance).** Full lists are in the baseline §3 and §4 and in the milestone reports. The ones the owner addressed explicitly:

- **R7:** the audit log is **not tamper-evident or tamper-proof**. Anyone with write access to the audit file can alter or truncate it without detection. Stated in `docs/audit-operations.md`.
- **R8:** local CLI executions are unaudited by default; no identity or attribution model was invented.
- **R9:** retention is operator-configured with no default.
- **R10:** the crash window is detectable and reconcilable by a documented manual procedure; it is **not atomic** and there is **no automatic reconciler**.
- **R11:** local filesystem, single writer per directory; not distributed, multi-host or network-filesystem safe.
- **M3:** approval denial at human-task resume is audited under the coarse `XO_RUNTIME_PERMISSION_DENIED`.
- **M6:** in-process coordination only; not exactly-once.
- **M2:** in-process provenance boundary; no remote CI run or PR-comment check for the candidate.

**Deferred implementation work (not done in this closure):** M7 hardening (owner-scheduled for P1.5), tamper-evident audit design, finer approval-denial codes, a crash-window reconciler or outbox, a CLI attribution model, the key-migration helper, an approver role model. Details in §9.

## 8. Local commit state versus remote publication state

- **Local:** one local commit on `candidate/p10-closure-owner-review`, authorized by the owner (O-6) after validation. A commit cannot contain its own hash; the SHA is reported in the hand-off message and by `git log -1`.
- **Remote:** **no remote action occurred.** Nothing was pushed, merged, published, deployed or opened as a PR; no remote branch was modified; no history was rewritten; no destructive git operation was used.
- **Not decided:** release or publication. A separate decision is required for any push, merge, PR or publication.

## 9. Follow-up (deferred; only M7 is owner-scheduled)

1. **P1.5-1, M7 hardening (owner-approved deferral):** redesign provider configuration (operator-configured providers, endpoint allowlist) before any AI re-enable (D3); assess TLS, rate limiting, key expiry/rotation, request-size limits, CLI `--api-key` exposure.
2. Tamper-evident audit history (hash chain or signing, key custody, verification procedure); needs its own design decision.
3. Finer approval-denial reason codes at resume; needs an internal change to the M3 approval-gate signature.
4. Crash-window reconciler or outbox, if atomic or automatic recovery is required.
5. Attribution model for local CLI execution, if audited CLI runs are required.
6. Decision-record §D key-migration helper (unapproved); approver role model and separation of duties (decision record §C, undecided).
7. At release time: check GitHub Actions and PR comments, which this environment cannot reach.
