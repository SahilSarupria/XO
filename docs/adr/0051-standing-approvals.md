# 0051: Standing approvals (UW-16)

## Status

Accepted under the owner's delegation, 2026-11-23. Implements ADR 0014 point 7. Amends ADR 0045 decision 5, ADR 0046 decision 5 and
closes the two ADR 0049 follow-ups. Decisions 1 and 2 land in `uw-16a/batch-steps-and-scheduled-previews`, decisions 3 to 12 in
`uw-16b/standing-approvals`, the Studio screens in `uw-16c/studio-standing-approvals`.

## Context

- A batch approval (ADR 0046) binds exactly what a person saw, is used once and expires with its preview after 24 hours. Recurring
  work, such as a monthly certificate run from a schedule, therefore needed a person at every run, and in production a schedule of
  an effectful workflow could not start at all: it was refused for want of a batch approval.
- The batch approval decided every approval step an item reached. Every such step comes from a person's task in the source, and XO
  cannot tell an approval gate from work a person must still do, so work could be "done" by the approval (ADR 0049 follow-up).
- A schedule could not name the confirmed list its items come from (ADR 0049 follow-up).

## Decision

1. **The approver chooses which steps a batch approval decides.** The approver names them; the choice is inside the signature. Every
   other approval step waits for a person in each item. Approvals signed before this change keep deciding every step they showed.
2. **Schedules can name an item source, and a production slot prepares a preview.** A slot of a workflow that can send or change
   things, with no standing approval, prepares the batch preview as the person who set the schedule; it waits in the Inbox. One slot,
   one preview, across instances.
3. **A standing approval is a signed policy.** A person approves, once, the bounds within which runs may start without a per-batch
   approval. Each run under it still gets its own preview and its own batch approval, minted by XO from the policy and signed as the
   standing approver's decision, so every check of ADR 0046 applies at start, at each step and before each call.
4. **What it binds:** the workflow definition (and Workflow version), the certificate, each connector's binding and sending account,
   the item source or a fixed input, the allowed effects, which derived arguments are pinned to the values the approver saw and which
   may vary, the steps it also decides, limits on items per run, items and runs per period and rows left out, the triggers, the person
   runs start as, and its dates (at most 90 days).
5. **Pinned by default.** An argument a run takes from its items is pinned unless the proposer says it may vary. A step that does
   something irreversible keeps at least one pinned argument, so a standing approval never means "send anything to anyone".
6. **A sample preview is part of the proposal**, and the approver approves the policy digest they were shown.
7. **Who approves.** A person with the review role, with a recent interactive sign-in; never an API key or a service. Not the
   proposer and not the person runs start as, unless separation is turned off and nobody else may review; then it is recorded and
   shown as self-approved.
8. **Using it.** Only the named starter, through an allowed trigger. Anything outside the bounds falls back to an ordinary batch
   preview and approval; nothing is sent until a person approves it.
9. **Counting fails closed.** Two racing runs may both fall back; they never both pass a limit.
10. **Revocation is immediate.** It needs no recent sign-in. No run starts under a revoked approval, and every further call of a run
    already started under it is refused before it is sent. Operators can revoke from the machine. An unused batch approval can be
    revoked too.
11. **Changes can be requested** instead of approving.
12. **Audit** records ids, counts, reasons and booleans, never a value.

## Consequences

- Recurring work runs without a person at every run, within bounds a person approved and can revoke at any moment.
- **Behaviour change:** approval steps inside a batch are no longer decided by the batch approval unless its approver ticks them; in
  production, scheduled slots prepare previews instead of being skipped.
- A knowledge change, a binding change or a new definition still makes the certificate, and so the standing approval, unusable until
  re-issued; knowledge from other sources does not (ADR 0050).

## Implementation notes (decisions 1 and 2, `uw-16a`)

- A batch approval is signed as payload `v: 2` with `presignSteps` (sorted, unique) inside the signature. `v: 1` approvals keep their
  meaning (every step the preview showed). The approve request refuses a step no item reaches (`presign_unknown_step`) and approves nothing.
- The preview and the Inbox list the steps a person does (`stepsToApprove`: step, summary, item count).
- `ScheduleTrigger.items` is validated when set, with the same checks as a preview, and is refused with an inline `forEach` input.
- A slot's preview id is `pvw_` + the first 24 hex characters of sha256 over the definition id and the slot key, written exclusively
  (`putPreviewOnce`), so a second instance reaches the same preview. The slot records `preview prepared (pvw_…)` or
  `preview already prepared (pvw_…)`.
- The in-process scheduler runs with the same configuration as the API (adapters, certificate and approval policy). Before, it ran with
  neither, so a production slot could not have sent anything.
