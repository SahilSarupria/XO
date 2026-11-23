# Review: UW-16b standing approvals (branch `uw-16b/standing-approvals`)

For the Opus review of ADR 0051 decisions 3 to 12. Code: `apps/api/src/approvals/standing-store.ts`, `standing-approval.ts`,
`routes/standing-approval-routes.ts`, the gating in `routes/generated-run-routes.ts`, `workflow-controls/certified-trigger.ts`.

## What to check first

1. **Only a person who signed in approves.** `approveStanding` refuses a non-human principal, an API key and a missing session; the route
   adds the review role and the 15-minute step-up. Test S1.
2. **No self-approval except the documented case.** Proposer and the person it starts as are both excluded; the only exception is
   separation off and no other reviewer, recorded as `selfApproved`. Test S2.
3. **A policy cannot be widened after approval.** The approval signs the policy digest; every start re-verifies the signature and the
   digest. Test S6 edits the stored policy and the start is refused.
4. **Each run is previewed and approved on its own.** The v3 approval is minted per run from that run's preview, expires with the policy,
   and goes through `verifyBatchForStart` and `batchCallCheck` unchanged.
5. **Pinned values.** `derivedArguments` pins every argument a write or irreversible step takes from an item or the input. Test S7.
6. **Revocation reaches a running batch.** `standingGone` is read at the effect gate before every call and in the presign hook.
7. **Audit carries ids and counts only.** Test S8. No value, recipient or digest of one.

## Things I would look at critically

- `checkBounds` runs against the preview of the run's real items. For an inline-input policy it compares the whole input, so varying
  lists need an item source (a real limit, in KNOWN_LIMITATIONS).
- `reserve`/`release` count a run in the period before the start and release it when the start fails. A crash between them can leave one
  run counted (it errs toward falling back sooner).
- The sample preview is marked `standingSample` and hidden from the Inbox; it is never approvable as a batch.
- The CLI revocation writes the same file the API reads (`revocation.json`, exclusive create). It assumes the default data folder.

## Not covered by tests

- Revocation in the middle of a running batch (the gate code is exercised, the timing is not).
- An approval refused for a stale sign-in over HTTP (the test server issues only keys).
- PostgreSQL: standing approvals are file-backed like batch approvals.
