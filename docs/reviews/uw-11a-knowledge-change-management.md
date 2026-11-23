# Opus review request: `uw-11a/knowledge-change-management`

## What to review

- **Dependency-scoped certificates (readiness policy v3).** A certificate must go stale when a record citing its sources changes,
  when a conflict opens on one, or when a pack changes; it must not go stale for anything else. Tests: `UW-11a: a v3 certificate stays
current when knowledge from other sources is approved`, `UW-11a: a v3 certificate goes stale when a record citing its sources
changes…`, `UW-11a: a v2 certificate keeps the whole-state rule`, `UW-11a: the dependency root changes only when a record citing
the given sources changes`.
- **Fail-closed rules.** A v3 certificate without a root is refused (`the knowledge drawn from its sources cannot be checked`). A
  certificate is issued under v3 only when the caller passes `knowledgeDependencyRoot`.
- **Validators** that block approval: `authority-escalation`, `dependency`, `restore-outside-rollback`, rollback target. Test:
  `UAC-21: every known-bad change set is blocked with its expected finding` (12 cases).
- **Separation of duties** on rollback and run-outcome change sets: `UW-11a: a rollback is proposed by an author and cannot be approved
by its proposer when separation is required`.

## Files that carry the risk

`packages/knowledge-base/src/knowledge-base.ts` (`dependencyRootOf`, `proposeRollback`, `validateChangeManagement`, `previewApproval`),
`packages/pre-execution/src/readiness.ts` (`verifyReadinessCertificate`), `apps/api/src/pre-execution/context.ts`,
`apps/api/src/routes/knowledge-routes.ts` (`decide`, `affectedCertificates`).

## Honest limits

- The `dependency` validator applies only to retiring an entity an active record points at; superseding a record is not blocked
  (an existing test supersedes a claim a relationship points at). The plan said retire/supersede/merge.
- The `affects-certified-workflows` warning on a proposal states how many certified workflows exist; the exact affected list is on the
  preview route, because it needs the state approval would create.
- A change set that resolves a conflict previews with a different digest than the state it creates (the resolution time differs).
- The PostgreSQL conformance suite was not run (no server in the session).
- The dependency root reads every record of the state once (cached by record digest); large states will pay that on each readiness read.
