# P1.0 M3 — Approval Integrity: Implementation Report

**Status: implementation complete, NOT accepted.** Built on the M4 commit (`a8b4b60`), per the frozen sequence M1 → M2 → M4 → M3.

**Provenance note.** M3 was first committed as `23d8c27` in an earlier sandbox session. That sandbox was reset before M6 began and the commit was never pushed, so it was re-created from the same design in a new session (owner-approved). The code, tests and results match the first implementation, but the commit hash differs.

## Behaviour
- **Attributed:** `approver` = snapshot of the authenticated principal (M1); body ignored; `identityId`/`approverIdentityId`/`approver.id` must agree.
- **Bound:** server-derived binding: contract content hash (incl. rules), permission-declaration fingerprint (M2), resolved binding, compilation source digest, combined state digest.
- **Enforced:** one `verifyApproval` decision at the execution route, workflow start and every step, human-task resume (approve and reject), and the capability/workflow projections.
- **Material change ⇒ stale ⇒ 403** until re-approved; unrelated capability changes do not invalidate.
- **Fail closed:** missing, legacy (pre-M3), malformed, unknown-version/field, wrong target, inconsistent attribution, underivable state.
- **Audit (M4):** `approval.attempted` (durable precondition), `approval.granted`, `approval.denied`; precise reason codes on execution denials.

## Validation (this session)
`tsc -b` exit 0. `apps/api` 271/271 (246 pre-existing + 25 new in `test/approval-integrity.test.ts`). Lint/format not run (tools unavailable; `registry.npmjs.org` is denied by the sandbox egress policy). Typecheck used global TypeScript 6.0.3, not the pinned 5.9.3.

## Limitations
1. Who may approve is still "owner of the workspace"; no approver role/permission (decisions §C).
2. No separation of duties, quorum or revocation.
3. Approvals and the stored graph are plain files: a filesystem-level attacker can forge both consistently (signing is M5's territory).
4. Pre-M3 approvals must be re-approved (deliberate).
5. A capability with an unresolved binding/declaration remains approvable; execution still refuses it.
6. CLI has no approval concept and is unchanged.
