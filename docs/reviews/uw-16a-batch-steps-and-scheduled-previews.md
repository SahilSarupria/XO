# Opus review request: `uw-16a/batch-steps-and-scheduled-previews`

## What to review

- **The step choice is inside the signature.** `BatchApprovalPayload` `v: 2` carries sorted `presignSteps`; the presigned hook in
  `runnerFor` decides a step only if it is in the set. `v: 1` approvals keep deciding every step the preview showed. Tests:
  `UW-16a: editing presignSteps in a stored approval breaks its signature…`, `…an approval signed before UW-16a still decides every step…`,
  `…presignSteps naming a step no item reaches is refused and nothing is approved`.
- **Nothing is decided by default.** An approval with no `presignSteps` leaves every person's task waiting in each item (test: `a person's task
in a batched procedure waits for a person in each item unless the approver names it`).
- **Slot previews.** `prepareSlotPreview` (generated-run-routes.ts) and the branch in `certified-trigger.ts`: a slot of an effectful
  workflow in production prepares a preview as the schedule's owner and sends nothing; the id follows from the slot and is written
  exclusively (`putPreviewOnce`). The preparer cannot approve it under separation.
- **A start that names `items`** is refused for a run that needs a batch approval and when given with `batchApprovalId`.
- **The scheduler now shares the API's data configuration** (`onDataConfig` in `server.ts`, used by `instance/start.ts`). See limits.

## Files that carry the risk

`apps/api/src/approvals/batch-approval.ts`, `apps/api/src/routes/generated-run-routes.ts` (`runnerFor` presigned hook,
`approveBatchPreview`, `prepareSlotPreview`, `startGeneratedRun`), `apps/api/src/workflow-controls/certified-trigger.ts`,
`apps/api/src/workflow-controls/scheduler.ts`, `apps/api/src/instance/start.ts`.

## Honest limits

- Before this PR the in-process scheduler's data configuration had no adapters, certificate policy or approval mode, so a production
  slot could neither send nor know that approval was required. The plan did not mention this. I passed the API's own configuration to
  the scheduler; this is the smallest change that makes the slot preview work in production. Please check it is what you want.
- The item-source path of a slot (`schedule.items`) is covered by validation tests and by the existing `inputFromSource` tests, not by a
  scheduled run over a real connected folder (the V1 flow harness is not reused here).
- A slot of an effectful workflow in development (`XO_RUN_APPROVAL=optional`) with an item source starts as before; the unit test for
  "in development a slot builds its items and runs" is not separate from the existing schedule tests.
- Studio: the batch card lists the steps and sends the ticked ones. The schedule editor's item-source picker is left to PR 7 (the plan
  keeps the Studio picker limit for PR 7).
